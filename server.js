const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCodeImage = require('qrcode');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// === CONFIGURACIÓN DE LAS 3 INSTANCIAS ===
let instancias = {
    '1': { sock: null, currentQrCode: null, isConnected: false, initTimeout: null, authFolder: 'auth_1', label: 'Línea 1 (Turno: 7am - 10am)' },
    '2': { sock: null, currentQrCode: null, isConnected: false, initTimeout: null, authFolder: 'auth_2', label: 'Línea 2 (Turno: 10am - 2pm)' },
    '3': { sock: null, currentQrCode: null, isConnected: false, initTimeout: null, authFolder: 'auth_3', label: 'Línea 3 (Turno: 2pm - 6pm)' }
};

async function connectInstance(id) {
    console.log(`Iniciando ciclo de conexión para la Instancia ${id}...`);
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
                console.log(`=== NUEVO CÓDIGO QR PARA INSTANCIA ${id} ===`);
            }
            
            if (connection === 'close') {
                instancias[id].isConnected = false;
                instancias[id].currentQrCode = null;
                const statusCode = lastDisconnect.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`Instancia ${id} cerrada. Reconectando: ${shouldReconnect}`);
                if (shouldReconnect) {
                    setTimeout(() => connectInstance(id), 5000);
                }
            } else if (connection === 'open') {
                if (instancias[id].initTimeout) clearTimeout(instancias[id].initTimeout);
                instancias[id].isConnected = true;
                instancias[id].currentQrCode = null;
                console.log(`=== INSTANCIA ${id} CONECTADA Y LISTA ===`);
            }
        });

        if (instancias[id].initTimeout) clearTimeout(instancias[id].initTimeout);
        instancias[id].initTimeout = setTimeout(() => {
            if (!instancias[id].isConnected && !instancias[id].currentQrCode) {
                console.log(`Forzando reinicio por inactividad en Instancia ${id}...`);
                try { instancias[id].sock.logout(); } catch(e) {}
                connectInstance(id);
            }
        }, 45000);

    } catch (error) {
        console.error(`Error en Instancia ${id}:`, error);
        setTimeout(() => connectInstance(id), 10000);
    }
}

function initAllInstances() {
    connectInstance('1');
    connectInstance('2');
    connectInstance('3');
}

// Panel de control visual
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    let html = `
    <html lang="es">
    <head>
        <title>Panel Multi-Línea con Relevo por Horario</title>
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
        <h1>Panel de Control Multi-Líneas Cíclico (AES CLESA)</h1>
        <p style="color: gray;">Cada línea maneja su horario fijo, saltando a la siguiente de respaldo si ocurre una desconexión.</p>
        <div class="container">
    `;

    for (let id in instancias) {
        let inst = instancias[id];
        let cardClass = inst.isConnected ? 'connected' : 'disconnected';
        
        html += `<div class="card ${cardClass}">`;
        html += `<h2>Instancia ${id}</h2>`;
        html += `<p style="font-weight: bold; color: #555;">${inst.label}</p>`;
        
        if (inst.isConnected) {
            html += `<span class="status-badge status-online">CONECTADA ✅</span>`;
            html += `<div style="margin-top: 40px; color: #2ecc71; font-size: 60px;">✔</div>`;
        } else if (inst.currentQrCode) {
            html += `<span class="status-badge status-offline">Esperando QR 📲</span>`;
            html += `<div class="qr-container"><img src="${inst.currentQrCode}"/></div>`;
        } else {
            html += `<span class="status-badge status-offline">Inicializando...</span>`;
        }
        html += `</div>`;
    }
    html += `</div></body></html>`;
    res.send(html);
});

// === LÓGICA DE SELECCIÓN POR HORARIO CON RESPALDO CÍCLICO ===
// === LÓGICA DE SELECCIÓN POR HORARIO CON RESPALDO CÍCLICO (CORREGIDA Y BLINDADA) ===
function obtenerInstanciaPorHorario() {
    const ahora = new Date();
    
    // Obtenemos la hora UTC absoluta del servidor
    const horaUTC = ahora.getUTCHours();
    
    // Calculamos la hora exacta de El Salvador restando 6 horas (Teniendo en cuenta el cambio de día si da negativo)
    let horaElSalvador = horaUTC - 6;
    if (horaElSalvador < 0) {
        horaElSalvador += 24;
    }
    
    // Capturamos los minutos para los registros del log
    const minutos = ahora.getUTCMinutes().toString().padStart(2, '0');
    console.log(`Hora matemática calculada para El Salvador: ${horaElSalvador}:${minutos}`);

    // Bloque 1: 7:00 AM a 10:00 AM (Horas 7, 8, 9)
    if (horaElSalvador >= 7 && horaElSalvador < 10) {
        console.log('Bloque actual: Línea 1 (7am - 10am)');
        if (instancias['1'].isConnected) return '1';
        if (instancias['2'].isConnected) { console.log('-> Respaldo: Línea 1 caída. Usando Línea 2.'); return '2'; }
        if (instancias['3'].isConnected) { console.log('-> Respaldo: Líneas 1 y 2 caídas. Usando Línea 3.'); return '3'; }
    }
    
    // Bloque 2: 10:01 AM a 2:00 PM (Horas 10, 11, 12, 13)
    if (horaElSalvador >= 10 && horaElSalvador < 14) {
        console.log('Bloque actual: Línea 2 (10am - 2pm)');
        if (instancias['2'].isConnected) return '2';
        if (instancias['3'].isConnected) { console.log('-> Respaldo: Línea 2 caída. Usando Línea 3.'); return '3'; }
        if (instancias['1'].isConnected) { console.log('-> Respaldo: Líneas 2 y 3 caídas. Usando Línea 1.'); return '1'; }
    }

    // Bloque 3: 2:01 PM a 6:00 PM (Horas 14, 15, 16, 17)
    if (horaElSalvador >= 14 && horaElSalvador < 18) {
        console.log('Bloque actual: Línea 3 (2pm - 6pm)');
        if (instancias['3'].isConnected) return '3';
        if (instancias['1'].isConnected) { console.log('-> Respaldo: Línea 3 caída. Usando Línea 1.'); return '1'; }
        if (instancias['2'].isConnected) { console.log('-> Respaldo: Líneas 3 y 1 caídas. Usando Línea 2.'); return '2'; }
    }

    // Fuera de horario de oficina: Usa la primera que encuentre conectada
    console.log('Alerta: Petición fuera de horario de oficina estándar.');
    if (instancias['1'].isConnected) return '1';
    if (instancias['2'].isConnected) return '2';
    if (instancias['3'].isConnected) return '3';

    return null;
}

// === RUTA DE RECEPCIÓN INTELIGENTE ===
app.post('/send-message', async (req, res) => {
    const { op, mensajes, app_script } = req.body;

    if (op === 'registermessage' && mensajes && mensajes.length > 0) {
        
        let idInstanciaElegida = obtenerInstanciaPorHorario();

        if (!idInstanciaElegida) {
            console.error('❌ Error crítico: No hay ninguna línea de WhatsApp vinculada o activa para procesar el envío.');
            return res.status(500).json({ status: '-1', message: 'No hay líneas de WhatsApp conectadas disponibles' });
        }

        let seleccion = instancias[idInstanciaElegida];
        console.log(`=== INICIANDO DESPACHO: Canal asignado '${idInstanciaElegida}' debido a horario y disponibilidad ===`);
        
        res.json({ status: '0', message: `Procesando en segundo plano usando: Línea ${idInstanciaElegida}...` });
        
        let respuestasParaGoogle = [];
        let contadorEnviosSeguidos = 0;

        for (let msg of mensajes) {
            const numeroStr = String(msg.numero || '').replace(/[^0-9]/g, '').trim();
            if (!numeroStr) continue;

            const numeroLimpio = `${numeroStr}@s.whatsapp.net`;

            try {
                // VERIFICACIÓN EN VIVO: Si el teléfono se desconecta DURANTE la ráfaga, busca su relevo según la regla
                if (!seleccion.isConnected) {
                    console.log(`🚨 ¡La Instancia ${idInstanciaElegida} se cayó en pleno envío! Buscando relevo inmediato...`);
                    
                    let nuevoRelevo = null;
                    if (idInstanciaElegida === '1') {
                        nuevoRelevo = instancias['2'].isConnected ? '2' : (instancias['3'].isConnected ? '3' : null);
                    } else if (idInstanciaElegida === '2') {
                        nuevoRelevo = instancias['3'].isConnected ? '3' : (instancias['1'].isConnected ? '1' : null);
                    } else if (idInstanciaElegida === '3') {
                        nuevoRelevo = instancias['1'].isConnected ? '1' : (instancias['2'].isConnected ? '2' : null);
                    }

                    if (nuevoRelevo) {
                        idInstanciaElegida = nuevoRelevo;
                        seleccion = instancias[idInstanciaElegida];
                        console.log(`🔄 Relevo exitoso en caliente. Continuando ráfaga con la Instancia ${idInstanciaElegida}.`);
                    } else {
                        console.error('❌ Relevo fallido. No quedan más líneas vivas en este momento.');
                        respuestasParaGoogle.push({ posicion: String(msg.posicion), estado: 'ERROR: Canales caídos ❌' });
                        continue;
                    }
                }

                let existeNumero = false;
                try {
                    const checkStatus = await seleccion.sock.onWhatsApp(numeroLimpio);
                    if (checkStatus && checkStatus.length > 0 && checkStatus[0].exists) {
                        existeNumero = true;
                    }
                } catch (errCheck) { existeNumero = true; }
                
                if (!existeNumero) {
                    respuestasParaGoogle.push({ posicion: String(msg.posicion), estado: 'SIN WHATSAPP ❌' });
                    continue;
                }

                try { await seleccion.sock.sendPresenceUpdate('composing', numeroLimpio); } catch (e) {}
                await new Promise(resolve => setTimeout(resolve, 4000));

                if (msg.mensaje) {
                    await seleccion.sock.sendMessage(numeroLimpio, { text: msg.mensaje });
                }

                if (msg.url) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    try {
                        await seleccion.sock.sendMessage(numeroLimpio, {
                            document: { url: msg.url },
                            mimetype: 'application/pdf',
                            fileName: 'documento.pdf'
                        });
                    } catch (urlErr) {}
                }

                respuestasParaGoogle.push({ posicion: String(msg.posicion), estado: 'ENVIADO ✅' });
                contadorEnviosSeguidos++;

            } catch (err) {
                console.error(`Error en canal ${idInstanciaElegida}:`, err.message);
                respuestasParaGoogle.push({ posicion: String(msg.posicion), estado: 'SIN WHATSAPP ❌' });
            }

            if (contadorEnviosSeguidos >= 3) {
                await new Promise(resolve => setTimeout(resolve, 60000));
                contadorEnviosSeguidos = 0;
            } else {
                const esperaAleatoria = Math.floor(Math.random() * (25000 - 15000 + 1)) + 15000;
                await new Promise(resolve => setTimeout(resolve, esperaAleatoria));
            }
        }

        const urlDestino = app_script || "https://script.google.com/macros/s/AKfycbyiQd0fN6VVWL5FR85VJyOF_QzdjcvGIujVeBBTqiL992BKy8G0cfPBl__jnE0N0QMDYA/exec";
        if (urlDestino && respuestasParaGoogle.length > 0) {
            try {
                await axios.post(urlDestino, { op: 'resultado', mensajes: respuestasParaGoogle }, { headers: { 'Content-Type': 'application/json' }, timeout: 20000 });
            } catch (googleErr) {}
        }

    } else {
        return res.status(400).json({ status: '-1', message: 'Estructura incorrecta' });
    }
});

app.get('/ping', (req, res) => { res.json({ status: 'ok' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor Multi-Línea Cíclico Activo en puerto ${PORT}`);
    initAllInstances();
});
