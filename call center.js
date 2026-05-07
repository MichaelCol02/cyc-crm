/**
 * Módulo de Difusión Inteligente WhatsApp
 * Usa @whiskeysockets/baileys (conector no oficial)
 * 
 * Features:
 *  - Delay aleatorio entre mensajes para evitar detección spam
 *  - Variaciones de mensaje por cliente (rotación anti-spam)
 *  - Envío de imagen adjunta opcional
 *  - Control de tandas con pausa entre ellas
 *  - Reemplazo de variables por datos reales del cliente
 *  - Logs de envío con estado por contacto
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─── Logger silencioso (para no llenar consola) ─────────────────────────────
const logger = pino({ level: 'silent' })

// ─── Estado global del socket ────────────────────────────────────────────────
let sock = null
let isConnected = false

// ─── Conectar a WhatsApp ─────────────────────────────────────────────────────
export async function conectar(onQR, onConnected) {
  const authDir = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, 'auth')
    : path.join(__dirname, 'auth')

  const { state, saveCreds } = await useMultiFileAuthState(authDir)

  let version = [2, 3000, 1021030400]
  try {
    const latest = await fetchLatestBaileysVersion()
    if (latest?.version) version = latest.version
  } catch (_) {
    console.log('[WA] No se pudo obtener versión WA, usando fallback')
  }

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['CRM Carnes', 'Chrome', '1.0.0'],
  })

  sock.ev.on('creds.update', saveCreds)

  // Guardar contactos a disco para que /api/wa-contacts los sirva
  const contactsFile = path.join(authDir, 'contacts.json')
  function _leerContactos() {
    try { return JSON.parse(fs.readFileSync(contactsFile, 'utf8')); } catch(_) { return {}; }
  }
  function _guardarContactos(data) {
    try { fs.writeFileSync(contactsFile, JSON.stringify(data)); } catch(_) {}
  }

  sock.ev.on('contacts.upsert', (contacts) => {
    const existing = _leerContactos()
    contacts.forEach(c => {
      if (!c.id || c.id.includes('@g.us') || c.id.includes('broadcast')) return
      existing[c.id] = {
        name:         c.name         || existing[c.id]?.name         || '',
        pushName:     c.pushName     || existing[c.id]?.pushName     || '',
        verifiedName: c.verifiedName || existing[c.id]?.verifiedName || '',
      }
    })
    _guardarContactos(existing)
    console.log('[WA] Contactos guardados:', Object.keys(existing).length)
  })

  sock.ev.on('contacts.update', (updates) => {
    const existing = _leerContactos()
    updates.forEach(c => {
      if (!c.id || c.id.includes('@g.us')) return
      existing[c.id] = Object.assign({}, existing[c.id] || {}, {
        name:     c.name     || existing[c.id]?.name     || '',
        pushName: c.pushName || existing[c.id]?.pushName || '',
      })
    })
    _guardarContactos(existing)
  })

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr && onQR) onQR(qr)

    if (connection === 'close') {
      isConnected = false
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !==
        DisconnectReason.loggedOut
      console.log('[WA] Conexión cerrada. Reconectar:', shouldReconnect)
      if (shouldReconnect) setTimeout(() => conectar(onQR, onConnected), 3000)
    }

    if (connection === 'open') {
      isConnected = true
      console.log('[WA] ✅ Conectado a WhatsApp')
      if (onConnected) onConnected()
    }
  })
}

// ─── Utilidades de delay ─────────────────────────────────────────────────────

/**
 * Espera un tiempo aleatorio entre min y max segundos
 */
function delayAleatorio(minSeg, maxSeg) {
  const ms = (Math.random() * (maxSeg - minSeg) + minSeg) * 1000
  console.log(`[DELAY] Esperando ${(ms / 1000).toFixed(1)}s antes del próximo mensaje...`)
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Simula "escribiendo..." en WhatsApp antes de enviar
 * Hace el mensaje más humano
 */
async function simularEscritura(jid, duracionMs) {
  await sock.sendPresenceUpdate('composing', jid)
  await new Promise(resolve => setTimeout(resolve, duracionMs))
  await sock.sendPresenceUpdate('paused', jid)
}

// ─── Reemplazo de variables ──────────────────────────────────────────────────

/**
 * Reemplaza {variables} con datos reales del cliente
 * @param {string} plantilla - Texto con {variables}
 * @param {object} cliente   - Objeto con datos del cliente
 */
function reemplazarVariables(plantilla, cliente) {
  return plantilla
    .replace(/\{nombre\}/g,       cliente.nombre       || 'estimado cliente')
    .replace(/\{producto\}/g,     cliente.producto      || 'nuestros productos')
    .replace(/\{kg_ultimo\}/g,    cliente.kg_ultimo     || 'tu pedido anterior')
    .replace(/\{fecha_ultimo\}/g, cliente.fecha_ultimo  || 'la última vez')
    .replace(/\{ciudad\}/g,       cliente.ciudad        || 'tu ciudad')
    .replace(/\{direccion\}/g,    cliente.direccion     || 'tu dirección registrada')
    .replace(/\{whatsapp\}/g,     cliente.whatsapp      || '')
}

// ─── Envío de un mensaje individual ─────────────────────────────────────────

/**
 * Envía texto (con o sin imagen) a un número
 * @param {string} numero    - Número con código de país, sin + (ej: 573101234567)
 * @param {string} texto     - Mensaje ya con variables reemplazadas
 * @param {string|null} imgPath - Ruta local a la imagen (null si no hay)
 */
async function enviarMensaje(numero, texto, imgPath = null) {
  const jid = `${numero}@s.whatsapp.net`

  // Simular que está escribiendo (entre 1.5 y 3.5 segundos)
  const tipoEscritura = Math.random() * 2000 + 1500
  await simularEscritura(jid, tipoEscritura)

  if (imgPath && fs.existsSync(imgPath)) {
    // Enviar imagen con caption
    const buffer = fs.readFileSync(imgPath)
    const ext = path.extname(imgPath).toLowerCase()
    const mimetype = ext === '.png' ? 'image/png' : 'image/jpeg'

    await sock.sendMessage(jid, {
      image: buffer,
      caption: texto,
      mimetype,
    })
  } else {
    // Enviar solo texto
    await sock.sendMessage(jid, { text: texto })
  }
}

// ─── Motor principal de difusión ─────────────────────────────────────────────

/**
 * Ejecuta una campaña de difusión completa
 *
 * @param {object} config
 * @param {Array}  config.contactos       - Lista de clientes (ver estructura abajo)
 * @param {Array}  config.variaciones     - Array de strings con versiones del mensaje
 * @param {string|null} config.imagenPath - Ruta a imagen (o null)
 * @param {number} config.delayMinSeg     - Delay mínimo entre mensajes (seg)
 * @param {number} config.delayMaxSeg     - Delay máximo entre mensajes (seg)
 * @param {number} config.tamanoTanda     - Cuántos mensajes por tanda
 * @param {number} config.pausaTandaMin   - Minutos de pausa entre tandas
 * @param {function} config.onProgreso    - Callback(progreso) llamado tras cada envío
 * @param {function} config.onLog         - Callback(logItem) para guardar logs
 *
 * Estructura de cada contacto:
 * {
 *   nombre: 'Juan',
 *   whatsapp: '573101234567',
 *   email: 'juan@email.com',
 *   producto: 'lomo de res',
 *   kg_ultimo: '50 kg',
 *   fecha_ultimo: '5 mar',
 *   ciudad: 'Cali',
 * }
 */
export async function ejecutarDifusion(config) {
  const {
    contactos,
    variaciones,
    imagenPath = null,
    delayMinSeg = 10,
    delayMaxSeg = 25,
    tamanoTanda = 30,
    pausaTandaMin = 15,
    onProgreso = () => {},
    onLog = () => {},
  } = config

  if (!isConnected || !sock) {
    throw new Error('WhatsApp no está conectado. Llama a conectar() primero.')
  }

  if (!variaciones || variaciones.length === 0) {
    throw new Error('Debes proveer al menos una variación de mensaje.')
  }

  const resultados = []
  let enviados = 0
  let fallidos = 0

  console.log(`\n[DIFUSIÓN] Iniciando campaña para ${contactos.length} contactos`)
  console.log(`[DIFUSIÓN] Variaciones disponibles: ${variaciones.length}`)
  console.log(`[DIFUSIÓN] Delay: ${delayMinSeg}-${delayMaxSeg}s | Tanda: ${tamanoTanda} | Pausa: ${pausaTandaMin}min\n`)

  for (let i = 0; i < contactos.length; i++) {
    const cliente = contactos[i]
    const esUltimoDeTanda = (i + 1) % tamanoTanda === 0 && i + 1 < contactos.length

    // Seleccionar variación de forma rotatoria (no completamente aleatoria
    // para asegurar que todas las versiones se usen de forma pareja)
    const variacion = variaciones[i % variaciones.length]

    // Reemplazar variables con datos reales del cliente
    const mensajeFinal = reemplazarVariables(variacion, cliente)

    const logItem = {
      indice: i + 1,
      total: contactos.length,
      nombre: cliente.nombre,
      numero: cliente.whatsapp,
      mensaje: mensajeFinal,
      timestamp: new Date().toISOString(),
      estado: null,
      error: null,
    }

    try {
      console.log(`[${i + 1}/${contactos.length}] Enviando a ${cliente.nombre} (${cliente.whatsapp})...`)
      await enviarMensaje(cliente.whatsapp, mensajeFinal, imagenPath)

      logItem.estado = 'enviado'
      enviados++
      console.log(`  ✅ Enviado a ${cliente.nombre}`)

    } catch (err) {
      logItem.estado = 'error'
      logItem.error = err.message
      fallidos++
      console.error(`  ❌ Error con ${cliente.nombre}: ${err.message}`)
    }

    resultados.push(logItem)
    onLog(logItem)
    onProgreso({
      actual: i + 1,
      total: contactos.length,
      enviados,
      fallidos,
      porcentaje: Math.round(((i + 1) / contactos.length) * 100),
    })

    // Pausa entre tandas
    if (esUltimoDeTanda) {
      const pausaMs = pausaTandaMin * 60 * 1000
      console.log(`\n[TANDA] Pausa de ${pausaTandaMin} minutos antes de la siguiente tanda...\n`)
      await new Promise(resolve => setTimeout(resolve, pausaMs))
      continue
    }

    // Delay aleatorio entre mensajes (no aplica al último)
    if (i < contactos.length - 1) {
      await delayAleatorio(delayMinSeg, delayMaxSeg)
    }
  }

  console.log(`\n[DIFUSIÓN] ✅ Campaña completada`)
  console.log(`  Enviados: ${enviados} | Fallidos: ${fallidos}`)

  return { enviados, fallidos, resultados }
}

export { isConnected }
