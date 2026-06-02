const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCodeImage = require('qrcode'); // Cambiamos a esta librería para generar imágenes reales
const app = express();

app.use(express.json());

let sock;
let currentQrCode = null; // Aquí guardaremos el QR actual en formato de imagen
let isConnected = false;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false // Ya no imprimimos el QR roto en la consola
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            // Convertimos el código de texto en una imagen Base64 para mostrarla en el navegador
            currentQrCode = await QRCodeImage.toDataURL(qr);
            console.log('=== NUEVO CÓDIGO QR GENERADO: Abre la URL de tu servicio para escanearlo ===');
        }
        
        if (connection === 'close') {
            isConnected = false;
            currentQrCode = null;
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexión cerrada. Reconectando:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            isConnected = true;
            currentQrCode = null;
            console.log('=== ¡CONEXIÓN EXITOSA CON WHATSAPP DISPONIBLE! ===');
        }
    });
}

// Ruta principal (Página Web para escanear el QR)
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    
    if (isConnected) {
        return res.send('<h1 style="color: green; font-family: Arial; text-align: center; margin-top: 50px;">=== ¡CONEXIÓN EXITOSA CON WHATSAPP DISPONIBLE! ===</h1>');
    }
    
    if (currentQrCode) {
        return res.send(`
            <div style="font-family: Arial; text-align: center; margin-top: 50px;">
                <h1>Escanea este código QR con tu WhatsApp</h1>
                <p>Ve a Dispositivos vinculados > Vincular un dispositivo</p>
                <img src="${currentQrCode}" style="border: 2px solid #000; padding: 10px; width: 300px; height: 300px;" />
                <p style="color: gray; margin-top: 20px;">La página se actualizará automáticamente si el código expira.</p>
                <script>setTimeout(() => { location.reload(); }, 20000);</script>
            </div>
        `);
    }
    
    return res.send('<h1 style="font-family: Arial; text-align: center; margin-top: 50px;">Generando código QR... Por favor, recarga en unos segundos.</h1>');
});

// Ruta API para recibir las órdenes de envío de Google Sheets
app.post('/send-message', async (req, res) => {
    const { number, message } = req.body;

    if (!sock || !isConnected) {
        return res.status(500).json({ status: 'error', message: 'El servidor de WhatsApp no está conectado' });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
    connectToWhatsApp();
});
