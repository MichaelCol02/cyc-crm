// ══════════════════════════════════════════════════════════════════════
//  CYC CRM — Servidor principal  v2
//  Express + Baileys + Claude Haiku + Scheduler + Email
// ══════════════════════════════════════════════════════════════════════

import 'dotenv/config';
import express        from 'express';
import path           from 'path';
import fs             from 'fs';
import { fileURLToPath } from 'url';
import QRCode         from 'qrcode';
import Anthropic      from '@anthropic-ai/sdk';
import nodemailer     from 'nodemailer';
import schedule       from 'node-schedule';
import { conectar, ejecutarDifusion } from './call center.js';

process.on('uncaughtException',  err => console.error('[ERROR] Excepción no capturada:', err.message));
process.on('unhandledRejection', err => console.error('[ERROR] Promesa rechazada:', err?.message || err));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

// ── Seguridad: token de sesión ────────────────────────────────────────
// Se genera al arrancar el servidor. El frontend lo recibe al hacer login
// y lo adjunta en cada llamada a /api/*
const CYC_SECRET = process.env.CYC_SECRET || 'cyccrm_dev';
// Token válido = cualquier string que empiece con CYC_SECRET
// Así los tokens sobreviven reinicios del servidor sin necesidad de re-login
function requireAuth(req, res, next) {
  const tok = req.headers['x-cyc-token'] || req.query._t;
  if (!tok || !tok.startsWith(CYC_SECRET)) {
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  }
  next();
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Persistencia ──────────────────────────────────────────────────────
// DATA_DIR: en Railway apunta al volumen persistente (/data), localmente usa __dirname
const DATA_DIR      = process.env.DATA_DIR || __dirname;
const AGENDA_FILE   = path.join(DATA_DIR, 'agenda.json');
const LOG_FILE      = path.join(DATA_DIR, 'agenda_log.json');
const CLIENTES_FILE = path.join(DATA_DIR, 'clientes.json');
const CAMPAIGNS_FILE= path.join(DATA_DIR, 'campaigns.json');
const VENTAS_FILE   = path.join(DATA_DIR, 'ventas.json');
const BACKUP_DIR    = path.join(DATA_DIR, 'backups');
// Render monta /data automáticamente — solo intentamos crear subdirectorios
try { if (!fs.existsSync(DATA_DIR))   fs.mkdirSync(DATA_DIR,   { recursive: true }); } catch(_) {}
try { if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch(_) {}

function leerAgenda()     { try { return JSON.parse(fs.readFileSync(AGENDA_FILE,'utf8')); } catch { return {}; } }
function guardarAgenda(d) { fs.writeFileSync(AGENDA_FILE, JSON.stringify(d,null,2)); }
function leerLog()        { try { return JSON.parse(fs.readFileSync(LOG_FILE,'utf8')); } catch { return []; } }
function leerClientes()   { try { return JSON.parse(fs.readFileSync(CLIENTES_FILE,'utf8')); } catch { return { clients:[], states:{}, carnes:{} }; } }
function leerCampaigns()  { try { return JSON.parse(fs.readFileSync(CAMPAIGNS_FILE,'utf8')); } catch { return []; } }
function guardarCampaigns(d) { fs.writeFileSync(CAMPAIGNS_FILE, JSON.stringify(d,null,2)); }
function leerVentas()     { try { return JSON.parse(fs.readFileSync(VENTAS_FILE,'utf8')); }  catch { return []; } }
function guardarVentas(d) { fs.writeFileSync(VENTAS_FILE, JSON.stringify(d,null,2)); }

const B2C_FILE = path.join(DATA_DIR, 'contactos_b2c.json');
function leerB2C()     { try { return JSON.parse(fs.readFileSync(B2C_FILE,'utf8')); } catch { return []; } }
function guardarB2C(d) { fs.writeFileSync(B2C_FILE, JSON.stringify(d,null,2)); }

function agregarLog(item) {
  const log = leerLog();
  log.unshift({ ...item, ts: new Date().toISOString() });
  fs.writeFileSync(LOG_FILE, JSON.stringify(log.slice(0,500),null,2));
}

// ── Backup automático ─────────────────────────────────────────────────
function hacerBackup() {
  const fecha = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dir   = path.join(BACKUP_DIR, fecha);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const archivos = [AGENDA_FILE, LOG_FILE, CLIENTES_FILE, CAMPAIGNS_FILE, VENTAS_FILE, B2C_FILE];
  let copiados = 0;
  archivos.forEach(f => {
    if (fs.existsSync(f)) {
      const dest = path.join(dir, path.basename(f));
      fs.copyFileSync(f, dest);
      copiados++;
    }
  });

  // Guardar también un snapshot del CRM (index.html)
  const htmlSrc = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(htmlSrc)) fs.copyFileSync(htmlSrc, path.join(dir, 'index.html'));

  // Limpiar backups viejos (mantener últimos 30 días)
  try {
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    if (backups.length > 30) {
      backups.slice(0, backups.length - 30).forEach(d => {
        fs.rmSync(path.join(BACKUP_DIR, d), { recursive: true, force: true });
      });
    }
  } catch {}

  console.log(`[BACKUP] ✅ ${fecha} — ${copiados} archivos + index.html copiados`);
  return { fecha, copiados };
}

// ── Estado global ─────────────────────────────────────────────────────
let qrBase64       = null;
let waConectado    = false;
let difusionActiva = false;
let progreso       = null;
let sseClients     = [];
const historial    = {};   // historial bot en memoria por número

// ── Anthropic ─────────────────────────────────────────────────────────
const claude = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// ── Nodemailer ────────────────────────────────────────────────────────
const mailer = (process.env.EMAIL_USER && process.env.EMAIL_PASS)
  ? nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE || 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    })
  : null;

// ── Bot prompt ────────────────────────────────────────────────────────
const BOT_PROMPT = `Eres el asistente comercial de *Carnes y Carnes*, distribuidora de carnes premium en Bucaramanga, Santander, Colombia.
Slogan: "Complacemos tu gusto cada día". Web: https://carnesycarnes.com

EMPRESA:
- Ganado 100% alimentado con pasto, cortes madurados, trazabilidad certificada
- 3 tiendas propias + 11 aliados (MXM, Despensa Popular, Autoservicio La Quinta)
- 22 puntos de venta en Santander
- WhatsApp: +57 318 578 0344 | Tel: +57 320 233 3333
- Horario: Lunes–Sábado 8am–9pm | Domingo 8am–8pm
- Envío: GRATIS en pedidos >$60.000 | $3.000 si es menor

CATÁLOGO REAL (precios en COP, actualizado abril 2026):

RES — CORTES PREMIUM:
Lomo Fino $130.374 · Medallones Lomo Fino $47.226 · Chata/Churrasco Premium x3LBS $95.706 · Punta de Anca x3LBS $103.242 · Punta de anca porcionada x2 $38.182 · Rib Eye Hueso Corto $33.770 · Rib Eye Hueso Largo $32.233 · T-Bone $37.870 · Entrecort Premium $28.509 · Pincho de Lomo Fino $30.746 · Lomo Ancho $24.869 · Bife Parrillero $27.108

RES — PARA ASAR/FREÍR:
Cadera $24.115 · Cecina $24.115 · Carabella $22.550 · Carne para asar/freír $22.357 · Bota de res $22.357 · Fajitas $24.939 · Goulash $24.939 · Tira de asado $22.389 · Tira de asado especial $48.068 · Capon Muchacho $21.603 · Carne Oreada $24.750 · Brochetas mixtas x3 $33.500

RES — PARA GUISAR/SUDAR:
Carne para desmechar $19.422 · Carne desmechada $22.015 · Sobrebarriga $60.588 · Murillo $17.884 · Paletero $18.756 · Cogote $18.397 · Colas x1kg $18.950 · Carne para guisar $19.422

RES — MOLIDA Y COSTILLA:
Molida especial x600g $25.422 · Carne Molida 98/2 $23.521 · Molida x450g $12.812 · Costilla de res $13.272/lb

RES — BOXES:
Box Familiar $231.900 · Combo Pack Familiar $105.000 · Duo Pack Familiar $31.000

CERDO:
Lomo de Cerdo $25.450 · Lomo cerdo porcionado $12.950 · Costilla ahumada $22.450 · Costillas $14.900 · Chuleta pierna $10.950 · Tocineta $11.250 · Tocino $8.950 · Bondiola $17.500 · Pernil $10.250 · Chicharroncito $9.950

POLLO:
Pechuga $11.900 · Pechuga Claripack $62.800 · Filete pechuga x500g $9.400 · Pollo entero $17.500 · Contramuslo x1kg $11.350 · Muslo x1kg $8.900 · Alas x1kg $8.700 · Apanado x1kg $16.850 · Nuggets x1kg $17.250

CHARCUTERÍA:
Hamburguesa Premium x5 $8.800 · Chorizo Premium x5 $8.400 · Longaniza x5 $7.700 · Salchicha x5 $8.000 · Morcilla x5 $7.500 · Jamón cerdo $6.350 · Salchichón Cervecero $5.450

MAR:
Camarón 36/40 500g $28.600 · Trucha x500g $25.300 · Tilapia x1kg $23.200 · Pulpo x400g $26.300 · Salmón x180g $16.450 · Cazuela mariscos $15.100 · Calamares $15.100

COMPLEMENTARIOS (para parrilla):
Carbón 2.5kg $14.400 · Arepa Santandereana x5 $8.000 · Cebollitas Ocaneras $10.800 · Salsa BBQ $7.200 · Chimichurri $5.000 · Guacamole $5.000 · Mermelada de cebolla $6.800 · Hogao $7.200 · Romero Fresco $3.400

COMBO ESPECIAL:
Combo Pa' Picar $71.730

REGLAS DE RESPUESTA:
1. Máximo 3 oraciones, lenguaje amable y colombiano (tuteo)
2. No inventes precios que no estén en la lista
3. Si preguntan por un producto no listado: "Ese producto no lo manejamos actualmente, pero puedo recomendarte una alternativa"
4. Si piden cotización o pedido: "¡Perfecto! Un asesor de Carnes y Carnes los contactará para coordinar el despacho. ¿Cuál sería la cantidad aproximada?"
5. Si es cliente HORECA (restaurante/hotel): preguntar por volumen en kilos y frecuencia de pedido
6. Mencionar envío gratis >$60.000 cuando sea relevante`;


// ══════════════════════════════════════════════════════════════════════
//  SSE — Server-Sent Events
// ══════════════════════════════════════════════════════════════════════
function notificarSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(res => {
    try { res.write(payload); return true; } catch { return false; }
  });
}

// Heartbeat cada 25s para mantener conexiones SSE vivas
setInterval(() => {
  sseClients = sseClients.filter(res => {
    try { res.write(': ping\n\n'); return true; } catch { return false; }
  });
}, 25000);

// ══════════════════════════════════════════════════════════════════════
//  WHATSAPP
// ══════════════════════════════════════════════════════════════════════
// ── Auto-importar contactos de WA al conectarse ───────────────────────
function autoImportarContactosWA() {
  const contactsFile = path.join(DATA_DIR, 'auth', 'contacts.json');
  try {
    if (!fs.existsSync(contactsFile)) return;
    const raw = JSON.parse(fs.readFileSync(contactsFile, 'utf8'));
    const existing   = leerB2C();
    const existPhones = new Set(existing.map(c => c.phone));
    const nuevos = [];
    const batch  = Date.now().toString(36);
    for (const [jid, data] of Object.entries(raw)) {
      if (!jid || jid.includes('@g.us') || jid.includes('broadcast') || jid.includes('status@')) continue;
      const phone = jid.split('@')[0].replace(/\D/g, '');
      if (!phone || phone.length < 7 || existPhones.has(phone)) continue;
      const name = data.name || data.pushName || data.verifiedName || phone;
      nuevos.push({
        id:        batch + '_' + Math.random().toString(36).slice(2, 6),
        name:      String(name).trim() || phone,
        phone,
        city:      '',
        stage:     'pending',
        source:    'wa_auto',
        importedAt: new Date().toISOString(),
      });
      existPhones.add(phone);
    }
    if (nuevos.length) {
      guardarB2C([...existing, ...nuevos]);
      console.log(`[AUTO-IMPORT] ✅ ${nuevos.length} contactos importados de WhatsApp`);
      notificarSSE({ tipo: 'b2c_update', total: existing.length + nuevos.length, nuevos: nuevos.length });
    } else {
      console.log('[AUTO-IMPORT] Sin contactos nuevos que importar');
    }
  } catch (err) {
    console.error('[AUTO-IMPORT] Error:', err.message);
  }
}

console.log('🔌 Iniciando conexión WhatsApp...');
conectar(
  async (qr) => {
    try { qrBase64 = await QRCode.toDataURL(qr); } catch (_) {}
    waConectado = false;
    console.log('📱 QR listo — abre el CRM y escanea');
    notificarSSE({ tipo: 'qr', qr: qrBase64 });
  },
  () => {
    waConectado = true;
    qrBase64    = null;
    console.log('✅ WhatsApp conectado');
    notificarSSE({ tipo: 'wa_conectado' });
    // Auto-importar contactos 90s después de conectar (tiempo para que Baileys sincronice)
    setTimeout(autoImportarContactosWA, 90000);
  }
).catch(err => {
  console.error('❌ Error iniciando WhatsApp:', err.message);
});

// ── Enviar un mensaje individual por WhatsApp ─────────────────────────
async function enviarWA(numero, texto) {
  if (!waConectado) throw new Error('WhatsApp no conectado');
  const num = String(numero).replace(/\D/g,'').replace(/^0/,'57');
  await ejecutarDifusion({
    contactos: [{ nombre:'', whatsapp: num }],
    variaciones: [texto],
    delayMinSeg: 0, delayMaxSeg: 0,
    tamanoTanda: 1, pausaTandaMin: 0,
  });
}

// ══════════════════════════════════════════════════════════════════════
//  SCHEDULER — 8am Colombia (UTC-5 = 13:00 UTC)
// ══════════════════════════════════════════════════════════════════════
// Agenda diaria 8am Colombia (13:00 UTC)
schedule.scheduleJob('0 13 * * *', async () => {
  console.log('\n⏰ Scheduler — verificando clientes a contactar...');
  const n = await ejecutarPendientesHoy();
  console.log(`✅ Scheduler completado — ${n} enviados`);
});

// Backup automático 2am Colombia (07:00 UTC)
schedule.scheduleJob('0 7 * * *', () => hacerBackup());

async function ejecutarPendientesHoy() {
  const agenda = leerAgenda();
  const hoy    = new Date().toISOString().slice(0, 10);
  let enviados = 0;

  for (const [clienteId, prog] of Object.entries(agenda)) {
    if (!prog.activo)                  continue;
    if (prog.proximo_contacto !== hoy) continue;

    try {
      await enviarContactoAutomatico(clienteId, prog);
      prog.proximo_contacto = calcularProximo(hoy, prog.frecuencia);
      prog.ultimo_contacto  = hoy;
      guardarAgenda(agenda);
      notificarSSE({ tipo: 'agenda_enviado', clienteId, nombre: prog.nombre, canal: prog.canal, proximo: prog.proximo_contacto });
      agregarLog({ clienteId, nombre: prog.nombre, canal: prog.canal, estado: 'enviado', proximo: prog.proximo_contacto });
      enviados++;
    } catch (err) {
      console.error(`❌ Error contactando a ${prog.nombre}:`, err.message);
      agregarLog({ clienteId, nombre: prog.nombre, canal: prog.canal, estado: 'error', error: err.message });
      notificarSSE({ tipo: 'agenda_error', clienteId, nombre: prog.nombre, error: err.message });
    }
  }
  return enviados;
}

async function enviarContactoAutomatico(clienteId, prog) {
  const msg = construirMensaje(prog);
  const errores = [];

  if (prog.canal === 'whatsapp' || prog.canal === 'ambos') {
    if (!waConectado) {
      errores.push('WhatsApp no conectado');
    } else if (!prog.telefono) {
      errores.push('Sin número de teléfono');
    } else {
      try { await enviarWA(prog.telefono, msg.whatsapp); } catch (e) { errores.push('WA: '+e.message); }
    }
  }

  if (prog.canal === 'email' || prog.canal === 'ambos') {
    if (!mailer) {
      errores.push('Email no configurado');
    } else if (!prog.email) {
      errores.push('Sin email');
    } else {
      try {
        await mailer.sendMail({
          from:    `"Carnes y Carnes" <${process.env.EMAIL_USER}>`,
          to:      prog.email,
          subject: msg.emailAsunto,
          html:    msg.emailHtml,
        });
      } catch (e) { errores.push('Email: '+e.message); }
    }
  }

  if (errores.length && (prog.canal !== 'ambos' || errores.length === 2)) {
    throw new Error(errores.join(' | '));
  }
  return { ok: true };
}

function construirMensaje(prog) {
  const nombre   = prog.nombre   || 'estimado cliente';
  const producto = prog.producto || 'nuestros productos';
  const freq     = { semanal:'esta semana', quincenal:'esta quincena', mensual:'este mes', bimestral:'este bimestre' }[prog.frecuencia] || 'pronto';

  const whatsapp = prog.mensaje_personalizado ||
    `¡Hola ${nombre}! 🥩 Te escribimos desde *Carnes y Carnes* para coordinar tu pedido de *${producto}* ${freq}.\n\n¿Cuánto necesitas esta vez? Recuerda que domicilio gratis en pedidos mayores a $60.000 🚚\n\nwww.carnesycarnes.com`;

  const emailHtml = `
  <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #eee;">
    <div style="background:#C62828;padding:20px;text-align:center;">
      <h1 style="color:#fff;margin:0;font-size:22px;">🥩 Carnes y Carnes</h1>
      <p style="color:#ffcdd2;margin:4px 0 0 0;font-size:13px;">"Complacemos tu gusto cada día"</p>
    </div>
    <div style="padding:24px;">
      <p>Hola <strong>${nombre}</strong>,</p>
      <p>Es tiempo de tu pedido de <strong>${producto}</strong> ${freq}. Estamos listos para preparar tu despacho con la calidad premium que nos caracteriza.</p>
      <div style="background:#fff8f8;border-left:4px solid #C62828;padding:12px 16px;margin:16px 0;border-radius:4px;">
        <strong>🚚 Envío gratis</strong> en pedidos mayores a $60.000 COP<br>
        <strong>📞</strong> +57 318 578 0344 | +57 320 233 3333<br>
        <strong>🕗</strong> L-S 8am–9pm | Dom 8am–8pm
      </div>
      <a href="https://www.carnesycarnes.com" style="display:inline-block;background:#C62828;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Ver catálogo completo</a>
    </div>
    <div style="background:#f5f5f5;padding:12px;text-align:center;font-size:11px;color:#999;">
      Carnes y Carnes · Bucaramanga, Santander · www.carnesycarnes.com
    </div>
  </div>`;

  return {
    whatsapp,
    emailAsunto: `🥩 Tu pedido de ${producto} — Carnes y Carnes`,
    emailHtml,
  };
}

function calcularProximo(desde, frecuencia) {
  const d = new Date(desde + 'T12:00:00');
  const dias = { semanal:7, quincenal:14, mensual:30, bimestral:60 }[frecuencia] || 30;
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

// ══════════════════════════════════════════════════════════════════════
//  ENDPOINTS
// ══════════════════════════════════════════════════════════════════════

// ── Auth (no requiere token — es el punto de entrada) ─────────────────
const CYC_PINS    = (process.env.CYC_PINS || '1234,admin').split(',').map(p => p.trim());
const ADMIN_PIN   = process.env.ADMIN_PIN || '2000';
const ADMIN_PFX   = CYC_SECRET + '_ADMIN_';

function requireAdmin(req, res, next) {
  const tok = req.headers['x-cyc-token'] || req.query._t;
  if (!tok || !tok.startsWith(ADMIN_PFX)) {
    return res.status(403).json({ ok: false, error: 'Acceso denegado' });
  }
  next();
}

app.post('/api/auth/login', (req, res) => {
  const { pin } = req.body;
  const pinStr = String(pin || '');
  const esAdmin = pinStr === ADMIN_PIN;
  if (!esAdmin && !CYC_PINS.includes(pinStr)) {
    return res.status(401).json({ ok: false, error: 'PIN incorrecto' });
  }
  const pfx = esAdmin ? ADMIN_PFX : (CYC_SECRET + '_');
  const tok  = pfx + pinStr + '_' + Date.now().toString(36);
  res.json({ ok: true, token: tok, isAdmin: esAdmin });
});

app.post('/api/auth/logout', (req, res) => {
  res.json({ ok: true });
});

// ── Backup manual ──────────────────────────────────────────────────────
app.post('/api/backup', requireAuth, (req, res) => {
  const result = hacerBackup();
  res.json({ ok: true, ...result });
});

app.get('/api/backup/lista', requireAuth, (req, res) => {
  try {
    const dirs = fs.readdirSync(BACKUP_DIR)
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort().reverse().slice(0, 30)
      .map(d => {
        const files = fs.readdirSync(path.join(BACKUP_DIR, d));
        const size  = files.reduce((acc, f) => {
          try { return acc + fs.statSync(path.join(BACKUP_DIR, d, f)).size; } catch { return acc; }
        }, 0);
        return { fecha: d, archivos: files.length, kb: Math.round(size/1024) };
      });
    res.json({ ok: true, backups: dirs });
  } catch (e) { res.json({ ok: true, backups: [] }); }
});

// ── Aplicar requireAuth a todas las rutas /api/* restantes ────────────
app.use('/api', requireAuth);

// ── Status ────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const agenda   = leerAgenda();
  const hoy      = new Date().toISOString().slice(0, 10);
  const pendHoy  = Object.values(agenda).filter(p => p.activo && p.proximo_contacto === hoy).length;
  const totalProg = Object.values(agenda).filter(p => p.activo).length;
  res.json({
    whatsapp:       waConectado ? 'conectado' : (qrBase64 ? 'qr_pendiente' : 'desconectado'),
    difusion:       difusionActiva,
    progreso,
    bot:            !!claude,
    email:          !!mailer,
    emailUser:      process.env.EMAIL_USER || null,
    pendientesHoy:  pendHoy,
    totalProgramados: totalProg,
    timestamp:      new Date().toISOString(),
  });
});

// ── QR ────────────────────────────────────────────────────────────────
app.get('/api/qr', (req, res) => {
  if (!qrBase64) return res.json({ ok: false, msg: waConectado ? 'ya_conectado' : 'sin_qr' });
  res.json({ ok: true, qr: qrBase64 });
});

// ── SSE ───────────────────────────────────────────────────────────────
app.get('/api/eventos', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Estado inicial
  const estado = waConectado ? 'wa_conectado' : (qrBase64 ? 'qr' : 'esperando');
  res.write(`data: ${JSON.stringify({ tipo: estado, qr: qrBase64 })}\n\n`);

  sseClients.push(res);

  // Heartbeat individual para este cliente
  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(hb); }
  }, 20000);

  req.on('close', () => {
    clearInterval(hb);
    sseClients = sseClients.filter(c => c !== res);
  });
});

// ── Agenda ────────────────────────────────────────────────────────────
app.get('/api/agenda/hoy', (req, res) => {
  const agenda = leerAgenda();
  const hoy    = new Date().toISOString().slice(0, 10);
  const pend   = Object.entries(agenda)
    .filter(([, p]) => p.activo && p.proximo_contacto === hoy)
    .map(([id, p]) => ({ clienteId: id, ...p }));
  res.json({ ok: true, pendientes: pend, hoy });
});

app.get('/api/agenda/todos', (req, res) => {
  const agenda = leerAgenda();
  const lista  = Object.entries(agenda).map(([id, p]) => ({ clienteId: id, ...p }));
  res.json({ ok: true, agenda: lista });
});

app.get('/api/agenda/log', (req, res) => {
  res.json({ ok: true, log: leerLog().slice(0, 100) });
});

app.post('/api/agenda/guardar', (req, res) => {
  const { clienteId, nombre, telefono, email, frecuencia, canal, producto, mensaje_personalizado } = req.body;
  if (!clienteId) return res.status(400).json({ ok: false, error: 'clienteId requerido' });

  const agenda  = leerAgenda();
  const hoy     = new Date().toISOString().slice(0, 10);
  const existe  = agenda[clienteId] || {};

  agenda[clienteId] = {
    nombre:              nombre   || existe.nombre   || '',
    telefono:            telefono || existe.telefono || '',
    email:               email    || existe.email    || '',
    frecuencia:          frecuencia || existe.frecuencia || 'mensual',
    canal:               canal    || existe.canal    || 'whatsapp',
    producto:            producto || existe.producto || '',
    mensaje_personalizado: mensaje_personalizado || null,
    activo:              true,
    proximo_contacto:    existe.proximo_contacto || calcularProximo(hoy, frecuencia || 'mensual'),
    ultimo_contacto:     existe.ultimo_contacto  || null,
    creado:              existe.creado || hoy,
  };

  guardarAgenda(agenda);
  res.json({ ok: true, proximo: agenda[clienteId].proximo_contacto });
});

app.delete('/api/agenda/:clienteId', (req, res) => {
  const agenda = leerAgenda();
  delete agenda[req.params.clienteId];
  guardarAgenda(agenda);
  res.json({ ok: true });
});

app.post('/api/agenda/ejecutar', async (req, res) => {
  if (difusionActiva) return res.status(409).json({ ok: false, error: 'Difusión activa, espera que termine' });
  res.json({ ok: true, msg: 'Ejecutando — recibirás notificaciones por SSE' });
  try {
    const n = await ejecutarPendientesHoy();
    notificarSSE({ tipo: 'agenda_ejecutada', enviados: n });
  } catch (err) {
    notificarSSE({ tipo: 'agenda_error', error: err.message });
  }
});

app.post('/api/agenda/probar', async (req, res) => {
  const { clienteId } = req.body;
  if (!clienteId) return res.status(400).json({ ok: false, error: 'clienteId requerido' });
  const agenda = leerAgenda();
  const prog   = agenda[clienteId];
  if (!prog) return res.status(404).json({ ok: false, error: 'Cliente no en agenda' });
  try {
    await enviarContactoAutomatico(clienteId, prog);
    agregarLog({ clienteId, nombre: prog.nombre, canal: prog.canal, estado: 'prueba' });
    res.json({ ok: true, msg: 'Mensaje de prueba enviado por '+prog.canal });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── WhatsApp ──────────────────────────────────────────────────────────
app.post('/api/send', async (req, res) => {
  const { numero, texto } = req.body;
  if (!numero || !texto) return res.status(400).json({ ok: false, error: 'numero y texto requeridos' });
  if (!waConectado) return res.status(503).json({ ok: false, error: 'WhatsApp no conectado' });
  try {
    await enviarWA(numero, texto);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/difusion', async (req, res) => {
  if (!waConectado) return res.status(503).json({ ok: false, error: 'WhatsApp no conectado' });
  if (difusionActiva) return res.status(409).json({ ok: false, error: 'Ya hay una campaña activa' });

  const { contactos, variaciones, delayMinSeg=12, delayMaxSeg=25, tamanoTanda=30, pausaTandaMin=15 } = req.body;
  if (!contactos?.length || !variaciones?.length)
    return res.status(400).json({ ok: false, error: 'contactos y variaciones requeridos' });

  difusionActiva = true;
  progreso = { actual:0, total:contactos.length, enviados:0, fallidos:0, porcentaje:0 };
  notificarSSE({ tipo: 'difusion_inicio', total: contactos.length });
  res.json({ ok: true, total: contactos.length });

  try {
    await ejecutarDifusion({
      contactos, variaciones, delayMinSeg, delayMaxSeg, tamanoTanda, pausaTandaMin,
      onProgreso: p => { progreso = p; notificarSSE({ tipo: 'difusion_progreso', ...p }); },
      onLog:      item => notificarSSE({ tipo: 'difusion_log', ...item }),
    });
    notificarSSE({ tipo: 'difusion_fin', ...progreso });
  } catch (err) {
    console.error('Difusión error:', err.message);
    notificarSSE({ tipo: 'difusion_error', error: err.message });
  } finally {
    difusionActiva = false;
    progreso = null;
  }
});

// ── Sync clientes desde frontend ──────────────────────────────────────
app.post('/api/sync-clientes', (req, res) => {
  const { clients, states, carnes, _origen } = req.body;
  if (!Array.isArray(clients)) return res.status(400).json({ ok: false, error: 'clients debe ser array' });
  fs.writeFileSync(CLIENTES_FILE, JSON.stringify({ clients, states: states||{}, carnes: carnes||{} }, null, 2));
  // Notificar a los demás dispositivos conectados por SSE
  notificarDataUpdate({ clients, states: states||{}, carnes: carnes||{}, _origen: _origen || null });
  res.json({ ok: true, total: clients.length });
});

app.get('/api/sync-clientes', (req, res) => {
  res.json({ ok: true, ...leerClientes() });
});

// ── Ventas / Pedidos ─────────────────────────────────────────────────
app.get('/api/ventas', (req, res) => {
  const ventas = leerVentas();
  const { mes } = req.query; // YYYY-MM
  const filtradas = mes ? ventas.filter(v => (v.fecha||'').startsWith(mes)) : ventas;
  res.json({ ok: true, ventas: filtradas });
});

app.post('/api/ventas', (req, res) => {
  const { clienteId, clienteNombre, asesor, canal, estadoPago, items, notas } = req.body;
  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ ok: false, error: 'items requerido' });
  const ventas = leerVentas();
  const total  = items.reduce((s, it) => s + (Number(it.subtotal) || 0), 0);
  const venta  = {
    id:            'vta_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    fecha:         new Date().toISOString().slice(0, 10),
    clienteId:     clienteId  || '',
    clienteNombre: clienteNombre || '',
    asesor:        asesor     || '',
    canal:         canal      || 'call_center',
    estadoPago:    estadoPago || 'pagado',
    items:         items,
    total:         total,
    notas:         notas      || '',
    creado:        new Date().toISOString(),
  };
  ventas.unshift(venta);
  guardarVentas(ventas.slice(0, 5000)); // máx 5000 registros
  notificarSSE({ tipo: 'venta_nueva', venta });
  res.json({ ok: true, venta });
});

app.delete('/api/ventas/:id', (req, res) => {
  const ventas = leerVentas();
  const idx = ventas.findIndex(v => v.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'No encontrada' });
  ventas.splice(idx, 1);
  guardarVentas(ventas);
  res.json({ ok: true });
});

app.get('/api/ventas/kpis', (req, res) => {
  const ventas = leerVentas();
  const mesActual = new Date().toISOString().slice(0, 7);
  const mesPasado = (() => {
    const d = new Date(); d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 7);
  })();
  const ventasMes = ventas.filter(v => (v.fecha||'').startsWith(mesActual));
  const ventasAnt = ventas.filter(v => (v.fecha||'').startsWith(mesPasado));
  const sumTotal  = arr => arr.reduce((s, v) => s + (Number(v.total)||0), 0);
  const countPend = ventas.filter(v => v.estadoPago === 'pendiente').length;

  // Top productos del mes
  const prodMap = {};
  ventasMes.forEach(v => (v.items||[]).forEach(it => {
    prodMap[it.nombre] = (prodMap[it.nombre] || 0) + (Number(it.subtotal)||0);
  }));
  const topProds = Object.entries(prodMap).sort((a,b)=>b[1]-a[1]).slice(0,5)
    .map(([nombre, total]) => ({ nombre, total }));

  res.json({
    ok: true,
    mes: mesActual,
    ventasMes:     ventasMes.length,
    ingresosMes:   sumTotal(ventasMes),
    ventasAnt:     ventasAnt.length,
    ingresosAnt:   sumTotal(ventasAnt),
    totalVentas:   ventas.length,
    pendientes:    countPend,
    topProds,
  });
});

// ── Campañas automáticas ──────────────────────────────────────────────
app.get('/api/campaigns', (req, res) => {
  res.json({ ok: true, campaigns: leerCampaigns() });
});

app.post('/api/campaigns', (req, res) => {
  const { campaigns } = req.body;
  if (!Array.isArray(campaigns)) return res.status(400).json({ ok: false, error: 'campaigns debe ser array' });
  guardarCampaigns(campaigns);
  res.json({ ok: true, total: campaigns.length });
});

app.put('/api/campaigns/:id', (req, res) => {
  const lista = leerCampaigns();
  const idx = lista.findIndex(c => c.id === req.params.id);
  if (idx < 0) return res.json({ ok: false, error: 'No encontrada' });
  lista[idx] = { ...lista[idx], ...req.body, id: req.params.id };
  guardarCampaigns(lista);
  res.json({ ok: true });
});

app.delete('/api/campaigns/:id', (req, res) => {
  guardarCampaigns(leerCampaigns().filter(c => c.id !== req.params.id));
  res.json({ ok: true });
});

// ── Ejecutar campaña automática ────────────────────────────────────────
async function ejecutarCampanaAuto(campana) {
  if (difusionActiva) { console.log(`[CAMPAIGN] Difusión activa — ${campana.nombre} pospuesta`); return; }
  if (!waConectado)   { console.log(`[CAMPAIGN] WA desconectado — ${campana.nombre} omitida`); return; }

  const segmentos = campana.segmentos || ['todos'];
  let contactos = [];

  if (campana.fuente === 'b2c') {
    // Fuente: contactos B2C importados
    const b2c = leerB2C();
    if (!b2c.length) { console.log(`[CAMPAIGN] ${campana.nombre}: sin contactos B2C`); return; }
    const base = b2c.filter(c => {
      const p = String(c.phone || '').replace(/\D/g, '');
      if (!p || p.length < 7) return false;
      if (segmentos.includes('todos')) return true;
      return segmentos.includes(c.stage || 'pending');
    });
    if (!base.length) { console.log(`[CAMPAIGN] ${campana.nombre}: sin contactos B2C para segmentos ${segmentos.join(',')}`); return; }
    contactos = base.map(c => ({
      nombre:       c.name || c.phone,
      whatsapp:     String(c.phone).replace(/\D/g,'').replace(/^0/,'57'),
      producto:     '',
      kg_ultimo:    '',
      fecha_ultimo: '',
      ciudad:       c.city || '',
      direccion:    '',
    }));
  } else {
    // Fuente: clientes HORECA
    const { clients, carnes } = leerClientes();
    if (!clients.length) { console.log(`[CAMPAIGN] Sin clientes HORECA — sincroniza desde el CRM`); return; }
    const base = clients.filter(c => {
      if (!c.telefono) return false;
      if (segmentos.includes('todos')) return true;
      const car = carnes[c.id] || {};
      const pipeline = c.pipeline || 'nuevo';
      return segmentos.some(s => s === pipeline || s === car.segmento);
    });
    if (!base.length) { console.log(`[CAMPAIGN] ${campana.nombre}: sin contactos para segmentos ${segmentos.join(',')}`); return; }
    contactos = base.map(c => {
      const car = carnes[c.id] || {};
      return {
        nombre:       c.nombre || '',
        whatsapp:     c.telefono.replace(/\D/g,'').replace(/^0/,'57'),
        producto:     (car.productos&&car.productos.length) ? car.productos[0] : (car.producto||''),
        kg_ultimo:    car.kg_ultimo || '',
        fecha_ultimo: car.fecha_ultimo || '',
        ciudad:       car.ciudad || c.ciudad || '',
        direccion:    car.direccion || c.direccion || '',
      };
    });
  }

  console.log(`\n[CAMPAIGN] 🚀 ${campana.nombre} → ${contactos.length} contactos`);
  difusionActiva = true;
  progreso = { actual:0, total:contactos.length, enviados:0, fallidos:0, porcentaje:0 };
  notificarSSE({ tipo: 'difusion_inicio', total: contactos.length, campana: campana.nombre });

  try {
    await ejecutarDifusion({
      contactos,
      variaciones: [campana.texto],
      delayMinSeg:  campana.delayMin  || 12,
      delayMaxSeg:  campana.delayMax  || 25,
      tamanoTanda:  campana.tanda     || 30,
      pausaTandaMin:campana.pausaMin  || 15,
      onProgreso: p => { progreso = p; notificarSSE({ tipo: 'difusion_progreso', ...p }); },
      onLog:      item => notificarSSE({ tipo: 'difusion_log', ...item }),
    });
    notificarSSE({ tipo: 'difusion_fin', ...progreso, campana: campana.nombre });
    console.log(`[CAMPAIGN] ✅ ${campana.nombre} completada — ${progreso.enviados} enviados`);
  } catch (err) {
    notificarSSE({ tipo: 'difusion_error', error: err.message });
    console.error(`[CAMPAIGN] ❌ ${campana.nombre} error:`, err.message);
  } finally {
    difusionActiva = false;
    progreso = null;
  }
}

// Scheduler de campañas: revisa cada hora si hay alguna que deba ejecutarse
schedule.scheduleJob('0 * * * *', async () => {
  const campaigns = leerCampaigns();
  const activas = campaigns.filter(c => c.activa);
  if (!activas.length) return;

  const ahora = new Date();
  // Colombia = UTC-5
  const colHour = ((ahora.getUTCHours() - 5) + 24) % 24;
  const colDow  = new Date(ahora.getTime() - 5*3600000).getDay(); // 0=Dom,1=Lun,...
  const dowMap  = { 0:'dom',1:'lun',2:'mar',3:'mie',4:'jue',5:'vie',6:'sab' };
  const diaHoy  = dowMap[colDow];

  for (const c of activas) {
    if (c.hora !== colHour)           continue; // hora no coincide
    if (c.dia && c.dia !== diaHoy)    continue; // día no coincide
    const ultimaEjec = c.ultima_ejecucion ? new Date(c.ultima_ejecucion) : null;
    if (ultimaEjec && (ahora - ultimaEjec) < 3600000) continue; // ya ejecutada esta hora
    console.log(`[CAMPAIGN SCHEDULER] Disparando: ${c.nombre}`);
    c.ultima_ejecucion = ahora.toISOString();
    guardarCampaigns(campaigns);
    ejecutarCampanaAuto(c).catch(e => console.error('[CAMPAIGN SCHEDULER] Error:', e.message));
  }
});

// ── Bot IA ────────────────────────────────────────────────────────────
app.post('/api/bot', async (req, res) => {
  if (!claude) return res.status(503).json({ ok: false, error: 'Falta ANTHROPIC_API_KEY en el archivo .env' });
  const { numero, texto } = req.body;
  if (!texto) return res.status(400).json({ ok: false, error: 'texto requerido' });

  const clave = String(numero || 'test').replace(/\D/g,'') || 'test';
  if (!historial[clave]) historial[clave] = [];
  historial[clave].push({ role: 'user', content: texto });
  // Limitar historial a 12 mensajes (6 intercambios)
  if (historial[clave].length > 12) historial[clave] = historial[clave].slice(-12);

  try {
    const resp = await claude.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 350,
      system:     BOT_PROMPT,
      messages:   historial[clave],
    });
    const respuesta = resp.content[0]?.text || '';
    historial[clave].push({ role: 'assistant', content: respuesta });

    // Enviar respuesta por WA si es número real
    if (waConectado && clave !== 'test' && clave.length >= 10) {
      enviarWA(clave, respuesta).catch(err => console.error('Bot WA send error:', err.message));
    }

    res.json({ ok: true, respuesta });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Obtener IP local de red ───────────────────────────────────────────
import os from 'os';
function getLanIP() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

// ── Notificar cambio de datos a todos los clientes SSE ───────────────
function notificarDataUpdate(data) {
  notificarSSE({ tipo: 'data_update', ...data });
}

// ── Contactos WA (del auth de Baileys) ───────────────────────────────
app.get('/api/wa-contacts', (req, res) => {
  const contactsFile = path.join(DATA_DIR, 'auth', 'contacts.json');
  try {
    if (!fs.existsSync(contactsFile)) {
      return res.json({ ok: true, contactos: [], msg: 'Conecta WhatsApp primero' });
    }
    const raw = JSON.parse(fs.readFileSync(contactsFile, 'utf8'));
    const contactos = [];
    for (const [jid, data] of Object.entries(raw)) {
      if (!jid || jid.includes('@g.us') || jid.includes('broadcast') || jid.includes('status@')) continue;
      const phone = jid.split('@')[0].replace(/\D/g, '');
      if (!phone || phone.length < 7) continue;
      const name = data.name || data.pushName || data.verifiedName || phone;
      contactos.push({ phone, name: String(name).trim() || phone });
    }
    res.json({ ok: true, contactos, total: contactos.length });
  } catch (err) {
    res.json({ ok: true, contactos: [], error: err.message });
  }
});

// ── Contactos B2C (base importada de WA o CSV) ────────────────────────
app.get('/api/b2c', (req, res) => {
  res.json({ ok: true, contactos: leerB2C() });
});

app.post('/api/b2c/importar', (req, res) => {
  const { contactos } = req.body;
  if (!Array.isArray(contactos)) return res.json({ ok: false, error: 'Datos inválidos' });
  const existing = leerB2C();
  const existingPhones = new Set(existing.map(c => c.phone));
  const nuevos = contactos
    .filter(c => {
      const p = String(c.phone || '').replace(/\D/g, '');
      return p.length >= 7 && !existingPhones.has(p);
    })
    .map(c => ({
      id: Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      name: String(c.name || c.phone || '').trim(),
      phone: String(c.phone || '').replace(/\D/g, ''),
      city:  c.city  || '',
      stage: 'pending',
      source: c.source || 'whatsapp',
      createdAt: new Date().toISOString()
    }));
  const todos = [...existing, ...nuevos];
  guardarB2C(todos);
  notificarSSE({ tipo: 'b2c_update', total: todos.length });
  res.json({ ok: true, importados: nuevos.length, total: todos.length });
});

app.put('/api/b2c/:id', (req, res) => {
  const lista = leerB2C();
  const idx = lista.findIndex(c => c.id === req.params.id);
  if (idx < 0) return res.json({ ok: false, error: 'No encontrado' });
  ['name', 'city', 'stage', 'notes'].forEach(k => {
    if (req.body[k] !== undefined) lista[idx][k] = req.body[k];
  });
  guardarB2C(lista);
  res.json({ ok: true });
});

app.delete('/api/b2c/todos', (req, res) => {
  guardarB2C([]);
  res.json({ ok: true });
});

app.delete('/api/b2c/:id', (req, res) => {
  guardarB2C(leerB2C().filter(c => c.id !== req.params.id));
  res.json({ ok: true });
});

app.get('/api/b2c/export.csv', (req, res) => {
  const lista = leerB2C();
  const csv = 'Nombre,Telefono,Ciudad,Etapa\n' +
    lista.map(c =>
      `"${(c.name || '').replace(/"/g, '""')}","${c.phone}","${(c.city || '').replace(/"/g, '""')}","${c.stage || ''}"`
    ).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="contactos_wa.csv"');
  res.send('﻿' + csv);
});

// ── Admin Mike ────────────────────────────────────────────────────────
app.get('/api/admin/contactos', requireAdmin, (req, res) => {
  const lista = leerB2C();
  // Estadísticas por fecha de importación
  const porFecha = {};
  lista.forEach(c => {
    const dia = (c.importedAt || c.createdAt || '').slice(0, 10) || 'sin fecha';
    porFecha[dia] = (porFecha[dia] || 0) + 1;
  });
  const porFuente = {};
  lista.forEach(c => { porFuente[c.source || 'manual'] = (porFuente[c.source || 'manual'] || 0) + 1; });
  res.json({ ok: true, total: lista.length, contactos: lista, porFecha, porFuente });
});

app.get('/api/admin/export.csv', requireAdmin, (req, res) => {
  const lista = leerB2C();
  const csv = 'Nombre,Telefono,Ciudad,Etapa,Fuente,Fecha\n' +
    lista.map(c =>
      `"${(c.name||'').replace(/"/g,'""')}","${c.phone}","${(c.city||'').replace(/"/g,'""')}","${c.stage||''}","${c.source||''}","${(c.importedAt||c.createdAt||'').slice(0,10)}"`
    ).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="admin_contactos_wa.csv"');
  res.send('﻿' + csv);
});

app.delete('/api/admin/contactos', requireAdmin, (req, res) => {
  guardarB2C([]);
  res.json({ ok: true });
});

// ── Start — red local (WiFi) + protección por PIN ─────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const lanIP = getLanIP();
  console.log(`\n🥩 CYC CRM`);
  console.log(`   💻 Este equipo:  http://localhost:${PORT}`);
  console.log(`   📱 Red local:    http://${lanIP}:${PORT}  ← usa esta en celulares/tablets`);
  console.log(`   🔑 PINs:         ${CYC_PINS.length} configurados (ver .env → CYC_PINS)`);
  console.log(`   Bot IA:          ${claude  ? '✅ Claude Haiku' : '❌ Agrega ANTHROPIC_API_KEY en .env'}`);
  console.log(`   Email:           ${mailer  ? '✅ '+process.env.EMAIL_USER : '❌ Agrega EMAIL_USER y EMAIL_PASS en .env'}`);
  console.log(`   Scheduler:       ✅ agenda 8:00am · backup 2:00am Colombia`);
  console.log(`   Backups:         ${BACKUP_DIR}\n`);
  // Backup al arrancar si no existe el de hoy
  const hoy = new Date().toISOString().slice(0,10);
  if (!fs.existsSync(path.join(BACKUP_DIR, hoy))) {
    setTimeout(() => hacerBackup(), 5000);
  }
});
