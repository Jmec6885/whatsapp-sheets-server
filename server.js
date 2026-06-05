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
        
        // VARIABLE NUEVA: Mantiene la cuenta de mensajes consecutivos procesados en la ráfaga
        let contadorEnviosSeguidos = 0;

        for (let msg of mensajes) {
            const numeroStr = String(msg.numero || '').replace(/[^0-9]/g, '').trim();
            if (!numeroStr) {
                console.log(`Fila con índice de envío ${msg.posicion} sin número válido, se omite.`);
                continue;
            }

            const numeroLimpio = `${numeroStr}@s.whatsapp.net`;
            console.log(`Procesando índice de envío ${msg.posicion} — número: ${numeroLimpio}`);

            try {
                let existeNumero = false;
                try {
                    const checkStatus = await sock.onWhatsApp(numeroLimpio);
                    if (checkStatus && checkStatus.length > 0 && checkStatus[0].exists) {
                        existeNumero = true;
                    }
                } catch (errCheck) {
                    console.log(`No se pudo verificar la existencia del número ${msg.numero}, intentando enviar directamente.`);
                    existeNumero = true; 
                }
                
                if (!existeNumero) {
                    console.log(`Número sin WhatsApp confirmado: ${msg.numero}`);
                    respuestasParaGoogle.push({ posicion: String(msg.posicion), estado: 'SIN WHATSAPP ❌' });
                    continue;
                }

                // SIMULAR ESCRITURA HUMANA ("Escribiendo...")
                try {
                    await sock.sendPresenceUpdate('composing', numeroLimpio);
                } catch (ePresence) {
                    console.log('No se pudo enviar presencia de escritura, continuando...');
                }
                
                // Esperar 4 segundos simulando que el operador está digitando el mensaje
                await new Promise(resolve => setTimeout(resolve, 4000));

                if (msg.mensaje) {
                    await sock.sendMessage(numeroLimpio, { text: msg.mensaje });
                    console.log(`Texto enviado a: ${msg.numero}`);
                }

                if (msg.url) {
                    // Esperar un breve instante simulando la carga del documento antes de despacharlo
                    await new Promise(resolve => setTimeout(resolve, 2000));
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

                respuestasParaGoogle.push({ posicion: String(msg.posicion), estado: 'ENVIADO ✅' });
                
                // Incrementamos el contador de envíos en la ráfaga actual
                contadorEnviosSeguidos++;

            } catch (err) {
                console.error(`Error procesando índice de envío ${msg.posicion} (${msg.numero}):`, err.message);
                respuestasParaGoogle.push({ posicion: String(msg.posicion), estado: 'SIN WHATSAPP ❌' });
            }

            // === LÓGICA DE BLINDAJE AVANZADO ANTI-BANEO ===
            if (contadorEnviosSeguidos >= 3) {
                console.log('=== ALERTA DE RÁFAGA: Se enviaron 3 mensajes seguidos. Forzando un descanso de 60 segundos... ===');
                await new Promise(resolve => setTimeout(resolve, 60000));
                contadorEnviosSeguidos = 0; // Reiniciamos el contador tras la pausa larga
            } else {
                // Intervalo variable aumentado (Entre 15 y 25 segundos) para mitigar el rastreo automatizado de Meta
                const esperaAleatoria = Math.floor(Math.random() * (25000 - 15000 + 1)) + 15000;
                console.log(`Pausa de seguridad estándar: Esperando ${esperaAleatoria / 1000} segundos antes del siguiente...`);
                await new Promise(resolve => setTimeout(resolve, esperaAleatoria));
            }
        }

        const urlDestino = app_script || "https://script.google.com/macros/s/AKfycbyiQd0fN6VVWL5FR85VJyOF_QzdjcvGIujVeBBTqiL992BKy8G0cfPBl__jnE0N0QMDYA/exec";

        if (urlDestino && respuestasParaGoogle.length > 0) {
            console.log(`=== ENVIANDO RESPUESTAS DE VUELTA A GOOGLE SHEETS ===`);
            console.log(`URL de Destino Sincronizada: ${urlDestino}`);

            try {
                const responseGoogle = await axios.post(urlDestino, {
                    op: 'resultado',
                    mensajes: respuestasParaGoogle
                }, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 20000
                });

                console.log('--- RESPUESTA RECIBIDA DESDE GOOGLE SHEETS ---');
                console.log('Código de estado:', responseGoogle.status);
                console.log('Cuerpo devuelto:', JSON.stringify(responseGoogle.data));
                console.log(`====================================================`);
            } catch (googleErr) {
                console.error('!!! ERROR EN LA COMUNICACIÓN CON GOOGLE SHEETS !!!');
                if (googleErr.response) {
                    console.error('Código del estado del error:', googleErr.response.status);
                    console.error('Detalles del Servidor de Google:', JSON.stringify(googleErr.response.data));
                } else {
                    console.error('Mensaje de error básico:', googleErr.message);
                }
                console.error(`====================================================`);
            }
        }

    } else {
        return res.status(400).json({ status: '-1', message: 'Estructura desconocida o vacía' });
    }
});

app.get('/ping', (req, res) => {
    res.json({ status: 'ok', connected: isConnected, time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor activo en puerto ${PORT}`);
    connectToWhatsApp();
});
