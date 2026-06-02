const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCodeImage = require('qrcode');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let sock = null;
let currentQrCode = null;
let isConnected = false;
let initTimeout = null;

async function connectToWhatsApp() {
    console.log('Iniciando ciclo de conexión con Baileys...');
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');
        const { version } = await fetchLatestBaileysVersion();
        
        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            defaultQueryTimeoutMs: undefined,
            connectTimeoutMs: 60000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                // Si llega el código QR, limpiamos cualquier temporizador de error
                if (initTimeout) clearTimeout(initTimeout);
                currentQrCode = await QRCodeImage.toDataURL(qr);
                console.log('=== NUEVO CÓDIGO QR GENERADO CON ÉXITO ===');
            }
            
            if (connection === 'close') {
                isConnected = false;
                currentQrCode = null;
                const statusCode = lastDisconnect.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`Conexión cerrada (Código: ${statusCode}). Reconectando: ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    setTimeout(connectToWhatsApp, 5000); // Espera 5 segundos antes de reintentar
                }
            } else if (connection === 'open') {
                if (initTimeout) clearTimeout(initTimeout);
                isConnected = true;
                currentQrCode = null;
                console.log('=== CONEXIÓN EXITOSA ESTABLECIDA CON WHATSAPP ===');
            }
        });

        // Mecanismo de emergencia: Si en 45 segundos Baileys no genera QR ni conecta, reiniciamos el bucle
        if (initTimeout) clearTimeout(initTimeout);
        initTimeout = setTimeout(() => {
            if (!isConnected && !currentQrCode) {
                console.log('Detectada inactividad en el arranque. Forzando reinicio de Baileys...');
                try { sock.logout(); } catch(e){}
                connectToWhatsApp();
            }
        }, 45000);

    } catch (error) {
        console.error('Error crítico en la inicialización de Baileys:', error);
        setTimeout(connectToWhatsApp, 10000);
    }
}

// Interfaz Web nítida
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (isConnected) {
        return res.send('<h1 style="color: green; font-family: Arial; text-align: center; margin-top: 50px;">=== ¡CONEXIÓN EXITOSA CON WHATSAPP DISPONIBLE! ===</h1>');
    }
    if (currentQrCode) {
        return res.send(`
            <div style="font-family: Arial; text-align: center; margin-top: 50px;">
                <h1>Escanea este código QR con tu WhatsApp</h1>
                <p>Ve a Dispositivos vinculados > Vincular un dispositivo en tu teléfono.</p>
                <img src="${currentQrCode}" style="border: 2px solid #000; padding: 10px; width: 300px; height: 300px;" />
                <script>setTimeout(() => { location.reload(); }, 15000);</script>
            </div>
        `);
    }
    return res.send(`
        <div style="font-family: Arial; text-align: center; margin-top: 50px;">
            <h1>Generando código QR...</h1>
            <p>El servidor se está enlazando con los servidores de WhatsApp.</p>
            <p style="color: gray; font-size: 13px;">Esta página se refrescará automáticamente.</p>
            <script>setTimeout(() => { location.reload(); }, 5000);</script>
        </div>
    `);
});

// Procesador Masivo de Mensajes
app.post('/send-message', async (req, res) => {
    const { op, mensajes, app_script } = req.body;

    if (op === 'registermessage' && mensajes && mensajes.length > 0) {
        if (!sock || !isConnected) {
            return res.status(500).json({ status: '-1', message: 'WhatsApp desvinculado' });
        }

        res.json({ status: '0', message: 'Procesando mensajes en segundo plano...' });
        let respuestasParaGoogle = [];

        for (let msg of mensajes) {
            try {
                const numeroLimpio = `${String(msg.numero).replace(/[^0-9]/g, '')}@s.whatsapp.net`;
                await sock.sendMessage(numeroLimpio, { text: msg.mensaje });
                console.log(`Mensaje enviado con éxito a: ${msg.numero}`);

                respuestasParaGoogle.push({ posicion: msg.posicion, estado: 'Enviado' });
            } catch (err) {
                console.error(`Error enviando a ${msg.numero}:`, err);
                respuestasParaGoogle.push({ posicion: msg.posicion, estado: 'Error' });
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        const urlDestino = app_script || "https://script.google.com/macros/s/AKfycbxKS3U9uxfXVfI9QntD00b_HYa1Me91HktweJZSExpOGTtp7rf-McKXnY4oRWjOVTga/exec";
        if (urlDestino) {
            try {
                await axios.post(urlDestino, { v: 'resultado', mensajes: respuestasParaGoogle });
                console.log('Estados devueltos a Google Sheets con éxito');
            } catch (googleErr) {
                console.error('No se pudo actualizar Google Sheets:', googleErr.message);
            }
        }
    } else {
        return res.status(400).json({ status: '-1', message: 'Estructura desconocida o vacía' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor activo en puerto ${PORT}`);
    connectToWhatsApp();
});
