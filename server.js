// =======================
// Bootstrap & Imports
// =======================
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const { MercadoPagoConfig, Preference } = require("mercadopago");
const nodemailer = require("nodemailer");

// >>> JWT ADD
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "cambialo_en_.env";

// 👉 Importá el DAO así, SIN destructurar:
const dao = require("./dao");
console.log("DAO sanity:", {
  listarComplejos: typeof dao.listarComplejos,
  exportsKeys: Object.keys(dao),
});

// =======================
// App & Middlewares base
// =======================
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());                       // para parsear JSON
app.use(express.urlencoded({ extended: true })); // para parsear formularios (x-www-form-urlencoded)

// =======================
// CORS sólido (GH Pages + local) — ÚNICO lugar
// Debe ir ANTES de cualquier ruta
// =======================
const ALLOWED_ORIGINS = [
  // Producción (GitHub Pages)
  "https://ramiroaldeco.github.io",
  "https://ramiroaldeco.github.io/recomplejos-frontend",

  // Dev habituales (Vite/CRA)
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",

  // Tus puertos previos (no los perdemos)
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

// ayuda para caches intermedios/CDN
app.use((req, res, next) => {
  res.setHeader("Vary", "Origin");
  next();
});

// Configuración centralizada de CORS
const corsOptions = {
  origin: (origin, cb) => {
    // Permitir same-origin/SSR y herramientas sin origen (curl/Postman/health).
    // Cuando el origen viene como literal 'null' (p.ej. file://), también lo aceptamos.
    if (!origin || origin === "null") {
      return cb(null, true);
    }
    if (ALLOWED_ORIGINS.includes(origin)) {
      return cb(null, true);
    }
    console.warn("CORS bloqueado para:", origin);
    return cb(new Error("CORS: Origin no permitido -> " + origin));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false,
};

// Responder preflight siempre con la misma configuración
app.options("*", cors(corsOptions));

// Aplicar CORS a todas las rutas
app.use(cors(corsOptions));

// =======================
// Rutas base y salud
// (van DESPUÉS de CORS)
// =======================
app.get("/", (req, res) => {
  res.type("text").send("OK ReComplejos backend");
});

// Opcional: health explícito si lo usás desde el front
app.get("/healthz", (req, res) => res.json({ ok: true }));
// =======================
// Datos de complejos (SIEMPRE como mapa { id: {...} })
// =======================
app.get("/datos_complejos", async (req, res) => {
  try {
    const datos = await dao.listarComplejos(); // puede venir array o mapa

    // Normalizo a MAPA { id: {...} } y limpio nulos
    let mapa = {};
    if (Array.isArray(datos)) {
      datos.filter(Boolean).forEach((c, i) => {
        const id = (c && c.id) || String(i);
        mapa[id] = { ...c, id };
      });
    } else if (datos && typeof datos === "object") {
      for (const [k, v] of Object.entries(datos)) {
        if (v && typeof v === "object") {
          mapa[k] = { ...v, id: v.id || k };
        }
      }
    }

    return res.json(mapa);
  } catch (e) {
    console.error("GET /datos_complejos DB error:", e?.message || e);
    // Fallback suave a archivo local si existiera
    try {
      const p = path.join(__dirname, "datos_complejos.json");
      const raw = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "{}";
      const obj = JSON.parse(raw || "{}");
      return res.json(obj || {});
    } catch (_) {
      return res.json({});
    }
  }
});


// =======================
// Guardar mapa completo de complejos { id: {...} }
// (Usa dao.guardarDatosComplejos)
// =======================
app.post("/guardarDatos", async (req, res) => {
  try {
    const body = req.body;

    // Debe ser un objeto (mapa) — NO array
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res
        .status(400)
        .json({ ok: false, error: "payload_debe_ser_mapa_por_id" });
    }

    // Normalizo IDs dentro de los valores
    for (const [id, c] of Object.entries(body)) {
      if (c && typeof c === "object") {
        c.id = c.id || id;
      } else {
        delete body[id];
      }
    }

    await dao.guardarDatosComplejos(body);
    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /guardarDatos error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "guardarDatos_db" });
  }
});

// =======================
// >>> JWT ADD – middleware de auth (lo dejás listo por si lo usás)
// =======================
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ ok: false, error: "no_token" });
  try {
    const payload = jwt.verify(m[1], JWT_SECRET);
    req.user = payload; // { sub:'dueno', complejo:'...' }
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "bad_token" });
  }
}
// =======================
// Paths de respaldos JSON (compat)
// =======================
const pathDatos = path.join(__dirname, "datos_complejos.json");
const pathReservas = path.join(__dirname, "reservas.json");
const pathCreds = path.join(__dirname, "credenciales_mp.json");
const pathIdx = path.join(__dirname, "prefidx.json");

// --- Helpers de archivo JSON
function leerJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}
function escribirJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

// asegurar archivos de backup
if (!fs.existsSync(pathDatos)) escribirJSON(pathDatos, {});
if (!fs.existsSync(pathReservas)) escribirJSON(pathReservas, {});
if (!fs.existsSync(pathCreds)) escribirJSON(pathCreds, {});
if (!fs.existsSync(pathIdx)) escribirJSON(pathIdx, {});

// =======================
// CONFIG MP por complejo (SOLO OAuth)
// =======================
function leerCredsMP_OAUTH() {
  try { return JSON.parse(fs.readFileSync(pathCreds, "utf8")); }
  catch { return {}; }
}
function escribirCredsMP_OAUTH(obj) {
  fs.writeFileSync(pathCreds, JSON.stringify(obj, null, 2));
}

/**
 * Access token priorizando DB (tabla mp_oauth) con fallback a archivo.
 * Usar:  const token = await tokenParaAsync(complejoId)
 */
async function tokenParaAsync(complejoId) {
  // 1) DB primero (si existen helpers en dao)
  try {
    if (dao?.getMpOAuth) {
      const t = await dao.getMpOAuth(complejoId); // { access_token, refresh_token }
      if (t?.access_token) return t.access_token;
    }
  } catch (e) {
    console.warn("tokenParaAsync:getMpOAuth", e?.message || e);
  }

  // 2) Fallback a archivo
  const cred = leerCredsMP_OAUTH();
  const tok = cred?.[complejoId]?.oauth?.access_token;
  if (tok) return tok;

  const err = new Error(`El complejo ${complejoId} no tiene Mercado Pago conectado (OAuth).`);
  err.code = "NO_OAUTH";
  throw err;
}

/** Legacy (solo archivo). Dejar por compat, pero evitar su uso. */
function tokenPara(complejoId) {
  const cred = leerCredsMP_OAUTH();
  const c = cred[complejoId] || {};
  const tok = c.oauth?.access_token; // solo OAuth
  if (!tok) {
    const err = new Error(`El complejo ${complejoId} no tiene Mercado Pago conectado (OAuth).`);
    err.code = "NO_OAUTH";
    throw err;
  }
  return tok;
}

function isInvalidTokenError(err) {
  const m1 = (err && err.message || "").toLowerCase();
  const m2 = (err && err.response && (err.response.data?.message || err.response.body?.message) || "").toLowerCase();
  const m3 = (err && err.cause && String(err.cause).toLowerCase()) || "";
  return m1.includes("unauthorized") || m2.includes("invalid_token") || m3.includes("invalid_token");
}

// Refresca token con refresh_token guardado (guarda en archivo + DB si está disponible)
async function refreshOAuthToken(complejoId) {
  const creds = leerCredsMP_OAUTH();
  const c = creds[complejoId] || {};
  const refresh_token = c?.oauth?.refresh_token;
  if (!refresh_token) throw new Error("No hay refresh_token para refrescar");

  const body = {
    grant_type: "refresh_token",
    refresh_token,
    client_id: process.env.MP_CLIENT_ID,
    client_secret: process.env.MP_CLIENT_SECRET,
  };

  const r = await fetch("https://api.mercadopago.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error("No se pudo refrescar el token OAuth de Mercado Pago");

  // persistir en archivo
  creds[complejoId] = creds[complejoId] || {};
  creds[complejoId].oauth = {
    ...(creds[complejoId].oauth || {}),
    access_token: j.access_token,
    refresh_token: j.refresh_token || c.oauth?.refresh_token,
    user_id: j.user_id ?? c.oauth?.user_id,
    updated_at: Date.now()
  };
  escribirCredsMP_OAUTH(creds);

  // persistir en DB (si existe helper)
  try {
    if (dao?.upsertMpOAuth) {
      await dao.upsertMpOAuth({
        complex_id: complejoId,
        access_token: j.access_token,
        refresh_token: j.refresh_token || refresh_token,
        scope: j.scope,
        token_type: j.token_type,
        live_mode: j.live_mode,
        expires_in: j.expires_in
      });
    }
  } catch (e) { console.warn("refreshOAuthToken:upsertMpOAuth", e?.message || e); }

  return j.access_token;
}

// Variante usada en crear-preferencia (deja persistido en archivo + DB si está)
async function refreshTokenMP(complejoId) {
  const allCreds = leerCredsMP_OAUTH();
  const creds = allCreds?.[complejoId]?.oauth || null;
  if (!creds?.refresh_token) throw new Error(`No hay refresh_token guardado para ${complejoId}`);

  const body = {
    grant_type: "refresh_token",
    client_id: process.env.MP_CLIENT_ID,
    client_secret: process.env.MP_CLIENT_SECRET,
    refresh_token: creds.refresh_token
  };

  const r = await fetch("https://api.mercadopago.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok || !data?.access_token) {
    console.error("Fallo refresh_token MP:", { status: r.status, data });
    throw new Error("No se pudo refrescar el token de MP");
  }

  const newCreds = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || creds.refresh_token,
    scope: data.scope,
    token_type: data.token_type,
    live_mode: data.live_mode,
    expires_in: data.expires_in,
    obtained_at: Date.now()
  };

  allCreds[complejoId] = allCreds[complejoId] || {};
  allCreds[complejoId].oauth = {
    ...(allCreds[complejoId].oauth || {}),
    ...newCreds
  };
  escribirCredsMP_OAUTH(allCreds);

  // DB (si está disponible)
  try {
    if (dao?.upsertMpOAuth) {
      await dao.upsertMpOAuth({
        complex_id: complejoId,
        access_token: newCreds.access_token,
        refresh_token: newCreds.refresh_token,
        scope: newCreds.scope,
        token_type: newCreds.token_type,
        live_mode: newCreds.live_mode,
        expires_in: newCreds.expires_in
      });
    }
  } catch (e) { console.warn("refreshTokenMP:upsertMpOAuth", e?.message || e); }

  return newCreds.access_token;
}
// =======================
// HOLD anti doble-reserva (legacy archivo de compat + limpieza)
// =======================
const HOLD_MIN = parseInt(process.env.HOLD_MIN || "10", 10); // 10 min default

function estaHoldActiva(r) {
  if (!r) return false;
  const t = typeof r.holdUntil === "number" ? r.holdUntil : Number(r.holdUntil);
  return r.status === "hold" && t && Date.now() < t;
}

function limpiarHoldsVencidos() {
  const reservas = leerJSON(pathReservas);
  let cambio = false;
  for (const k of Object.keys(reservas)) {
    const r = reservas[k];
    if (r?.status === "hold" && r.holdUntil && Date.now() >= r.holdUntil) {
      delete reservas[k]; // liberar
      cambio = true;
    }
  }
  if (cambio) escribirJSON(pathReservas, reservas);
}
setInterval(limpiarHoldsVencidos, 60 * 1000); // cada minuto

// =======================
// Helpers fecha/hora/clave UNIFICADOS
// =======================

/**
 * Genera slug normalizado de nombre de cancha
 * (minúsculas, sin espacios, solo alfanuméricos)
 */
function slugCancha(nombre = "") {
  return String(nombre)
    .toLowerCase()
    .normalize('NFD')                     // separa letras y tildes
    .replace(/[\u0300-\u036f]/g, '')      // elimina las tildes/acentos
    .replace(/\s+/g, '')                  // borra espacios
    .replace(/[^a-z0-9]/g, '');           // borra todo lo que no sea letra o número
}

/**
 * Genera la clave unificada: complejo-cancha-fecha-hora
 * IMPORTANTE: usa slugCancha() para normalizar el nombre de la cancha
 */
function claveDe({ complejoId, canchaNombre, fecha, hora }) {
  return `${complejoId}-${slugCancha(canchaNombre)}-${fecha}-${hora}`;
}

/**
 * Parser de clave del servidor para extraer componentes
 * formato: complejo-cancha-YYYY-MM-DD-HH:MM
 */
function parseClaveServidor(k) {
  const m = k.match(/^(.+?)-(.+?)-(\d{4}-\d{2}-\d{2})-(\d{2}:\d{2})$/);
  if (!m) return null;
  return { complejo: m[1], cancha: m[2], fechaISO: m[3], hora: m[4] };
}

function esFechaISO(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }
function esHora(h) { return /^\d{2}:\d{2}$/.test(h); }

function nombreDia(fechaISO) {
  const d = new Date(`${fechaISO}T00:00:00-03:00`);
  const dias = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
  return dias[d.getDay()];
}

function entre(hora, desde, hasta) {
  if (!desde || !hasta) return false;
  return (desde <= hasta) ? (hora >= desde && hora <= hasta)
    : (hora >= desde || hora <= hasta);
}

function validarTurno({ complejoId, canchaNombre, fecha, hora }) {
  if (!complejoId) return { ok: false, error: "Falta complejoId" };
  if (!canchaNombre) return { ok: false, error: "Falta cancha" };
  if (!esFechaISO(fecha)) return { ok: false, error: "Fecha inválida" };
  if (!esHora(hora)) return { ok: false, error: "Hora inválida" };

  const datos = _cacheComplejosCompat;
  const info = datos?.[complejoId];
  if (!info) return { ok: false, error: "Complejo inexistente" };

  const cancha = (info.canchas || []).find(c => slugCancha(c.nombre) === slugCancha(canchaNombre));
  if (!cancha) return { ok: false, error: "Cancha inexistente" };

  const ahora = new Date();
  const turno = new Date(`${fecha}T${hora}:00-03:00`);
  if (turno.getTime() < ahora.getTime()) return { ok: false, error: "Turno en el pasado" };

  const nomDia = nombreDia(fecha);
  const hDia = (info.horarios || {})[nomDia] || {};
  const desde = hDia.desde || "18:00";
  const hasta = hDia.hasta || "23:00";
  if (!entre(hora, desde, hasta)) return { ok: false, error: `Fuera de horario (${nomDia} ${desde}-${hasta})` };

  return { ok: true, cancha };
}
// =======================
// Email helpers
// =======================

// lee contacto y switches priorizando DB; fallback al cache o JSON
async function getOwnerConfig(complejoId) {
  try {
    if (dao?.leerContactoComplejo) {
      const r = await dao.leerContactoComplejo(complejoId);
      if (r) {
        return {
          owner_email: r.owner_email || "",
          owner_phone: r.owner_phone || "",
          notif_email: !!r.notif_email,
          notif_whats: !!r.notif_whats,
        };
      }
    }
  } catch (e) {
    console.warn("getOwnerConfig DB", e?.message || e);
  }
  // fallback al cache/archivo (compat)
  const datos = Object.keys(_cacheComplejosCompat || {}).length ? _cacheComplejosCompat : leerJSON(pathDatos);
  const conf = datos?.[complejoId] || {};
  const notif = conf.notif || {};
  return {
    owner_email: conf.emailDueño || "",
    owner_phone: conf.whatsappDueño || "",
    notif_email: !!notif.email,
    notif_whats: !!notif.whats
  };
}

function plantillaMailReserva({ complejoId, cancha, fecha, hora, nombre, telefono, monto }) {
  const telFmt = telefono ? (String(telefono).startsWith('+') ? telefono : `+${String(telefono).replace(/\D/g, '')}`) : 's/d';
  const montoFmt = (monto != null && monto !== "") ? `ARS $${Number(monto).toLocaleString('es-AR')}` : '—';
  const titulo = `NUEVA RESERVA — ${cancha || ''} ${hora || ''}`.trim();

  const html = `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;line-height:1.45">
      <h2 style="margin:0 0 10px">NUEVA RESERVA</h2>
      <p><b>Complejo:</b> ${complejoId}</p>
      <p><b>Cancha:</b> ${cancha || 's/d'}</p>
      <p><b>Fecha:</b> ${fecha || 's/d'} <b>Hora:</b> ${hora || 's/d'}</p>
      <p><b>Cliente:</b> ${nombre || '—'}</p>
      <p><b>Teléfono:</b> ${telFmt}</p>
      <p><b>Seña:</b> ${montoFmt}</p>
      <hr style="border:none;height:1px;background:#ddd;margin:12px 0" />
      <small style="color:#666">Recomplejos</small>
    </div>`;
  return { subject: titulo, html };
}

async function enviarEmail(complejoId, subject, html) {
  try {
    const { owner_email, notif_email } = await getOwnerConfig(complejoId);
    if (!notif_email || !owner_email) return; // no activado o sin email

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GOOGLE_APP_PASSWORD },
    });

    await transporter.sendMail({ from: process.env.GMAIL_USER, to: owner_email, subject, html });
    console.log("[EMAIL] enviado a", owner_email);
  } catch (e) {
    console.error("[EMAIL] error:", e?.message || e);
  }
}

async function notificarAprobado({ clave, complejoId, nombre, telefono, monto }) {
  try {
    const info = parseClaveServidor(clave) || {};
    const { subject, html } = plantillaMailReserva({
      complejoId,
      cancha: info.cancha,
      fecha: info.fechaISO,
      hora: info.hora,
      nombre,
      telefono,
      monto
    });
    await enviarEmail(complejoId, subject, html);
  } catch (e) {
    console.error("notificarAprobado error:", e?.message || e);
  }
}

// =======================
// RUTAS - Cache y datos de complejos
// =======================

// Cache breve para validación
let _cacheComplejosCompat = {};
// Alta/actualización credencial "legacy"
app.post("/alta-credencial", (req, res) => {
  const { id, mp_access_token, access_token } = req.body || {};
  if (!id || !(mp_access_token || access_token)) {
    return res.status(400).json({ error: "Falta id o token" });
  }
  const cred = leerJSON(pathCreds);
  cred[id] = cred[id] || {};
  cred[id].access_token = access_token || mp_access_token;
  escribirJSON(pathCreds, cred);
  res.json({ ok: true });
});

// =======================
// RUTAS - Reservas
// =======================

// Reservas → leer de BD (compat: archivo si falla)
// --- Reservas para el panel (devuelve objeto { clave: datos }) ---
app.get("/reservas", async (req, res) => {
  try {
    const data = await dao.listarReservasObjCompat(); // usa el DAO que ya tenés
    res.json(data);
  } catch (e) {
    console.error("Error en /reservas:", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Guardar reservas masivo (panel dueño)
app.post("/guardarReservas", async (req, res) => {
  ��try {
    await dao.guardarReservasObjCompat(req.body || {});
    escribirJSON(pathReservas, req.body || {});
    res.json({ ok: true });
  } catch (e) {
    console.error("DB /guardarReservas", e);
    res.status(500).json({ error: "DB error al guardar" });
  }
});

// ¿Está libre este turno?
app.get("/disponible", async (req, res) => {
  const { complejoId, cancha, fecha, hora } = req.query || {};
  const v = validarTurno({ complejoId, canchaNombre: cancha, fecha, hora });
  if (!v.ok) return res.json({ ok: false, motivo: v.error });

  try {
    const obj = await dao.listarReservasObjCompat();
    const clave = claveDe({ complejoId, canchaNombre: cancha, fecha, hora });
    const r = obj[clave];
    const ocupado = Boolean(
      r && (
        r.status === "approved" ||
        r.status === "manual" ||
        r.status === "blocked" ||
        (r.status === "hold" && r.holdUntil && Date.now() < r.holdUntil)
      )
    );
    return res.json({ ok: true, libre: !ocupado });
  } catch {
    const reservas = leerJSON(pathReservas);
    const clave = claveDe({ complejoId, canchaNombre: cancha, fecha, hora });
    const r = reservas[clave];
    const ocupado = Boolean(
      r && (
        r.status === "approved" ||
        r.status === "manual" ||
        r.status === "blocked" ||
        estaHoldActiva(r)
      )
    );
    return res.json({ ok: true, libre: !ocupado, via: "archivo" });
  }
});

// Estado de una reserva por clave
app.get("/estado-reserva", async (req, res) => {
  const { clave } = req.query || {};
  if (!clave) return res.status(400).json({ error: "Falta clave" });
  try {
    const obj = await dao.listarReservasObjCompat();
    const r = obj[clave];
    if (!r) return res.json({ ok: true, existe: false, status: "none" });
    return res.json({ ok: true, existe: true, status: r.status, data: r });
  } catch {
    const reservas = leerJSON(pathReservas);
    const r = reservas[clave];
    if (!r) return res.json({ ok: true, existe: false, status: "none", via: "archivo" });
    return res.json({ ok: true, existe: true, status: r.status, data: r, via: "archivo" });
  }
});

// =======================
// NUEVA RUTA: Reservar manual (recomendada)
// =======================
/**
 * Crea o actualiza una reserva manual para un turno concreto.
 * Guarda en la base de datos y notifica al dueño si corresponde.
 * Espera en req.body: { complejoId, cancha, fechaISO, hora, nombre, telefono, monto }
 */
app.post("/reservar-manual", async (req, res) => {
  try {
    const { complejoId, cancha, fechaISO, hora, nombre, telefono, monto } = req.body || {};
    if (!complejoId || !cancha || !fechaISO || !hora) {
      return res.status(400).json({
        ok: false,
        error: "Faltan datos: complejoId, cancha, fechaISO, hora"
      });
    }

    // Validar el turno
    const v = validarTurno({ complejoId, canchaNombre: cancha, fecha: fechaISO, hora });
    if (!v.ok) {
      return res.status(400).json({ ok: false, error: v.error });
    }

    // Guarda en la BD como reserva manual
    if (dao.reservarManualDB) {
      await dao.reservarManualDB({
        complex_id: complejoId,
        cancha,
        fechaISO,
        hora,
        nombre,
        telefono,
        monto
      });
    } else if (dao.insertarReservaManual) {
      // fallback: usa la función existente en tu DAO
      await dao.insertarReservaManual({
        complex_id: complejoId,
        cancha,
        fechaISO,
        hora,
        nombre,
        telefono,
        monto
      });
    } else {
      return res.status(500).json({
        ok: false,
        error: "No hay función disponible para guardar reservas manuales"
      });
    }

    // Notifica al dueño por email (solo si notif_email está activo)
    try {
      const { subject, html } = plantillaMailReserva({
        complejoId,
        cancha,
        fecha: fechaISO,
        hora,
        nombre,
        telefono,
        monto
      });
      await enviarEmail(complejoId, subject, html);
    } catch (e) {
      console.warn("No se pudo enviar email de reserva manual:", e?.message || e);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("/reservar-manual error:", e);
    return res.status(500).json({
      ok: false,
      error: e.message || "Error interno"
    });
  }
});

// =======================
// Reserva manual (LEGACY - mantener compatibilidad)
// =======================
app.post("/reservas/manual", async (req, res) => {
  try {
    let { complejoId, cancha, fechaISO, hora, nombre, telefono, monto } = req.body || {};

    // normalizaciones mínimas
    complejoId = String(complejoId || "").trim();
    cancha     = String(cancha || "").trim();
    fechaISO   = String(fechaISO || "").slice(0, 10);   // YYYY-MM-DD
    hora       = String(hora || "").slice(0, 5);        // HH:MM
    nombre     = (nombre ?? "").toString().trim();
    telefono   = (telefono ?? "").toString().trim();
    monto      = Number(monto ?? 0);

    if (!complejoId || !cancha || !fechaISO || !hora) {
      return res.status(400).json({ ok:false, error:"Faltan complejoId, cancha, fechaISO, hora" });
    }

    // Inserta/actualiza en BD como 'manual'
    try {
      await dao.insertarReservaManual({
        complex_id: complejoId,
        cancha, fechaISO, hora, nombre, telefono, monto
      });
    } catch (err) {
      // mensaje más claro si la cancha no existe en ese complejo
      if ((err.message || "").toLowerCase().includes("cancha no encontrada")) {
        return res.status(404).json({ ok:false, error:"La cancha no existe para este complejo" });
      }
      throw err;
    }

    // Email al dueño (si notif_email y owner_email en DB) — no bloquea el OK
    (async () => {
      try {
        let canchaLegible = cancha;
        try {
          const info = _cacheComplejosCompat?.[complejoId];
          const match = (info?.canchas || []).find(c => slugCancha(c.nombre) === slugCancha(cancha));
          if (match?.nombre) canchaLegible = match.nombre;
        } catch {}
        const { subject, html } = plantillaMailReserva({
          complejoId,
          cancha: canchaLegible,
          fecha: fechaISO,
          hora,
          nombre,
          telefono,
          monto
        });
        await enviarEmail(complejoId, subject, html);
      } catch (e) {
        console.warn("No se pudo enviar email de reserva manual:", e?.message || e);
      }
    })();

    return res.json({ ok:true });
  } catch (e) {
    console.error("/reservas/manual error:", e);
    return res.status(500).json({ ok:false, error: e.message || "Error interno" });
  }
});

// Notificar reserva manual (solo email, no guarda estado)
app.post("/notificar-manual", async (req, res) => {
  try {
    const { complejoId, nombre, telefono, monto, clave } = req.body || {};
    if (!complejoId) return res.status(400).json({ ok: false, error: "Falta complejoId" });

    const { subject, html } = plantillaMailReserva({
      complejoId,
      cancha: "", fecha: "", hora: "",
      nombre, telefono, monto
    });
    await enviarEmail(complejoId, subject, html);
    res.json({ ok: true });
  } catch (e) {
    console.error("notificar-manual:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// LOGIN
// =======================
app.post("/login", async (req, res) => {
  const id = String(req.body?.complejo || "").trim();
  const pass = String(req.body?.password || "").trim();

  if (!id || !pass) return res.status(400).json({ error: "Faltan datos" });

  let ok = false;

  // 1) Chequeo en la DB
  try {
    const r = await dao.loginDueno(id, pass);
    ok = !!r?.ok;
  } catch (e) {
    console.error("DB /login:", e);
  }

  // 2) Fallback a archivo (por si la DB no tenía la clave guardada aún)
  if (!ok) {
    try {
      const datos = leerJSON(pathDatos);
      const claveArchivo = String(datos?.[id]?.clave || "").trim();
      if (claveArchivo && claveArchivo === pass) ok = true;
    } catch {}
  }

  if (!ok) return res.status(401).json({ error: "Contraseña incorrecta" });
  res.json({ ok: true });
});
// =======================
// (Opcional) healthcheck simple
// =======================
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));
// =======================
// PAGOS: crear preferencia (SOLO OAuth)
// =======================
// =======================
// Crear preferencia (Mercado Pago) + HOLD
// =======================
// === Crear preferencia (reserva online) ===
app.post("/crear-preferencia", async (req, res) => {
  try {
    let {
      complejoId,
      cancha,
      fecha,        // puede venir como 'fecha'
      fechaISO,     // o como 'fechaISO'
      hora,
      titulo,
      precio, senia,
      nombre, telefono,
      clave: claveLegacy,
      holdMinutes
    } = req.body || {};

    // 1) Validaciones básicas
    const monto = Number(precio ?? senia ?? 0);
    if (!complejoId) return res.status(400).json({ error: "Falta complejoId" });
    if (!monto || isNaN(monto) || monto <= 0) return res.status(400).json({ error: "Monto inválido" });

    // 2) Normalizaciones
    complejoId = String(complejoId).trim();
    nombre = (nombre || "").trim();
    telefono = (telefono || "").trim();

    // 3) Resolver fecha/hora (acepto ambos nombres + intento legacy)
    let fISO = (fechaISO || fecha || "").trim();
    let hHM  = (hora || "").trim();

    if ((!/^\d{4}-\d{2}-\d{2}$/.test(fISO) || !/^\d{2}:\d{2}$/.test(hHM)) && claveLegacy) {
      const m = String(claveLegacy).match(/-(\d{4}-\d{2}-\d{2})-(\d{2}:\d{2})$/);
      if (m) { fISO = fISO || m[1]; hHM = hHM || m[2]; }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fISO)) return res.status(400).json({ error: "Fecha inválida (YYYY-MM-DD)" });
    if (!/^\d{2}:\d{2}$/.test(hHM))        return res.status(400).json({ error: "Hora inválida (HH:MM)" });

    // 4) Verificar complejo (tolerante)
    const info = await dao.getComplejo(complejoId);
    if (!info) return res.status(400).json({ error: "Complejo inexistente" });

    // 5) Crear HOLD (bloqueo del turno)
    //const holdOk = await dao.crearHold({
    //  complex_id: complejoId,
    //  cancha,                 // nombre visible; DB lo resuelve contra fields
    //  fechaISO: fISO,
    //  hora: hHM,
    //  nombre, telefono,
    //  monto,
    //  holdMinutes: Number(holdMinutes) || 10
    //});
    //if (!holdOk) return res.status(400).json({ error: "Cancha inexistente o turno inválido" });

    // 6) Preferencia MP - busca token en mp_oauth o en complexes o en variable
    let accessToken = null;

    // prioridad 1: tabla mp_oauth (tokens reales)
    try {
      const creds = await dao.getMpOAuth(complejoId);
      if (creds?.access_token) accessToken = creds.access_token;
    } catch (_) {}

    // prioridad 2: tabla complexes (por compatibilidad)
    if (!accessToken) {
      try {
        const creds2 = await dao.leerCredencialesMP(complejoId);
        if (creds2?.mp_access_token) accessToken = creds2.mp_access_token;
      } catch (_) {}
    }

    // prioridad 3: variable de entorno
    if (!accessToken) accessToken = process.env.MP_ACCESS_TOKEN || null;

    // si no hay token => error claro
    if (!accessToken) {
      return res.status(400).json({
        error: `MercadoPago no configurado: no se encontró access_token para el complejo ${complejoId}`
      });
    }

    const prefBody = {
      items: [{ title: titulo || `Seña ${cancha}`, quantity: 1, currency_id: "ARS", unit_price: Number(monto) }],
      payer: { name: nombre || "Cliente", phone: { number: telefono || "" } },
      metadata: { complejoId, cancha, fecha: fISO, hora: hHM },
      back_urls: {
        success: "https://ramiroaldeco.github.io/recomplejos-frontend/reservar-exito.html",
        pending: "https://ramiroaldeco.github.io/recomplejos-frontend/reservar-pendiente.html",
        failure: "https://ramiroaldeco.github.io/recomplejos-frontend/reservar-error.html"
      },
      auto_return: "approved"
    };

    const mpRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(prefBody)
    });

    if (!mpRes.ok) {
      const txt = await mpRes.text().catch(()=> "");
      console.error("MP error:", mpRes.status, txt);
      return res.status(502).json({ error: "MercadoPago no disponible" });
    }

    const pref = await mpRes.json();
    const init_point = pref.init_point || pref.sandbox_init_point;
    if (!init_point) return res.status(502).json({ error: "Preferencia creada sin init_point" });

    return res.json({ init_point });
  } catch (e) {
    console.error("ERROR /crear-preferencia:", e);
    return res.status(500).json({ error: "Error interno" });
  }
});
// =======================
// Webhook de Mercado Pago
// =======================
// Aceptamos JSON y también texto plano (MP a veces varía el header)
app.post(
  "/webhook-mp",
  express.json({ type: ['application/json', 'text/plain', 'application/*+json'] }),
  async (req, res) => {
    try {
      // Responder rápido para evitar reintentos excesivos
      res.sendStatus(200);

      // 1) Extraer paymentId (MP puede mandarlo en body o query)
      const body = (typeof req.body === 'string') ? JSON.parse(req.body || '{}') : (req.body || {});
      const paymentId =
        body?.data?.id ||
        body?.id ||
        req.query?.['data.id'] ||
        req.query?.id;

      if (!paymentId) {
        console.warn("[webhook-mp] Sin paymentId en body/query:", body, req.query);
        return;
      }

      // 2) Conseguir un access_token válido (DB mp_oauth -> complexes -> env)
      const tokensATestar = new Set();

      // a) .env
      if (process.env.MP_ACCESS_TOKEN) tokensATestar.add(process.env.MP_ACCESS_TOKEN);

      // b) DB mp_oauth (si tenés helper en dao)
      try {
        if (dao.getAllMpTokens) {
          const toks = await dao.getAllMpTokens();
          (toks || []).forEach(t => t?.access_token && tokensATestar.add(t.access_token));
        }
      } catch (e) {
        console.warn("[webhook-mp] No se pudieron leer tokens de mp_oauth:", e?.message || e);
      }

      // c) Tabla complexes (compatibilidad)
      try {
        if (dao.getAllComplexTokens) {
          const toks2 = await dao.getAllComplexTokens();
          (toks2 || []).forEach(t => t?.mp_access_token && tokensATestar.add(t.mp_access_token));
        }
      } catch (e) {
        console.warn("[webhook-mp] No se pudieron leer tokens de complexes:", e?.message || e);
      }

      // d) (Opcional) archivos locales – si aún los usás
      try {
        const cred = leerJSON?.(pathCreds);
        for (const k of Object.keys(cred || {})) {
          if (cred[k]?.oauth?.access_token) tokensATestar.add(cred[k].oauth.access_token);
          if (cred[k]?.access_token)       tokensATestar.add(cred[k].access_token);
          if (cred[k]?.mp_access_token)    tokensATestar.add(cred[k].mp_access_token);
        }
      } catch {}

      if (tokensATestar.size === 0) {
        console.error("[webhook-mp] No hay tokens para consultar el pago.");
        return;
      }

      // 3) Consultar el pago en MP con el primer token que funcione
      let pago = null;
      for (const t of tokensATestar) {
        try {
          const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { Authorization: `Bearer ${t}` }
          });
          if (r.ok) { pago = await r.json(); break; }
        } catch { /* probar con otro token */ }
      }
      if (!pago) {
        console.error("[webhook-mp] No se pudo obtener el pago en MP:", paymentId);
        return;
      }

      const prefId     = pago?.order?.id || pago?.preference_id || pago?.metadata?.preference_id || null;
      const status     = pago?.status; // approved | pending | rejected | in_process | cancelled
      let   clave      = pago?.metadata?.clave || null;
      let   complejoId = pago?.metadata?.complejoId || null;

      // 4) Si no vino la clave/complejo en metadata, buscarla por índice prefId -> clave (compat local)
      if ((!clave || !complejoId) && prefId && typeof leerJSON === 'function') {
        try {
          const idx = leerJSON(pathIdx);
          if (!clave)       clave      = idx?.[prefId]?.clave || null;
          if (!complejoId)  complejoId = idx?.[prefId]?.complejoId || null;
        } catch {}
      }

      if (!prefId) {
        console.warn("[webhook-mp] Sin preference_id en pago:", pago?.id);
        // igual seguimos actualizando por payment_id más abajo
      }

      // 5) Si el pago fue aprobado, crear la reserva real (FIX: usar la cancha de metadata)
      if (status === 'approved') {
        try {
          await dao.insertarReservaManual({
            complex_id:  complejoId,
            cancha:      pago?.metadata?.cancha,                  // ← importante
            fechaISO:    pago?.metadata?.fecha || pago?.metadata?.fechaISO,
            hora:        pago?.metadata?.hora,
            nombre:      pago?.metadata?.nombre,
            telefono:    pago?.metadata?.telefono,
            monto:       pago?.transaction_amount
          });
        } catch (e) {
          console.error("Error creando reserva tras pago aprobado:", e);
        }
      }

      // 6) Actualizar en la BD el estado final (levanta hold y marca estado real)
      try {
        await dao.actualizarReservaTrasPago({
          preference_id: prefId,
          payment_id: String(pago?.id || paymentId),
          status,
          nombre:   pago?.metadata?.nombre   || null,
          telefono: pago?.metadata?.telefono || null
        });
      } catch (e) {
        console.error("[webhook-mp] DB actualizarReservaTrasPago:", e?.message || e);
      }

      // 7) (Compat) espejo en archivo local si todavía lo usás
      try {
        if (typeof leerJSON === 'function' && typeof escribirJSON === 'function' && clave) {
          const reservas = leerJSON(pathReservas) || {};
          const r = reservas[clave] || {};
          r.preference_id = prefId || r.preference_id;
          r.payment_id    = pago?.id || r.payment_id;

          if (status === "approved") {
            r.status     = "approved";
            r.paidAt     = Date.now();
            r.nombre     = r.nombre   || pago?.metadata?.nombre   || "";
            r.telefono   = r.telefono || pago?.metadata?.telefono || "";
            r.complejoId = r.complejoId || complejoId || "";
            delete r.holdUntil;

            await notificarAprobado?.({
              clave,
              complejoId: r.complejoId,
              nombre: r.nombre,
              telefono: r.telefono,
              monto: r.monto || r.precio || r.senia || ""
            });
          } else if (status === "rejected" || status === "cancelled") {
            delete reservas[clave]; // libera
            escribirJSON(pathReservas, reservas);
            return;
          } else {
            r.status = "pending"; // in_process / pending
          }

          escribirJSON(pathReservas, { ...reservas, [clave]: r });
        }
      } catch (e) {
        console.warn("[webhook-mp] espejo local:", e?.message || e);
      }
    } catch (e) {
      console.error("Error en webhook:", e?.message || e);
      // ya respondimos 200 arriba para evitar reintentos
    }
  }
);
// =======================
// OAuth Mercado Pago: conectar / estado / callback
// =======================
app.get("/mp/conectar", (req, res) => {
  const { complejoId } = req.query;
  if (!complejoId) return res.status(400).send("Falta complejoId");

  const u = new URL("https://auth.mercadopago.com/authorization");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", process.env.MP_CLIENT_ID);
  u.searchParams.set("redirect_uri", process.env.MP_REDIRECT_URI);
  u.searchParams.set("state", complejoId);
  u.searchParams.set("scope", "offline_access read write");

  res.redirect(u.toString());
});

app.get("/mp/estado", async (req, res) => {
  const { complejoId } = req.query;
  if (!complejoId) return res.status(400).json({ ok: false, error: "Falta complejoId" });

  let conectado = false;
  try {
    if (dao?.getMpOAuth) {
      const t = await dao.getMpOAuth(complejoId);
      conectado = !!t?.access_token;
    }
  } catch {}
  if (!conectado) {
    const creds = leerCredsMP_OAUTH();
    conectado = !!creds?.[complejoId]?.oauth?.access_token;
  }
  res.json({ ok: true, conectado });
});

app.get("/mp/callback", async (req, res) => {
  const { code, state: complejoId } = req.query;
  if (!code || !complejoId) {
    const u = new URL(`${process.env.PUBLIC_URL}/onboarding.html`);
    u.searchParams.set("mp", "error");
    return res.redirect(u.toString());
  }

  try {
    const r = await fetch("https://api.mercadopago.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: process.env.MP_CLIENT_ID,
        client_secret: process.env.MP_CLIENT_SECRET,
        code,
        redirect_uri: process.env.MP_REDIRECT_URI
      })
    });
    const data = await r.json();

    if (!r.ok || !data?.access_token) {
      const u = new URL(`${process.env.PUBLIC_URL}/onboarding.html`);
      u.searchParams.set("complejo", complejoId);
      u.searchParams.set("mp", "error");
      return res.redirect(u.toString());
    }

    try {
      if (dao?.upsertMpOAuth) {
        await dao.upsertMpOAuth({
          complex_id: complejoId,
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          scope: data.scope,
          token_type: data.token_type,
          live_mode: data.live_mode,
          expires_in: data.expires_in
        });
      }
    } catch (e) { console.warn("callback:upsertMpOAuth", e?.message || e); }

    const all = leerCredsMP_OAUTH();
    all[complejoId] = all[complejoId] || {};
    all[complejoId].oauth = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      user_id: data.user_id,
      scope: data.scope,
      token_type: data.token_type,
      live_mode: data.live_mode,
      expires_in: data.expires_in,
      obtained_at: Date.now()
    };
    escribirCredsMP_OAUTH(all);

    const ok = new URL(`${process.env.PUBLIC_URL}/onboarding.html`);
    ok.searchParams.set("complejo", complejoId);
    ok.searchParams.set("mp", "ok");
    return res.redirect(ok.toString());

  } catch (e) {
    console.error("Callback OAuth MP error:", e?.message || e);
    const u = new URL(`${process.env.PUBLIC_URL}/onboarding.html`);
    u.searchParams.set("complejo", complejoId);
    u.searchParams.set("mp", "error");
    return res.redirect(u.toString());
  }
});


// =======================
// Rutas de contacto y notificaciones
// =======================
app.get('/complejos/:id/contacto', async (req, res) => {
  try {
    const out = await dao.leerContactoComplejo(req.params.id);
    res.json({ ok: true, data: out });
  } catch (e) {
    console.error('GET contacto', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/complejos/:id/contacto', async (req, res) => {
  try {
    const { owner_phone, owner_email, notif_whats, notif_email } = req.body || {};
    const out = await dao.guardarContactoComplejo(req.params.id, { owner_phone, owner_email, notif_whats, notif_email });
    res.json({ ok: true, data: out });
  } catch (e) {
    console.error('POST contacto', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/complejos/:id/notificaciones', async (req, res) => {
  try {
    const { notif_whats, notif_email } = req.body || {};
    const out = await dao.guardarNotificaciones(req.params.id, { notif_whats, notif_email });
    res.json({ ok: true, data: out });
  } catch (e) {
    console.error('POST notificaciones', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});


// =======================
// Rutas MP credenciales (legacy manuales si las usás)
// =======================
app.post('/complejos/:id/mp/credenciales', async (req, res) => {
  try {
    const saved = await dao.guardarCredencialesMP(req.params.id, req.body || {});
    res.json({ ok: true, data: saved });
  } catch (e) {
    console.error('POST mp/credenciales', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.get('/complejos/:id/mp/credenciales', async (req, res) => {
  try {
    const creds = await dao.leerCredencialesMP(req.params.id);
    res.json({ ok: true, data: creds });
  } catch (e) {
    console.error('GET mp/credenciales', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});
// === Admin: bloquear / desbloquear un turno puntual ===
app.post("/admin/bloquear", async (req, res) => {
  try {
    const { complejoId, cancha, fechaISO, fecha, hora, motivo } = req.body || {};
    const fISO = fechaISO || fecha;
    if (!complejoId || !cancha || !fISO || !hora) {
      return res.status(400).json({ ok:false, error: "Faltan datos (complejoId/cancha/fechaISO/hora)" });
    }
    const r = await dao.bloquearTurno({ complex_id: complejoId, cancha, fechaISO: fISO, hora, motivo });
    return res.json({ ok: true, ...r });
  } catch (e) {
    console.error("admin/bloquear:", e);
    res.status(500).json({ ok:false, error:"Error al bloquear turno" });
  }
});

app.post("/admin/desbloquear", async (req, res) => {
  try {
    const { complejoId, cancha, fechaISO, fecha, hora } = req.body || {};
    const fISO = fechaISO || fecha;
    if (!complejoId || !cancha || !fISO || !hora) {
      return res.status(400).json({ ok:false, error: "Faltan datos (complejoId/cancha/fechaISO/hora)" });
    }
    const r = await dao.desbloquearTurno({ complex_id: complejoId, cancha, fechaISO: fISO, hora });
    return res.json({ ok: true, ...r });
  } catch (e) {
    console.error("admin/desbloquear:", e);
    res.status(500).json({ ok:false, error:"Error al desbloquear turno" });
  }
});
// =======================
// Health checks y datos panel
// =======================
app.get("/__health_db", async (_req, res) => {
  try {
    const d = await dao.listarComplejos();
    res.json({ ok: true, via: "db", count: Object.keys(d || {}).length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Salud simple para comprobar que corre
app.get("/", (req, res) => {
  res.type("text").send("OK ReComplejos backend");
});
// Endpoint de prueba (GET para abrirlo en el navegador)
app.get("/__test-email", async (req, res) => {
  try {
    const complejoId = String(req.query.complejoId || "").trim();
    if (!complejoId) return res.status(400).json({ ok: false, error: "Falta ?complejoId=" });

    const { subject, html } = plantillaMailReserva({
      complejoId,
      cancha: "Prueba",
      fecha: new Date().toISOString().slice(0, 10),
      hora: "20:00",
      nombre: "Tester",
      telefono: "",
      monto: 1234
    });

    await enviarEmail(complejoId, subject, html);
    res.json({ ok: true, msg: `Email de prueba enviado para complejo ${complejoId}.` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// =======================
// Listar reservas (DB → objeto para micomplejo.html)
// (Unificado: quitamos el duplicado de /reservas-obj)
// =======================
// ===== Listar reservas → objeto para el panel =====
app.get("/reservas-obj", async (_req, res) => {
  try {
    const q = `
      select
        r.complex_id,
        f.name as cancha,
        to_char(r.fecha,'YYYY-MM-DD') as fecha,
        to_char(r.hora,'HH24:MI')     as hora,
        r.status,
        coalesce(r.nombre,'')   as nombre,
        coalesce(r.telefono,'') as telefono,
        coalesce(r.monto,0)     as monto
      from reservations r
      join fields f on f.id = r.field_id
    `;
    const { rows } = await require('./db').query(q);

    const slug = (s = "") => String(s)
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');

    const out = {};
    for (const r of rows) {
      const key = `${r.complex_id}-${slug(r.cancha)}-${r.fecha}-${r.hora}`;
      out[key] = {
        status: r.status,
        nombre: r.nombre,
        telefono: r.telefono,
        monto: Number(r.monto) || 0
      };
    }
    res.json(out);
  } catch (e) {
    console.error("/reservas-obj error:", e);
    res.status(500).json({});
  }
});
// =======================
// Arranque del servidor
// =======================
app.listen(PORT, () => {
console.log("Servidor escuchando en puerto " + PORT);
});
