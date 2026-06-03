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
        // Verificar si el número tiene WhatsApp antes de enviar
        const [resultado] = await sock.onWhatsApp(numeroLimpio);
        
        if (!resultado || !resultado.exists) {
            console.log(`Número sin WhatsApp: ${msg.numero}`);
            respuestasParaGoogle.push({ posicion: msg.posicion, estado: 'SIN WHATSAPP ❌' });
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
        }

        // Enviar mensaje de texto
        if (msg.mensaje) {
            await sock.sendMessage(numeroLimpio, { text: msg.mensaje });
            console.log(`Texto enviado a: ${msg.numero}`);
        }

        // Enviar URL si existe
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

        respuestasParaGoogle.push({ posicion: msg.posicion, estado: 'ENVIADO ✅' });

    } catch (err) {
        console.error(`Error en fila ${msg.posicion} (${msg.numero}):`, err.message);
        respuestasParaGoogle.push({ posicion: msg.posicion, estado: 'SIN WHATSAPP ❌' });
    }

    await new Promise(resolve => setTimeout(resolve, 3000));
}

        const urlDestino = app_script || "https://script.google.com/macros/s/AKfycbwxcOuG0ub5eZ9_In-Df39WhqiliOlvxK6xjJZKV42-F3m5HXB5i5Fr35gSFcgQm-6Lkg/exec";

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


function doPost(e) {
  try {
    const operacion = JSON.parse(e.postData.contents);
    
    if (operacion.op === 'resultado' && operacion.mensajes) {
      const hoja = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
      
      for (let i = 0; i < operacion.mensajes.length; i++) {
        const fila = 2 + parseInt(operacion.mensajes[i].posicion);
        const estado = operacion.mensajes[i].estado;
        
        // Columna F = 6
        hoja.getRange(fila, 6).setValue(estado);
        
        // Color según estado
        if (estado === 'ENVIADO ✅') {
          hoja.getRange(fila, 6).setBackground('#b7e1cd');
        } else if (estado === 'SIN WHATSAPP ❌') {
          hoja.getRange(fila, 6).setBackground('#f4cccc');
        }
      }
      
      return ContentService.createTextOutput(JSON.stringify({ status: '0', message: 'OK' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({ status: '-1', message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
