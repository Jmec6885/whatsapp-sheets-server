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
                    setTimeout(connectToWhatsApp, 5000);
                }
            } else if (connection === 'open') {
                if (initTimeout) clearTimeout(initTimeout);
                isConnected = true;
                currentQrCode = null;
                console.log('=== CONEXIÓN EXITOSA ESTABLECIDA CON WHATSAPP ===');
            }
        });

        if (initTimeout) clearTimeout(initTimeout);
        initTimeout = setTimeout(() => {
            if (!isConnected && !currentQrCode) {
                console.log('Detectada inactividad. Forzando reinicio de Baileys...');
                try { sock.logout(); } catch(e) {}
                connectToWhatsApp();
            }
        }, 45000);

    } catch (error) {
        console.error('Error crítico en la inicialización de Baileys:', error);
        setTimeout(connectToWhatsApp, 10000);
    }
}

app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (isConnected) {
        return res.send('<h1 style="color:green;font-family:Arial;text-align:center;margin-top:50px">=== ¡CONEXIÓN EXITOSA CON WHATSAPP DISPONIBLE! ===</h1>');
    }
    if (currentQrCode) {
        return res.send(`
            <div style="font-family:Arial;text-align:center;margin-top:50px">
                <h1>Escanea este código QR con tu WhatsApp</h1>
                <p>Ve a Dispositivos vinculados > Vincular un dispositivo en tu teléfono.</p>
                <img src="${currentQrCode}" style="border:2px solid #000;padding:10px;width:300px;height:300px"/>
                <script>setTimeout(() => { location.reload(); }, 15000);</script>
            </div>
        `);
    }
    return res.send(`
        <div style="font-family:Arial;text-align:center;margin-top:50px">
            <h1>Generando código QR...</h1>
            <p>El servidor se está enlazando con los servidores de WhatsApp.</p>
            <p style="color:gray;font-size:13px">Esta página se refrescará automáticamente.</p>
            <script>setTimeout(() => { location.reload(); }, 5000);</script>
        </div>
    `);
});

app.post('/send-message', async (req, res) => {
    const { op, mensajes, app_script } = req.body;

    if (op === 'registermessage' && mensajes && mensajes.length > 0) {
        if (!sock || !isConnected) {
            return res.status(500).json({ status: '-1', message: 'WhatsApp desvinculado' });
        }

        res.json({ status: '0', message: 'Procesando mensajes en segundo plano...' });
        let respuestasParaGoogle = [];

        for (let msg of mensajes) {
            const numeroStr = String(msg.numero || '').replace(/[^0-9]/g, '').trim();
            if (!numeroStr) {
                console.log(`Fila ${msg.posicion} sin número válido, se omite.`);
                continue;
            }

            const numeroLimpio = `${numeroStr}@s.whatsapp.net`;
            console.log(`Procesando fila ${msg.posicion} — número: ${numeroLimpio}`);

            try {
                // Intentamos el envío directo del texto
                if (msg.mensaje) {
                    await sock.sendMessage(numeroLimpio, { text: msg.mensaje });
                    console.log(`Texto enviado a: ${msg.numero}`);
                }

                // Intentamos el envío del documento PDF si existe
                if (msg.url) {
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    try {
                        await sock.sendMessage(numeroLimpio, {
                            document: { url: msg.url },
                            mimetype: 'application/pdf',
                            fileName: 'documento.pdf'
                        });
                        console.log(`URL enviada a: ${msg.numero}`);
                    } catch (urlErr) {
                        console.error(`Error enviando URL a ${msg.numero}:`, urlErr.message);
                    }
                }

                // Si todo se ejecuta sin lanzar excepciones, el número es válido y recibió el mensaje
                respuestasParaGoogle.push({ posicion: msg.posicion, estado: 'ENVIADO ✅' });

            } catch (err) {
                // Analizamos el mensaje de error que devuelve la librería Baileys
                const errorMsg = String(err.message || '').toLowerCase();
                console.error(`Falla detectada en la fila ${msg.posicion} (${msg.numero}):`, err.message);
                
                // Si el error contiene texto de número no encontrado o es una falla de entrega asíncrona, es SIN WHATSAPP
                if (errorMsg.includes('not-found') || errorMsg.includes('404') || errorMsg.includes('item-not-found') || errorMsg.includes('invalid')) {
                    respuestasParaGoogle.push({ posicion: msg.posicion, estado: 'SIN WHATSAPP ❌' });
                } else {
                    // Por seguridad, si es cualquier otro error técnico de red, también lo marcamos para que lo revises
                    respuestasParaGoogle.push({ posicion: msg.posicion, estado: 'SIN WHATSAPP ❌' });
                }
            }

            // Subimos un poco el tiempo a 3 segundos para darle tiempo a WhatsApp de responder si el número existe o no
            await new Promise(resolve => setTimeout(resolve, 3000));
        }

        const urlDestino = app_script || "https://script.google.com/macros/s/AKfycbxKS3U9uxfXVfI9QntD00b_HYa1Me91HktweJZSExpOGTtp7rf-McKXnY4oRWjOVTga/exec";

        if (urlDestino && respuestasParaGoogle.length > 0) {
            try {
                await axios.post(urlDestino, {
                    op: 'resultado',
                    mensajes: respuestasParaGoogle
                }, {
                    headers: { 'Content-Type': 'application/json' }
                });
                console.log('Estados devueltos a Google Sheets con éxito:', JSON.stringify(respuestasParaGoogle));
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
