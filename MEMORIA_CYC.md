# MEMORIA CYC CRM — Carnes y Carnes
> Archivo maestro de recuperación. Actualizado: **2026-05-06**
> Responsable: **Mike** — michael2colmenares@gmail.com

---

## 🌐 Despliegue en producción

| Campo | Valor |
|-------|-------|
| URL | https://cyc-crm.onrender.com |
| Plataforma | Render.com (Free tier) |
| Servicio ID | `srv-d7f80lcvikkc73as2aqg` |
| Repo GitHub | https://github.com/MichaelCol02/cyc-crm |
| Rama activa | `main` |
| Auto-deploy | Push a `main` → Render despliega automáticamente |
| Disk persistente | Montado en `/opt/render/project/src/data` |

---

## 🗂️ Estructura de archivos

```
CYC/                               ← carpeta raíz del proyecto
├── server.js                      ← servidor Express principal (único archivo backend)
├── call center.js                 ← módulo Baileys WhatsApp (conectar, difusión, auto-import)
├── package.json                   ← dependencias Node.js
├── render.yaml                    ← configuración de Render (disk, variables)
├── .env                           ← variables locales (NUNCA subir a git)
├── MEMORIA_CYC.md                 ← este archivo
│
├── public/                        ← archivos estáticos (servidos por Express)
│   ├── index.html                 ← SPA completa — TODO el frontend en un solo archivo
│   ├── clientes.json              ← base HORECA 292 clientes (protegida — requiere token)
│   ├── extras.json                ← notas/seguimientos iniciales (protegida — requiere token)
│   └── sw.js                      ← Service Worker PWA
│
└── data/                          ← persistencia en Render disk (DATA_DIR)
    ├── clientes.json              ← estado CRM completo guardado por el servidor
    ├── ventas.json                ← registro de pedidos/ventas
    ├── campaigns.json             ← campañas automáticas WA
    ├── contactos_b2c.json         ← contactos B2C importados de WhatsApp
    ├── plantillas_custom.json     ← plantillas WA creadas por el usuario
    ├── agenda.json                ← agenda de seguimiento por cliente
    ├── agenda_log.json            ← historial de contactos enviados
    ├── download_log.json          ← log de todas las descargas/exportaciones (quién, cuándo, IP)
    └── backups/
        └── YYYY-MM-DD/            ← backups diarios automáticos (2am Colombia, últimos 30 días)
```

---

## 🔑 Variables de entorno en Render

| Variable | Descripción | Valor por defecto |
|----------|-------------|-------------------|
| `CYC_SECRET` | Token base de autenticación para API | `cyccrm_dev` |
| `ADMIN_PIN` | PIN exclusivo de Admin Mike | `2000` |
| `PIN_FOODSERVICE` | PIN del área Food Service | `1001` |
| `PIN_CALLCENTER` | PIN del área Call Center | `2002` |
| `PIN_PUNTOSVENTA` | PIN del área Puntos de Venta | `3003` |
| `PIN_PAUTAS` | PIN del área Pautas | `4004` |
| `DATA_DIR` | Ruta del disco persistente | `/opt/render/project/src/data` |
| `ANTHROPIC_API_KEY` | Llave Claude Haiku para el Bot IA | — |
| `EMAIL_USER` | Gmail para notificaciones de agenda | — |
| `EMAIL_PASS` | App Password del Gmail | — |
| `PORT` | Puerto del servidor (Render lo asigna) | `3000` |

> ⚠️ Si DATA_DIR está mal configurado, los datos no persisten entre reinicios.
> Valor correcto: `/opt/render/project/src/data` (debe coincidir con `mountPath` en render.yaml)

---

## 👥 Perfiles de acceso

| Perfil | PIN | Módulos disponibles |
|--------|-----|---------------------|
| 🥩 **Food Service** | `1001` | Clientes HORECA · Dashboard · Masiva WA · Agenda · Bot IA · Config |
| 📞 **Call Center** | `2002` | Dashboard · Masiva WA (B2C) · Bot IA · Config |
| 🏪 **Puntos de Venta** | `3003` | Ventas · Dashboard · Config |
| 📣 **Pautas** | `4004` | Dashboard · Masiva WA · Config |
| 🔐 **Admin Mike** | **`2000`** | **TODO** + Tab Admin exclusivo |

**Notas de seguridad:**
- Admin Mike **no aparece** en la pantalla de login — es un acceso secreto
- El PIN `2000` funciona desde cualquier tarjeta de área en el login
- Cada descarga/exportación queda registrada con IP y timestamp en `download_log.json`
- Solo Admin puede exportar CSV, descargar Memoria o hacer backup manual

---

## 🔒 Protecciones de seguridad implementadas

### Servidor
- `clientes.json` y `extras.json` bloqueados sin token válido (403)
- Cabeceras: `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Content-Security-Policy`, `no-cache`
- Todos los endpoints de exportación requieren token Admin
- Log de descargas en `download_log.json` (IP + tipo + timestamp)

### Frontend
- Clic derecho deshabilitado globalmente
- F12, Ctrl+U, Ctrl+S, Ctrl+Shift+I/J/C bloqueados
- `user-select: none` en tablas y listas de datos
- Advertencia legal visible en consola del navegador
- Botones de exportar ocultos para roles no-admin

---

## 🏗️ Stack técnico

| Capa | Tecnología |
|------|-----------|
| Runtime | Node.js 18+ |
| Framework | Express 4 |
| WhatsApp | @whiskeysockets/baileys (auth multi-file) |
| Bot IA | Anthropic SDK → Claude Haiku |
| Scheduler | node-schedule (agenda 8am / backup 2am Colombia) |
| Real-time | SSE — Server-Sent Events en `/api/eventos` |
| Frontend | SPA Vanilla JS (sin frameworks), dark mode, PWA |
| Storage | JSON files en Render disk + localStorage + Firebase (opcional) |

---

## 📡 API — Endpoints completos

### 🔐 Auth
| Método | Ruta | Acceso | Descripción |
|--------|------|--------|-------------|
| POST | `/api/auth/login` | público | `{pin, perfil}` → `{token, isAdmin, rol, tabs}` |
| POST | `/api/auth/logout` | público | Cierra sesión |

### 📱 WhatsApp
| Método | Ruta | Acceso | Descripción |
|--------|------|--------|-------------|
| GET | `/api/wa-status` | auth | Estado de conexión |
| GET | `/api/qr` | auth | QR actual en base64 |
| POST | `/api/masiva` | auth | Iniciar envío masivo |
| POST | `/api/masiva/stop` | auth | Detener envío |
| GET | `/api/wa-contacts` | auth | Contactos del celular vinculado |

### 👥 Clientes HORECA
| Método | Ruta | Acceso | Descripción |
|--------|------|--------|-------------|
| GET | `/api/clientes` | auth | Lista y estado completo |
| PUT | `/api/clientes` | auth | Guardar todo el estado CRM |

### 💰 Ventas
| Método | Ruta | Acceso | Descripción |
|--------|------|--------|-------------|
| GET | `/api/ventas` | auth | Lista de ventas |
| POST | `/api/ventas` | auth | Registrar nueva venta |
| DELETE | `/api/ventas/:id` | auth | Eliminar venta |
| GET | `/api/ventas/kpis` | auth | KPIs del mes (ingresos, delta, top productos) |

### 📲 Contactos B2C
| Método | Ruta | Acceso | Descripción |
|--------|------|--------|-------------|
| GET | `/api/b2c` | auth | Lista completa |
| POST | `/api/b2c/importar` | auth | Importar array de contactos |
| PUT | `/api/b2c/:id` | auth | Editar contacto |
| DELETE | `/api/b2c/:id` | auth | Eliminar contacto |
| DELETE | `/api/b2c/todos` | auth | Vaciar lista |
| GET | `/api/b2c/export.csv` | **admin** | Descargar CSV (registra en log) |

### 📅 Campañas automáticas
| Método | Ruta | Acceso | Descripción |
|--------|------|--------|-------------|
| GET | `/api/campaigns` | auth | Lista de campañas |
| POST | `/api/campaigns` | auth | Crear campaña |
| PUT | `/api/campaigns/:id` | auth | Editar campaña |
| DELETE | `/api/campaigns/:id` | auth | Eliminar campaña |

### 💬 Plantillas personalizadas
| Método | Ruta | Acceso | Descripción |
|--------|------|--------|-------------|
| GET | `/api/plantillas` | auth | Lista (built-in + custom) |
| POST | `/api/plantillas` | auth | Crear plantilla |
| PUT | `/api/plantillas/:id` | auth | Editar plantilla |
| DELETE | `/api/plantillas/:id` | auth | Eliminar plantilla |

### 📅 Agenda
| Método | Ruta | Acceso | Descripción |
|--------|------|--------|-------------|
| GET | `/api/agenda` | auth | Configuración de agenda |
| PUT | `/api/agenda/:id` | auth | Actualizar agenda de cliente |
| POST | `/api/agenda/ejecutar` | auth | Ejecutar agenda manualmente |

### 🔐 Admin Mike (token admin exclusivo)
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/admin/contactos` | Todos los contactos B2C con estadísticas |
| GET | `/api/admin/export.csv` | CSV completo con fuente y fecha (registra en log) |
| DELETE | `/api/admin/contactos` | Vaciar base de datos B2C |
| GET | `/api/admin/descargas` | Log de todas las descargas (IP, tipo, timestamp) |

### ⚙️ Sistema
| Método | Ruta | Acceso | Descripción |
|--------|------|--------|-------------|
| GET | `/api/status` | auth | Estado del servidor |
| GET | `/api/eventos` | público | SSE stream tiempo real |
| POST | `/api/backup` | **admin** | Backup manual (registra en log) |
| GET | `/api/backup/lista` | auth | Lista de backups disponibles |
| GET | `/api/memoria` | **admin** | Descarga JSON completo de recuperación |

---

## 🔄 Flujo de autenticación

```
1. Usuario abre cyc-crm.onrender.com
2. Login: selecciona área → ingresa PIN de 4 dígitos
3. POST /api/auth/login {pin, perfil}
4. Servidor valida PIN contra ROLES_MAP o ADMIN_PIN
5. Retorna {token, isAdmin, rol, tabs}
6. Token se guarda en sessionStorage (sobrevive F5, no cierra de pestaña)
7. Cada llamada a /api/* incluye header x-cyc-token
8. aplicarTabs(tabs) oculta/muestra nav según el rol
9. Si isAdmin=true → muestra tab "Admin Mike" y habilita exportaciones
```

---

## 📦 Módulos del frontend (index.html)

| Función | Módulo |
|---------|--------|
| `renderStats()` | Dashboard KPIs + pipeline HORECA |
| `renderVentas()` | Registro y tabla de pedidos |
| `renderMasivaContent()` | WhatsApp masivo HORECA + B2C |
| `renderCampaigns()` | Campañas automáticas CRUD |
| `abrirCampModal()` | Modal crear/editar campaña |
| `renderAgenda()` | Calendario seguimiento clientes |
| `renderBot()` | Bot IA Claude Haiku |
| `renderConfig()` | Config Firebase, backup, empresa |
| `renderAdmin()` | Admin Mike — contactos + log descargas |
| `abrirTplModal()` | CRUD plantillas WA personalizadas |
| `syncApp()` | Refresco automático cada 2 min + visibilitychange |
| `aplicarTabs()` | Muestra/oculta nav según rol |
| `loadCustomTemplates()` | Carga plantillas del servidor |
| `allTemplates()` | Merge plantillas built-in + custom |

---

## 🚨 Recuperación de emergencia paso a paso

### Escenario 1: Render se cayó o perdió datos
1. Entrar a https://dashboard.render.com
2. Ir al servicio `cyc-crm`
3. Verificar que el disco está montado en `/opt/render/project/src/data`
4. Ir a Logs → buscar errores de arranque
5. Si el disk está vacío: ir a Config → "📂 Ver backups" → restaurar el más reciente

### Escenario 2: Perdí el token o no puedo entrar
1. Ir a Render Dashboard → Environment
2. Verificar `CYC_SECRET` y los `PIN_*`
3. Si cambiaste `CYC_SECRET`, todos los tokens anteriores quedan inválidos — los usuarios deben volver a hacer login

### Escenario 3: WhatsApp desvinculado
1. Entrar al CRM con PIN 2000 (Admin)
2. Ir a Masiva WA → "📷 Ver código QR"
3. Escanear con el celular vinculado
4. Esperar 90 segundos → se importan contactos automáticamente

### Escenario 4: Recuperar base de datos completa
1. **Opción A (desde el CRM):** Admin Mike → Config → "🧠 Descargar Memoria" → guarda JSON completo
2. **Opción B (desde servidor):** `GET https://cyc-crm.onrender.com/api/memoria?_t=TOKEN_ADMIN`
3. **Opción C (backup diario):** Render Disk → `/opt/render/project/src/data/backups/YYYY-MM-DD/`

### Escenario 5: Migrar a nuevo servidor
1. Descargar Memoria desde `/api/memoria`
2. Copiar archivos de `data/` (ventas.json, campaigns.json, contactos_b2c.json, etc.)
3. Configurar nuevas variables de entorno en el nuevo servidor
4. Hacer push del repo a la nueva plataforma
5. Subir los archivos JSON de datos al nuevo `DATA_DIR`

---

## 📊 Datos del negocio

| Campo | Valor |
|-------|-------|
| Empresa | Carnes y Carnes |
| Ciudad | Bucaramanga, Santander |
| Web | carnesycarnes.com |
| WhatsApp | +57 318 578 0344 |
| Teléfono | +57 320 233 3333 |
| Clientes HORECA | 292 activos |
| Productos catálogo | 100+ (Shopify) |
| Puntos de venta | 22 (3 propios · 11 aliados · domicilio BGA) |
| Segmentos CRM | VIP · Frecuente · Distribuidor · Parrillero · Fitness · HORECA · Nuevo · Inactivo |
| Slogan | "Complacemos tu gusto cada día" |

---

## 📝 Historial de versiones relevantes

| Fecha | Versión | Cambio |
|-------|---------|--------|
| 2026-04-23 | v2.0 | Rediseño nav lateral HubSpot, paleta navy+naranja |
| 2026-05-06 | v2.1 | Módulo Ventas + KPIs reales en Dashboard |
| 2026-05-06 | v2.2 | QR modal mejorado, importar contactos WA, masiva B2C |
| 2026-05-06 | v2.3 | Campañas automáticas CRUD completo |
| 2026-05-06 | v2.4 | Admin Mike + auto-import WA + tab exclusivo PIN 2000 |
| 2026-05-06 | v2.5 | CRUD plantillas WA personalizadas + fix modal |
| 2026-05-06 | v2.6 | 5 roles de acceso + auto-sync + endpoint /api/memoria |
| 2026-05-06 | v2.7 | Protección bases de datos + log de descargas + bloqueos frontend |
| 2026-05-06 | v2.8 | Login rediseñado — panel unificado con tarjetas y PIN inline |
