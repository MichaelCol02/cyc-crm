# MEMORIA CYC CRM — Carnes y Carnes
> Archivo de recuperación y referencia completa del sistema.
> Actualizar cada vez que haya cambios estructurales importantes.

---

## 🌐 Despliegue

| Campo | Valor |
|-------|-------|
| URL producción | https://cyc-crm.onrender.com |
| Plataforma | Render.com (plan Free) |
| Servicio ID | srv-d7f80lcvikkc73as2aqg |
| Repo GitHub | https://github.com/MichaelCol02/cyc-crm |
| Auto-deploy | Sí — push a `main` = deploy automático |
| Disk montado | `/opt/render/project/src/data` |

---

## 🗂️ Estructura de archivos

```
CYC/
├── server.js              # Servidor Express principal
├── call center.js         # Módulo Baileys (WhatsApp)
├── package.json
├── render.yaml            # Config Render (disk, env)
├── .env                   # Variables locales (NO subir a git)
├── public/
│   ├── index.html         # SPA completa (todo el frontend)
│   ├── clientes.json      # Base HORECA 292 clientes
│   ├── extras.json        # Notas/seguimientos iniciales
│   └── sw.js              # Service Worker PWA
└── data/                  # Persistencia (Render disk)
    ├── clientes.json
    ├── ventas.json
    ├── campaigns.json
    ├── contactos_b2c.json
    ├── plantillas_custom.json
    ├── agenda.json
    ├── agenda_log.json
    └── backups/
        └── YYYY-MM-DD/    # Backups diarios 2am
```

---

## 🔑 Variables de entorno (Render)

| Variable | Descripción |
|----------|-------------|
| `CYC_SECRET` | Token base de autenticación |
| `ADMIN_PIN` | PIN de Admin Mike (2000) |
| `PIN_FOODSERVICE` | PIN Food Service (default: 1001) |
| `PIN_CALLCENTER` | PIN Call Center (default: 2002) |
| `PIN_PUNTOSVENTA` | PIN Puntos de Venta (default: 3003) |
| `PIN_PAUTAS` | PIN Pautas (default: 4004) |
| `DATA_DIR` | `/opt/render/project/src/data` |
| `ANTHROPIC_API_KEY` | Claude Haiku (Bot IA) |
| `EMAIL_USER` | Gmail para notificaciones |
| `EMAIL_PASS` | App password Gmail |
| `PORT` | 3000 (Render lo asigna) |

---

## 👥 Perfiles de acceso

| Perfil | PIN | Tabs disponibles |
|--------|-----|-----------------|
| 🥩 Food Service | 1001 | Clientes, Dashboard, Masiva WA, Agenda, Bot, Config |
| 📞 Call Center | 2002 | Dashboard, Masiva WA (B2C), Bot, Config |
| 🏪 Puntos de Venta | 3003 | Ventas, Dashboard, Config |
| 📣 Pautas | 4004 | Dashboard, Masiva WA, Config |
| 🔐 Admin Mike | **2000** | TODO + Admin Mike (tab exclusivo) |

> **Admin Mike** no aparece en la pantalla de login. El PIN 2000 funciona desde cualquier área.

---

## 🏗️ Stack técnico

- **Runtime**: Node.js 18+ / Express 4
- **WhatsApp**: @whiskeysockets/baileys (autenticación multi-file)
- **Bot IA**: Anthropic SDK → Claude Haiku
- **Scheduler**: node-schedule (agenda 8am, backup 2am Colombia)
- **Real-time**: SSE (Server-Sent Events) en `/api/eventos`
- **Frontend**: SPA Vanilla JS (sin frameworks), dark mode, PWA
- **Storage**: JSON files en disk Render + localStorage + Firebase (opcional)

---

## 📡 API Endpoints principales

### Auth
- `POST /api/auth/login` — `{ pin, perfil }` → `{ token, isAdmin, rol, tabs }`
- `POST /api/auth/logout`

### WhatsApp
- `GET /api/wa-status` — estado conexión
- `GET /api/qr` — QR actual
- `POST /api/masiva` — envío masivo
- `POST /api/masiva/stop` — parar envío
- `GET /api/wa-contacts` — contactos del celular vinculado

### Clientes HORECA
- `GET /api/clientes` — lista completa
- `PUT /api/clientes` — guardar todo el estado (clients, states, notes, etc.)

### Ventas
- `GET /api/ventas` — lista
- `POST /api/ventas` — nueva venta
- `DELETE /api/ventas/:id`
- `GET /api/ventas/kpis` — KPIs del mes

### B2C (Contactos WA)
- `GET /api/b2c` — lista
- `POST /api/b2c/importar` — importar array
- `PUT /api/b2c/:id`
- `DELETE /api/b2c/:id`
- `DELETE /api/b2c/todos`
- `GET /api/b2c/export.csv`

### Campañas
- `GET /api/campaigns`
- `POST /api/campaigns`
- `PUT /api/campaigns/:id`
- `DELETE /api/campaigns/:id`

### Plantillas personalizadas
- `GET /api/plantillas`
- `POST /api/plantillas`
- `PUT /api/plantillas/:id`
- `DELETE /api/plantillas/:id`

### Agenda
- `GET /api/agenda`
- `PUT /api/agenda/:id`
- `POST /api/agenda/ejecutar`

### Admin (solo token admin)
- `GET /api/admin/contactos`
- `GET /api/admin/export.csv`
- `DELETE /api/admin/contactos`

### Sistema
- `GET /api/status`
- `GET /api/eventos` — SSE stream
- `POST /api/backup`
- `GET /api/backup/lista`
- `GET /api/memoria` — descarga JSON completo de recuperación

---

## 🔄 Flujo de datos

```
Usuario → Login (PIN + Rol) → Token sesión
Token → x-cyc-token header en cada /api/*
SSE /api/eventos → push tiempo real al frontend
Cada 2 min + visibilitychange → syncApp() refresca datos activos
```

---

## 📦 Módulos del frontend

| Módulo | Función |
|--------|---------|
| `renderStats()` | Dashboard KPIs + pipeline HORECA |
| `renderVentas()` | Registro y tabla de pedidos |
| `renderMasivaContent()` | WhatsApp masivo HORECA + B2C |
| `renderCampaigns()` | Campañas automáticas CRUD |
| `renderAgenda()` | Calendario seguimiento |
| `renderBot()` | Bot IA Claude Haiku |
| `renderConfig()` | Config Firebase, backup, empresa |
| `renderAdmin()` | Admin Mike — todos los contactos B2C |
| `abrirTplModal()` | CRUD plantillas WA personalizadas |
| `syncApp()` | Refresco automático de datos activos |

---

## 🚨 Recuperación de emergencia

1. **Descargar Memoria**: `GET /api/memoria` — JSON con TODOS los datos
2. **Ver backups**: Config → "📂 Ver backups" — backups diarios 30 días
3. **Reimportar clientes**: Config → "📥 Importar clientes (JSON)"
4. **Re-vincular WhatsApp**: Masiva WA → "📷 Ver código QR"
5. **Reset completo**: Borrar disk en Render → reimportar desde backup

---

## 📊 Datos del negocio

- **Empresa**: Carnes y Carnes — Bucaramanga, Santander
- **Web**: carnesycarnes.com
- **WhatsApp**: +57 318 578 0344
- **Clientes HORECA**: 292 activos
- **Productos**: 100+ (Shopify)
- **Puntos de venta**: 22 (3 propios + 11 aliados + domicilio)
- **Segmentos**: VIP, Frecuente, Distribuidor, Parrillero, Fitness, HORECA, Nuevo, Inactivo

---

*Última actualización: 2026-05-06*
*Responsable: Mike — michael2colmenares@gmail.com*
