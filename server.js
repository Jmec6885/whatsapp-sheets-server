const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCodeImage = require('qrcode');
const axios = require('axios'); // Librería para responderle a Google Sheets

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let sock;
let currentQrCode = null;
let isConnected = false;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            currentQrCode = await QRCodeImage.toDataURL(qr);
            console.log('=== NUEVO CÓDIGO QR GENERADO ===');
        }
        
        if (connection === 'close') {
            isConnected = false;
            currentQrCode = null;
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            isConnected = true;
            currentQrCode = null;
            console.log('=== CONEXIÓN EXITOSA CON WHATSAPP ===');
        }
    });
}

// Pantalla principal para ver el QR o el éxito
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (isConnected) {
        return res.send('<h1 style="color: green; font-family: Arial; text-align: center; margin-top: 50px;">=== ¡CONEXIÓN EXITOSA CON WHATSAPP DISPONIBLE! ===</h1>');
    }
    if (currentQrCode) {
        return res.send(`
            <div style="font-family: Arial; text-align: center; margin-top: 50px;">
                <h1>Escanea este código QR con tu WhatsApp</h1>
                <img src="${currentQrCode}" style="border: 2px solid #000; padding: 10px; width: 300px; height: 300px;" />
                <script>setTimeout(() => { location.reload(); }, 20000);</script>
            </div>
        `);
    }
    return res.send('<h1 style="font-family: Arial; text-align: center; margin-top: 50px;">Generando código QR...</h1>');
});

// Procesador exacto para el "registermessage" de tu plantilla
app.post('/send-message', async (req, res) => {
    console.log('Datos recibidos desde la Hoja:', JSON.stringify(req.body));

    const { op, mensajes, app_script } = req.body;

    // Validamos que vengan mensajes en la cola masiva
    if (op === 'registermessage' && mensajes && mensajes.length > 0) {
        
        if (!sock || !isConnected) {
            return res.status(500).json({ status: '-1', message: 'WhatsApp desvinculado' });
        }

        // Enviamos un éxito inicial a la hoja para liberar el proceso
        res.json({ status: '0', message: 'Procesando mensajes en segundo plano...' });

        let respuestasParaGoogle = [];

        // Recorremos meticulosamente cada mensaje enviado por tu bucle arrayNumero
        for (let msg of mensajes) {
            try {
                const numeroLimpio = `${String(msg.numero).replace(/[^0-9]/g, '')}@s.whatsapp.net`;
                
                // Ejecutamos el envío real de WhatsApp dependiente de Baileys
                await sock.sendMessage(numeroLimpio, { text: msg.mensaje });
                console.log(`Mensaje enviado a la posición ${msg.posicion}: ${msg.numero}`);

                // Estructuramos la respuesta idéntica a como la lee tu función resultado(resultado) en Sheets
                respuestasParaGoogle.push({
                    posicion: msg.posicion,
                    estado: 'Enviado'
                });
            } catch (err) {
                console.error(`Error enviando a ${msg.numero}:`, err);
                respuestasParaGoogle.push({
                    posicion: msg.posicion,
                    estado: 'Error'
                });
            }
            
            // Pausa pequeña para simular el intervalo_mensaje y evitar baneos de WhatsApp
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        // Definimos la URL de destino usando la que viene de la hoja o la tuya fija como respaldo directo
        const urlDestino = app_script || "https://script.google.com/macros/s/AKfycbxKS3U9uxfXVfI9QntD00b_HYa1Me91HktweJZSExpOGTtp7rf-McKXnY4oRWjOVTga/exec";
        
        if (urlDestino) {
            try {
                await axios.post(urlDestino, {
                    v: 'resultado', // Activa el caso correspondiente en tu WebApp de Google
                    mensajes: respuestasParaGoogle
                });
                console.log('Estados devueltos a Google Sheets con éxito');
            } catch (googleErr) {
                console.error('No se pudo actualizar la columna D en Google Sheets:', googleErr.message);
            }
        }

    } else {
        // Soporte secundario por si acaso mandas una prueba individual simple
        const number = req.body.number || req.body.numero;
        const message = req.body.message || req.body.texto;

        if (!number || !message) {
            return res.status(400).json({ status: '-1', message: 'Estructura desconocida' });
        }

        try {
            const formattedNumber = `${String(number).replace(/[^0-9]/g, '')}@s.whatsapp.net`;
            await sock.sendMessage(formattedNumber, { text: message });
            return res.json({ status: '0', message: 'Enviado individual exitoso' });
        } catch (error) {
            return res.status(500).json({ status: '-1', message: error.toString() });
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor activo en puerto ${PORT}`);
    connectToWhatsApp();
});
