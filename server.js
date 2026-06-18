const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCodeImage = require('qrcode');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// === CONFIGURACIÓN GLOBAL DE LAS 3 INSTANCIAS EN PARALELO ===
let instancias = {
    '1': { sock: null, currentQrCode: null, isConnected: false, initTimeout: null, authFolder: 'auth_1', label: 'Línea 1 (7:00 AM - 10:00 AM)' },
    '2': { sock: null, currentQrCode: null, isConnected: false, initTimeout: null, authFolder: 'auth_2', label: 'Línea 2 (10:01 AM - 2:00 PM)' },
    '3': { sock: null, currentQrCode: null, isConnected: false, initTimeout: null, authFolder: 'auth_3', label: 'Línea 3 (2:01 PM - 6:00 PM)' }
};

async function connectInstance(id) {
    console.log(`Iniciando ciclo de conexión con Baileys para la Instancia ${id}...`);
    try {
        const { state, saveCreds } = await useMultiFileAuthState(instancias[id].authFolder);
        const { version } = await fetchLatestBaileysVersion();
        
        let sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            defaultQueryTimeoutMs: undefined,
            connectTimeoutMs: 60000
        });

        instancias[id].sock = sock;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                if (instancias[id].initTimeout) clearTimeout(instancias[id].initTimeout);
                instancias[id].currentQrCode = await QRCodeImage.toDataURL(qr);
                console.log(`=== NUEVO CÓDIGO QR GENERADO CON ÉXITO PARA INSTANCIA ${id} ===`);
            }
            
            if (connection === 'close') {
                instancias[id].isConnected = false;
                instancias[id].currentQrCode = null;
                const statusCode = lastDisconnect.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`Instancia ${id} cerrada (Código: ${statusCode}). Reconectando: ${shouldReconnect}`);
                if (shouldReconnect) {
                    setTimeout(() => connectInstance(id), 5000);
                }
            } else if (connection === 'open') {
                if (instancias[id].initTimeout) clearTimeout(instancias[id].initTimeout);
                instancias[id].isConnected = true;
                instancias[id].currentQrCode = null;
                console.log(`=== CONEXIÓN EXITOSA ESTABLECIDA CON WHATSAPP EN INSTANCIA ${id} ===`);
            }
        });

        if (instancias[id].initTimeout) clearTimeout(instancias[id].initTimeout);
        instancias[id].initTimeout = setTimeout(() => {
            if (!instancias[id].isConnected && !instancias[id].currentQrCode) {
                console.log(`Detectada inactividad en Instancia ${id}. Forzando reinicio de Baileys...`);
                try { instancias[id].sock.logout(); } catch(e) {}
                connectInstance(id);
            }
        }, 45000);

    } catch (error) {
        console.error(`Error crítico en la inicialización de Baileys para Instancia ${id}:`, error);
        setTimeout(() => connectInstance(id), 10000);
    }
}

// Inicializar de golpe las 3 líneas al prender el servidor
function initAllInstances() {
    connectInstance('1');
    connectInstance('2');
    connectInstance('3');
}

// === INTERFAZ WEB ADAPTADA PARA CONTROLAR LAS 3 LÍNEAS EN UNA SOLA PÁGINA ===
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    
    let html = `
    <html lang="es">
    <head>
        <title>Panel Multi-Línea WhatsApp</title>
        <style>
            body { font-family: Arial, sans-serif; background-color: #f4f7f6; margin: 0; padding: 20px; text-align: center; }
            h1 { color: #333; }
            .container { display: flex; justify-content: center; gap: 20px; flex-wrap: wrap; margin-top: 30px; }
            .card { background: white; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); padding: 20px; width: 320px; border-top: 5px solid #ccc; }
            .connected { border-top-color: #2ecc71; }
            .disconnected { border-top-color: #e74c3c; }
            .qr-container img { width: 250px; height: 250px; border: 1px solid #ddd; padding: 5px; margin-top: 15px; }
            .status-badge { display: inline-block; padding: 6px 12px; border-radius: 20px; font-weight: bold; margin-top: 10px; }
            .status-online { background-color: #e8f8f5; color: #2ecc71; }
            .status-offline { background-color: #fdedec; color: #e74c3c; }
        </style>
        <script>setTimeout(() => { location.reload(); }, 15000);</script>
    </head>
    <body>
        <h1>Panel de Control Multi-Líneas (AES CLESA)</h1>
        <p style="color: gray;">La página se refresca automáticamente cada 15 segundos para mostrar códigos nuevos o conexiones.</p>
        <div class="container">
    `;

    for (let id in instancias) {
        let inst = instancias[id];
        let cardClass = inst.isConnected ? 'connected' : 'disconnected';
        
        html += `<div class="card ${cardClass}">`;
        html += `<h2>Instancia ${id}</h2>`;
        html += `<p style="font-weight: bold; color: #555;">${inst.label}</p>`;
        
        if (inst.isConnected) {
            html += `<span class="status-badge status-online">¡CONECTADO! ✅</span>`;
            html += `<div style="margin-top: 40px; color: #2ecc71; font-size: 60px;">✔</div>`;
        } else if (inst.currentQrCode) {
            html += `<span class="status-badge status-offline">Esperando QR 📲</span>`;
            html += `<div class="qr-container"><img src="${inst.currentQrCode}"/></div>`;
            html += `<p style="font-size: 11px; color: gray; margin-top: 5px;">Dispositivos vinculados > Vincular dispositivo</p>`;
        } else {
            html += `<span class="status-badge status-offline">Generando QR...</span>`;
            html += `<p style="margin-top: 40px; color: gray; font-size: 14px;">Estableciendo enlace...</p>`;
        }
        html += `</div>`;
    }

    html += `</div></body></html>`;
    res.send(html);
});

// === RUTA DE RECEPCIÓN: PROCESA SEGÚN LA INSTANCIA SOLICITADA POR GOOGLE ===
app.post('/send-message', async (req, res) => {
    const { op, mensajes, app_script, instancia } = req.body;

    // Si por algún motivo Google no especifica la instancia, usamos la '1' por defecto
    let idInstancia = (instancia && instancias[instancia]) ? String(instancia) : '1';
    let seleccion = instancias[idInstancia];

    if (op === 'registermessage' && mensajes && mensajes.length > 0) {
        if (!seleccion.sock || !seleccion.isConnected) {
            console.error(`Error: Solicitud para Instancia ${idInstancia} pero se encuentra desvinculada.`);
            return res.status(500).json({ status: '-1', message: `WhatsApp Línea ${idInstancia} desvinculado` });
        }

        console.log(`=== INICIANDO DESPACHO USANDO LA INSTANCIA ${idInstancia} ===`);
        res.json({ status: '0', message: `Procesando mensajes en segundo plano usando Línea ${idInstancia}...` });
        
        let respuestasParaGoogle = [];
        let contadorEnviosSeguidos = 0;

        for (let msg of mensajes) {
            const numeroStr = String(msg.numero || '').replace(/[^0-9]/g, '').trim();
            if (!numeroStr) {
                console.log(`Fila con índice de envío ${msg.posicion} sin número válido, se omite.`);
                continue;
            }

            const numeroLimpio = `${numeroStr}@s.whatsapp.net`;
            console.log(`[Línea ${idInstancia}] Procesando índice ${msg.posicion} — número: ${numeroLimpio}`);

            try {
                let existeNumero = false;
                try {
                    const checkStatus = await seleccion.sock.onWhatsApp(numeroLimpio);
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

                // SIMULAR ESCRITURA HUMANA
                try {
                    await seleccion.sock.sendPresenceUpdate('composing', numeroLimpio);
                } catch (ePresence) {}
                
                await new Promise(resolve => setTimeout(resolve, 4000));

                if (msg.mensaje) {
                    await seleccion.sock.sendMessage(numeroLimpio, { text: msg.mensaje });
                    console.log(`Texto enviado a: ${msg.numero}`);
                }

                if (msg.url) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    try {
                        await seleccion.sock.sendMessage(numeroLimpio, {
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
                contadorEnviosSeguidos++;

            } catch (err) {
                console.error(`Error procesando índice de envío ${msg.posicion} (${msg.numero}):`, err.message);
                respuestasParaGoogle.push({ posicion: String(msg.posicion), estado: 'SIN WHATSAPP ❌' });
            }

            // BLINDAJE INTERNO DE LA INSTANCIA SELECCIONADA
            if (contadorEnviosSeguidos >= 3) {
                console.log(`[Línea ${idInstancia}] Ráfaga: Descanso de 60 segundos...`);
                await new Promise(resolve => setTimeout(resolve, 60000));
                contadorEnviosSeguidos = 0;
            } else {
                const esperaAleatoria = Math.floor(Math.random() * (25000 - 15000 + 1)) + 15000;
                console.log(`[Línea ${idInstancia}] Esperando ${esperaAleatoria / 1000} segundos...`);
                await new Promise(resolve => setTimeout(resolve, esperaAleatoria));
            }
        }

        const urlDestino = app_script || "https://script.google.com/macros/s/AKfycbyiQd0fN6VVWL5FR85VJyOF_QzdjcvGIujVeBBTqiL992BKy8G0cfPBl__jnE0N0QMDYA/exec";

        if (urlDestino && respuestasParaGoogle.length > 0) {
            console.log(`=== ENVIANDO RESPUESTAS DE VUELTA A GOOGLE SHEETS DESDE INSTANCIA ${idInstancia} ===`);
            try {
                const responseGoogle = await axios.post(urlDestino, {
                    op: 'resultado',
                    mensajes: respuestasParaGoogle
                }, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 20000
                });
                console.log('Código de estado Google:', responseGoogle.status);
            } catch (googleErr) {
                console.error('Error enviando reporte a Google Sheets:', googleErr.message);
            }
        }

    } else {
        return res.status(400).json({ status: '-1', message: 'Estructura desconocida o vacía' });
    }
});

app.get('/ping', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor Multi-Línea activo en puerto ${PORT}`);
    initAllInstances();
});
