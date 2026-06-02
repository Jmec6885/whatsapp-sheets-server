const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');
const app = express();

app.use(express.json());

let sock;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    waWebSocketUrl: 'wss://web.whatsapp.com/ws/chat', // Fuerza la URL oficial de WhatsApp Web
    connectTimeoutMs: 60000, // Le da más tiempo para conectar si la red de la oficina es lenta
    defaultQueryTimeoutMs: 0
});

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('=== ESCANEA ESTE CÓDIGO QR CON TU WHATSAPP ===');
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexión cerrada. Reconectando:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('=== ¡CONEXIÓN EXITOSA CON WHATSAPP DISPONIBLE! ===');
        }
    });
}

app.post('/send-message', async (req, res) => {
    const { number, message } = req.body;

    if (!sock) {
        return res.status(500).json({ status: 'error', message: 'El servidor de WhatsApp no está listo' });
    }

    try {
        const formattedNumber = `${number.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(formattedNumber, { text: message });
        console.log(`Mensaje enviado con éxito a: ${number}`);
        return res.json({ status: 'success', message: 'Mensaje enviado correctamente' });
    } catch (error) {
        console.error('Error al enviar mensaje:', error);
        return res.status(500).json({ status: 'error', message: error.toString() });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Servidor de envíos escuchando localmente en el puerto ${PORT}`);
    connectToWhatsApp();
});