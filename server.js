const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCodeImage = require('qrcode');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Permite procesar datos si vienen en formato de formulario

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

// Ruta de envío mejorada e híbrida para acoplarse a Google Sheets
app.post('/send-message', async (req, res) => {
    console.log('Datos recibidos desde Google Sheets:', JSON.stringify(req.body));
    
    // Mapeo flexible: intenta buscar el número y el texto en cualquier formato común de las plantillas masivas
    const number = req.body.number || req.body.numero || (req.body.body && (req.body.body.number || req.body.body.numero));
    const message = req.body.message || req.body.texto || req.body.text || (req.body.body && (req.body.body.message || req.body.body.texto));

    if (!number || !message) {
        console.log('Estructura de datos no reconocida');
        return res.status(400).json({ status: 'error', message: 'Falta el número o el mensaje en la petición' });
    }

    if (!sock || !isConnected) {
        return res.status(500).json({ status: 'error', message: 'El servidor de WhatsApp no está conectado' });
    }

    try {
        const formattedNumber = `${String(number).replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(formattedNumber, { text: message });
        console.log(`Mensaje enviado con éxito a: ${number}`);
        
        // Devolvemos la respuesta exacta que Google Sheets espera para escribir "Enviado" en la celda
        return res.json({ status: 'success', message: 'Enviado' });
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
