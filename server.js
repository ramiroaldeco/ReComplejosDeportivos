// ---- Cargas básicas
require('dotenv').config();
const dao = require('./dao');                   // <== NUEVO: capa de datos a Postgres
const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const fetch = require("node-fetch"); // para consultar el pago en el webhook y notificaciones
const { MercadoPagoConfig, Preference } = require("mercadopago");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir tus HTML/JS/CSS
app.use(express.static(__dirname));

// ---- Paths a archivos (se crean si no existen)
const pathDatos     = path.join(__dirname, "datos_complejos.json");
const pathReservas  = path.join(__dirname, "reservas.json");
const pathCreds     = path.join(__dirname, "credenciales_mp.json");
const pathIdx       = path.join(__dirname, "webhook_index.json"); // prefId -> clave

function leerJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return {}; }
}
function escribirJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}
if (!fs.existsSync(pathDatos))    escribirJSON(pathDatos, {});
if (!fs.existsSync(pathReservas)) escribirJSON(pathReservas, {});
if (!fs.existsSync(pathCreds))    escribirJSON(pathCreds, {});
if (!fs.existsSync(pathIdx))      escribirJSON(pathIdx, {});

// =======================
// CONFIG MP por complejo (SOLO OAuth)
// =======================
function tokenPara(complejoId) {
  const cred = leerJSON(pathCreds);
  const c = cred[complejoId] || {};
  const tok = c.oauth?.access_token;     // solo OAuth
  if (!tok) {
    const err = new Error(`El complejo ${complejoId} no tiene Mercado Pago conectado (OAuth).`);
    err.code = "NO_OAUTH";
    throw err;
  }
  return tok;
}

function mpClient(complejoId) {
  // no se usa, lo dejo por compat
  return new MercadoPagoConfig({ accessToken: tokenPara(complejoId) });
}

// Helpers de credenciales OAuth (persistencia en JSON)
const CREDS_MP_PATH_OAUTH = path.join(__dirname, "credenciales_mp.json");
function leerCredsMP_OAUTH() {
  try { return JSON.parse(fs.readFileSync(CREDS_MP_PATH_OAUTH, "utf8")); }
  catch { return {}; }
}
function escribirCredsMP_OAUTH(obj) {
  fs.writeFileSync(CREDS_MP_PATH_OAUTH, JSON.stringify(obj, null, 2));
}

// Detecta si el error devuelto por el SDK/HTTP es por token inválido
function isInvalidTokenError(err) {
  const m1 = (err && err.message || "").toLowerCase();
  const m2 = (err && err.response && (err.response.data?.message || err.response.body?.message) || "").toLowerCase();
  const m3 = (err && err.cause && String(err.cause).toLowerCase()) || "";
  return m1.includes("unauthorized") || m2.includes("invalid_token") || m3.includes("invalid_token");
}

// Refresca el token OAuth del complejo (si tiene refresh_token guardado)
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
    body: JSON.stringify(body),
  });

  const j = await r.json();
  if (!r.ok || !j.access_token) {
    throw new Error("No se pudo refrescar el token OAuth de Mercado Pago");
  }

  // Persistimos los nuevos tokens
  creds[complejoId] = creds[complejoId] || {};
  creds[complejoId].oauth = {
    access_token: j.access_token,
    refresh_token: j.refresh_token || c.oauth?.refresh_token,
    user_id: j.user_id ?? c.oauth?.user_id,
    updated_at: Date.now()
  };
  escribirCredsMP_OAUTH(creds);

  return j.access_token;
}

// === REFRESH OAuth Mercado Pago (variación usada en crear-preferencia) ===
async function refreshTokenMP(complejoId) {
  const allCreds = leerCredsMP_OAUTH(); // JSON completo { [complejoId]: { oauth: {...} } }
  const creds = allCreds?.[complejoId]?.oauth || null;

  if (!creds?.refresh_token) {
    throw new Error(`No hay refresh_token guardado para ${complejoId}`);
  }

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

  return newCreds.access_token;
}

// SDK con token que le pasemos
function mpClientCon(token) {
  const { MercadoPagoConfig, Preference } = require("mercadopago");
  const mp = new MercadoPagoConfig({ accessToken: token });
  return { Preference: new Preference(mp) };
}

// =======================
// HOLD anti doble-reserva (LEGADO sobre archivo; lo dejo por compat)
// =======================
const HOLD_MIN = parseInt(process.env.HOLD_MIN || "10", 10); // 10 min default

function estaHoldActiva(r) {
  return r && r.status === "hold" && r.holdUntil && Date.now() < r.holdUntil;
}
function limpiarHoldsVencidos() {
  const reservas = leerJSON(pathReservas);
  let cambio = false;
  for (const k of Object.keys(reservas)) {
    const r = reservas[k];
    if (r?.status === "hold" && r.holdUntil && Date.now() >= r.holdUntil) {
      // liberar
      delete reservas[k];
      cambio = true;
    }
  }
  if (cambio) escribirJSON(pathReservas, reservas);
}
setInterval(limpiarHoldsVencidos, 60 * 1000); // cada minuto

// =======================
// Helpers fecha/hora/clave (NUEVO)
// =======================
const TZ = "America/Argentina/Cordoba";

// normaliza nombre de cancha para la clave
function slugCancha(nombre=""){ 
  return String(nombre).toLowerCase().replace(/\s+/g,"").replace(/[^a-z0-9]/g,""); 
}

// YYYY-MM-DD válido y HH:mm válido
function esFechaISO(d){ return /^\d{4}-\d{2}-\d{2}$/.test(d); }
function esHora(h){ return /^\d{2}:\d{2}$/.test(h); }

// obtiene nombre de día (Lunes..Domingo) respetando TZ local
function nombreDia(fechaISO){
  const d = new Date(`${fechaISO}T00:00:00-03:00`); // TZ fija local
  const dias = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
  return dias[d.getDay()];
}

// dentro de franja (maneja cruces tipo 22:00->02:00)
function entre(hora, desde, hasta){
  if(!desde || !hasta) return false;
  return (desde <= hasta) ? (hora >= desde && hora <= hasta)
                          : (hora >= desde || hora <= hasta);
}

// valida: no pasado, dentro de horario configurado y cancha existente
function validarTurno({complejoId, canchaNombre, fecha, hora}){
  // *** OJO: ahora los datos de complejos salen de la DB ***
  const datos = _cacheComplejosCompat; // cache breve poblado por /datos_complejos
  const info = datos?.[complejoId];
  if(!info) return {ok:false, error:"Complejo inexistente"};

  // cancha existe
  const cancha = (info.canchas || []).find(c => slugCancha(c.nombre) === slugCancha(canchaNombre));
  if(!cancha) return {ok:false, error:"Cancha inexistente"};

  // fecha/hora formato
  if(!esFechaISO(fecha) || !esHora(hora)) return {ok:false, error:"Fecha u hora inválida"};

  // no pasado (comparando con ahora local)
  const ahora = new Date();
  const turno = new Date(`${fecha}T${hora}:00-03:00`);
  if (turno.getTime() < ahora.getTime()) return {ok:false, error:"Turno en el pasado"};

  // dentro de horarios del día
  const nomDia = nombreDia(fecha);
  const hDia = (info.horarios || {})[nomDia] || {};
  const desde = hDia.desde || "18:00";
  const hasta = hDia.hasta || "23:00";
  if(!entre(hora, desde, hasta)) return {ok:false, error:`Fuera de horario (${nomDia} ${desde}-${hasta})`};

  return {ok:true, cancha};
}

// arma clave canonical
function claveDe({complejoId, canchaNombre, fecha, hora}){
  return `${complejoId}-${slugCancha(canchaNombre)}-${fecha}-${hora}`;
}

// =======================
// RUTAS EXISTENTES (con BD) + NUEVAS
// =======================

// Caché pequeñito para validar sin consultar DB a cada request (se refresca en /datos_complejos)
let _cacheComplejosCompat = {};

// Datos del complejo (sin caché) -> AHORA DESDE BD
app.get("/datos_complejos", async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    const d = await dao.listarComplejos();     // <== BD
    _cacheComplejosCompat = d;                 // refresco cache para validarTurno
    res.json(d);
  } catch (e) {
    console.error("DB /datos_complejos", e);
    // fallback de emergencia al archivo si algo falla
    res.json(leerJSON(pathDatos));
  }
});

// Guardar datos (MERGE) -> AHORA A BD (mantengo archivo como backup)
app.post("/guardarDatos", async (req, res) => {
  try {
    const nuevos = req.body || {};
    await dao.guardarDatosComplejos(nuevos);   // <== BD
    // También actualizo el archivo como respaldo (opcional)
    const actuales = leerJSON(pathDatos);
    const merged = { ...actuales, ...nuevos };
    escribirJSON(pathDatos, merged);
    res.json({ ok: true });
  } catch (e) {
    console.error("DB /guardarDatos", e);
    res.status(500).json({ error: "DB error al guardar" });
  }
});

// NUEVA: alta/actualización de credenciales de MP por complejo (sigue en JSON)
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

// Reservas (objeto completo) -> AHORA DESDE BD
app.get("/reservas", async (_req, res) => {
  try {
    const r = await dao.listarReservasObjCompat(); // <== BD
    res.json(r);
  } catch (e) {
    console.error("DB /reservas", e);
    res.json(leerJSON(pathReservas)); // fallback
  }
});

// Guardar TODAS las reservas (bloquear/cancelar desde micomplejo.html) -> AHORA A BD
app.post("/guardarReservas", async (req, res) => {
  try {
    await dao.guardarReservasObjCompat(req.body || {}); // <== BD
    // opcional: backup a archivo
    escribirJSON(pathReservas, req.body || {});
    res.json({ ok: true });
  } catch (e) {
    console.error("DB /guardarReservas", e);
    res.status(500).json({ error: "DB error al guardar" });
  }
});

// Guardar UNA reserva directa (legado) -> mantengo archivo (no lo usás en front nuevo)
app.post("/guardarReserva", (req, res) => {
  const { clave, nombre, telefono } = req.body;
  const reservas = leerJSON(pathReservas);
  if (reservas[clave]) return res.status(400).json({ error: "Turno ya reservado" });
  reservas[clave] = { nombre, telefono, status: "approved", paidAt: Date.now() };
  escribirJSON(pathReservas, reservas);
  res.json({ ok: true });
});

// Login simple de dueño (slug + clave) -> AHORA CONTRA BD (clave_legacy)
app.post("/login", async (req, res) => {
  const { complejo, password } = req.body || {};
  try {
    const ok = await dao.loginDueno(complejo, password); // <== BD
    if (!ok.ok) return res.status(401).json({ error: "Contraseña incorrecta" });
    res.json({ ok: true });
  } catch (e) {
    console.error("DB /login", e);
    // fallback contra archivo
    const datos = leerJSON(pathDatos);
    if (!datos[complejo]) return res.status(404).json({ error: "Complejo inexistente" });
    const okArch = (datos[complejo].clave || "") === (password || "");
    if (!okArch) return res.status(401).json({ error: "Contraseña incorrecta" });
    res.json({ ok: true, via: "archivo" });
  }
});

// =======================
// NOTIFICACIONES opcionales (WhatsApp Cloud / Resend)
// =======================
async function enviarWhatsApp(complejoId, texto) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) return; // no configurado

  const datos = _cacheComplejosCompat;
  const para = (datos?.[complejoId]?.whatsappDueño) || process.env.ADMIN_WHATSAPP_TO;
  if (!para) return;

  const url = `https://graph.facebook.com/v20.0/${phoneId}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to: String(para),
    type: "text",
    text: { body: texto }
  };
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    console.error("WhatsApp noti error:", e?.message || e);
  }
}

async function enviarEmail(complejoId, asunto, html) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!key || !from) return;

  const datos = _cacheComplejosCompat;
  const para = (datos?.[complejoId]?.emailDueño) || process.env.ADMIN_EMAIL;
  if (!para) return;

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from,
        to: [para],
        subject: asunto,
        html
      })
    });
  } catch (e) {
    console.error("Email noti error:", e?.message || e);
  }
}

async function notificarAprobado({ clave, complejoId, nombre, telefono, monto }) {
  const texto = `✅ Nueva reserva confirmada
Complejo: ${complejoId}
Turno: ${clave}
Cliente: ${nombre} (${telefono})
Seña: $${monto}`;

  const html = `
    <h2>✅ Nueva reserva confirmada</h2>
    <p><strong>Complejo:</strong> ${complejoId}</p>
    <p><strong>Turno:</strong> ${clave}</p>
    <p><strong>Cliente:</strong> ${nombre} (${telefono})</p>
    <p><strong>Seña:</strong> $${monto}</p>
  `;

  await Promise.all([
    enviarWhatsApp(complejoId, texto),
    enviarEmail(complejoId, "Nueva reserva confirmada", html)
  ]);
}

// =======================
// NUEVOS ENDPOINTS: disponibilidad + estado-reserva
// =======================

// ¿Está libre este turno exacto? -> chequear contra DB
app.get("/disponible", async (req,res)=>{
  const { complejoId, cancha, fecha, hora } = req.query || {};
  const v = validarTurno({complejoId, canchaNombre: cancha, fecha, hora});
  if(!v.ok) return res.json({ ok:false, motivo:v.error });

  try {
    const obj = await dao.listarReservasObjCompat(); // BD
    const clave = claveDe({complejoId, canchaNombre: cancha, fecha, hora});
    const r = obj[clave];
    const ocupado = Boolean(r && (r.status === "approved" || (r.status === "hold" && r.holdUntil && Date.now() < r.holdUntil)));
    return res.json({ ok:true, libre: !ocupado });
  } catch (e) {
    // fallback a archivo
    const reservas = leerJSON(pathReservas);
    const clave = claveDe({complejoId, canchaNombre: cancha, fecha, hora});
    const r = reservas[clave];
    const ocupado = Boolean(r && (r.status === "approved" || estaHoldActiva(r)));
    return res.json({ ok:true, libre: !ocupado, via:"archivo" });
  }
});

// Estado de una reserva por clave -> desde DB
app.get("/estado-reserva", async (req,res)=>{
  const { clave } = req.query || {};
  if(!clave) return res.status(400).json({ error:"Falta clave" });
  try {
    const obj = await dao.listarReservasObjCompat();
    const r = obj[clave];
    if(!r) return res.json({ ok:true, existe:false, status:"none" });
    return res.json({ ok:true, existe:true, status:r.status, data:r });
  } catch (e) {
    // fallback archivo
    const reservas = leerJSON(pathReservas);
    const r = reservas[clave];
    if(!r) return res.json({ ok:true, existe:false, status:"none", via:"archivo" });
    return res.json({ ok:true, existe:true, status:r.status, data:r, via:"archivo" });
  }
});

// =======================
// PAGOS: crear preferencia + Webhook (SOLO OAuth)
// =======================
app.post("/crear-preferencia", async (req, res) => {
  const {
    complejoId,

    // NUEVOS CAMPOS
    cancha,     // nombre visible de la cancha
    fecha,      // YYYY-MM-DD
    hora,       // HH:mm

    // LEGADO (por compat): si viene clave la aceptamos, pero recomendamos NO usarla desde el front
    clave: claveLegacy,

    titulo,
    precio,     // puede venir o no
    senia,      // puede venir o no
    nombre,
    telefono
  } = req.body || {};

  // Aceptar senia o precio indistintamente
  const monto = Number((precio ?? senia));
  if (!complejoId || !monto) {
    return res.status(400).json({ error: "Faltan datos (complejoId/monto)" });
  }

  // Si llegaron los campos nuevos, VALIDAMOS y construimos clave canonical
  let clave = claveLegacy;
  if (cancha && fecha && hora) {
    const v = validarTurno({complejoId, canchaNombre: cancha, fecha, hora});
    if(!v.ok) return res.status(400).json({ error: v.error });
    clave = claveDe({complejoId, canchaNombre: cancha, fecha, hora});
  }
  if (!clave) {
    return res.status(400).json({ error: "Faltan cancha/fecha/hora (o clave)" });
  }

  // ===== HOLD (DB con fallback a archivo) =====
const claveReserva = clave;
try {
  const okHold = await dao.crearHold({
    complex_id: complejoId,
    cancha,
    fechaISO: fecha,
    hora,
    nombre,
    telefono,
    monto,
    holdMinutes: HOLD_MIN
  });
  if (!okHold) {
    return res.status(409).json({ error: "El turno ya está tomado" });
  }
} catch (e) {
  console.error("DB crear hold falló, uso archivo:", e?.message || e);
  const rr = leerJSON(pathReservas);
  const ya = rr[claveReserva];
  const ahora = Date.now();

  // si ya estaba tomado (approved) o con hold activo → 409
  if (ya && (ya.status === "approved" || (ya.status === "hold" && ya.holdUntil && ya.holdUntil > ahora))) {
    return res.status(409).json({ error: "El turno ya está tomado" });
  }

  // creo HOLD en archivo como compat
  rr[claveReserva] = {
    ...(ya || {}),
    status: "hold",
    holdUntil: ahora + HOLD_MIN * 60 * 1000,
    nombre: nombre || "",
    telefono: telefono || "",
    complejoId,
    monto,
    cancha: cancha || "",
    fecha: fecha || "",
    hora: hora || ""
  };
  escribirJSON(pathReservas, rr);
}
  // Mantengo también el HOLD en archivo como compat (por si mirás admin viejo)
  const reservas = leerJSON(pathReservas);
  const holdUntil = Date.now() + HOLD_MIN * 60 * 1000;
  reservas[clave] = {
    status: "hold",
    holdUntil,
    nombre: nombre || "",
    telefono: telefono || "",
    complejoId,
    monto,
    cancha: cancha || "",
    fecha: fecha || "",
    hora: hora || ""
  };
  escribirJSON(pathReservas, reservas);

  // Helper local: crea la preferencia usando el token indicado (devuelvo forma segura)
  const crearCon = async (accessToken) => {
    const mp = new MercadoPagoConfig({ accessToken });
    const preference = new Preference(mp);
    const r = await preference.create({
      body: {
        items: [{
          title: titulo || "Seña de reserva",
          unit_price: monto,
          quantity: 1,
          currency_id: "ARS"
        }],
        back_urls: {
          success: `${process.env.PUBLIC_URL}/reservar-exito.html`,
          pending: `${process.env.PUBLIC_URL}/reservar-pendiente.html`,
          failure: `${process.env.PUBLIC_URL}/reservar-error.html`
        },
        auto_return: "approved",
        notification_url: `${process.env.BACKEND_URL}/webhook-mp`,
        metadata: { clave, complejoId, nombre: nombre || "", telefono: telefono || "" }
      }
    });
    return {
      id: r?.id || r?.body?.id || r?.response?.id,
      init_point: r?.init_point || r?.body?.init_point || r?.response?.init_point,
      sandbox_init_point: r?.sandbox_init_point || r?.body?.sandbox_init_point || null
    };
  };

  try {
    // 1) Token actual del dueño para este complejo
    let tokenActual;
    try {
      tokenActual = await tokenPara(complejoId);
    } catch (e) {
      // Liberar HOLD si el complejo no tiene OAuth (en archivo y DB)
      const rr = leerJSON(pathReservas);
      delete rr[clave];
      escribirJSON(pathReservas, rr);
      // liberar en DB: (dejamos que expire solo o podríamos marcar cancelado)

      if (e.code === "NO_OAUTH") {
        return res.status(409).json({
          error: "Este complejo aún no conectó su Mercado Pago. Pedile al dueño que toque 'Conectar Mercado Pago'."
        });
      }
      return res.status(500).json({ error: "Error obteniendo credenciales del dueño" });
    }

    // 2) Primer intento de creación
    let result;
    try {
      result = await crearCon(tokenActual);
    } catch (err) {
      const status = err?.status || err?.body?.status;
      const msg = (err?.body && (err.body.message || err.body.error)) || err?.message || "";
      if (status === 401 || /invalid_token/i.test(msg)) {
        try {
          const tokenNuevo = await refreshTokenMP(complejoId);
          result = await crearCon(tokenNuevo);
        } catch (err2) {
          const rr = leerJSON(pathReservas);
          delete rr[clave];
          escribirJSON(pathReservas, rr);
          const detalle2 =
            (err2?.body && (err2.body.message || err2.body.error || (Array.isArray(err2.body.cause) && err2.body.cause[0]?.description))) ||
            err2?.message ||
            "Error creando preferencia";
          return res.status(400).json({ error: detalle2 });
        }
      } else {
        const rr = leerJSON(pathReservas);
        delete rr[clave];
        escribirJSON(pathReservas, rr);
        const detalle =
          (err?.body && (err.body.message || err.body.error || (Array.isArray(err.body.cause) && err.body.cause[0]?.description))) ||
          err?.message ||
          "Error creando preferencia";
        return res.status(400).json({ error: detalle });
      }
    }

    // 3) Preferencia OK
    reservas[clave] = {
      ...(reservas[clave] || {}),
      status: "hold",
      preference_id: result.id,
      init_point: result.init_point,
      sandbox_init_point: result.sandbox_init_point || null,
      created_at: Date.now()
    };
    escribirJSON(pathReservas, reservas);

    return res.json({
      preference_id: result.id,
      init_point: result.init_point
    });

  } catch (e) {
    // Cualquier otra excepción: liberar HOLD archivo
    const rr = leerJSON(pathReservas);
    delete rr[clave];
    escribirJSON(pathReservas, rr);

    const detalle =
      (e?.body && (e.body.message || e.body.error || (Array.isArray(e.body.cause) && e.body.cause[0]?.description))) ||
      e?.message ||
      "Error creando preferencia";
    return res.status(400).json({ error: detalle });
  }
});

/* ============================================================
   LEGADO (backup): tu flujo anterior con retry/refresh
   Queda por si querés volver. No se invoca.
   ============================================================ */
async function _legacyCrearPreferencia({ complejoId, clave, titulo, monto, holdUntil }) {
  const FRONT_URL  = process.env.PUBLIC_URL  || `https://ramiroaldeco.github.io/recomplejos-frontend`;
  const BACK_URL   = process.env.BACKEND_URL || `https://recomplejos-backend.onrender.com`;
  const success = `${FRONT_URL}/reservar-exito.html`;
  const pending = `${FRONT_URL}/reservar-pendiente.html`;
  const failure = `${FRONT_URL}/reservar-error.html`;

  const prefBody = {
    items: [
      { title: titulo || "Seña de reserva", unit_price: monto, quantity: 1 }
    ],
    back_urls: { success, pending, failure },
    auto_return: "approved",
    notification_url: `${BACK_URL}/webhook-mp`,
    metadata: { clave, complejoId }
  };

  let result;
  let pref;
  let initPoint = "";

  try {
    const tokenActual = tokenPara(complejoId);
    const mp = new MercadoPagoConfig({ access_token: tokenActual });
    const preference = new Preference(mp);
    result = await preference.create({ body: prefBody });

    pref = result?.id || result?.body?.id || result?.response?.id;
    initPoint =
      result?.init_point ||
      result?.body?.init_point ||
      result?.response?.init_point || "";

  } catch (err1) {
    if (isInvalidTokenError(err1)) {
      try {
        const nuevoToken = await refreshOAuthToken(complejoId);
        const mp2 = new MercadoPagoConfig({ access_token: nuevoToken });
        const preference2 = new Preference(mp2);
        const r2 = await preference2.create({ body: prefBody });

        result = r2;
        pref = r2?.id || r2?.body?.id || r2?.response?.id;
        initPoint =
          r2?.init_point ||
          r2?.body?.init_point ||
          r2?.response?.init_point || "";

      } catch (err2) {
        const rr = leerJSON(pathReservas);
        delete rr[clave];
        escribirJSON(pathReservas, rr);

        const info = err2?.message || "Error creando preferencia";
        console.error("MP error tras refresh:", info);
        return { ok:false, error: info };
      }
    } else {
      const rr = leerJSON(pathReservas);
      delete rr[clave];
      escribirJSON(pathReservas, rr);

      const info = err1?.message || "Error creando preferencia";
      console.error("MP error:", info);
      return { ok:false, error: info };
    }
  }

  try {
    const idx = leerJSON(pathIdx);
    idx[pref] = { clave, complejoId };
    escribirJSON(pathIdx, idx);

    const r2 = leerJSON(pathReservas);
    if (r2[clave]) {
      r2[clave].status = "pending";
      r2[clave].preference_id = pref;
      r2[clave].init_point = initPoint || "";
      r2[clave].holdUntil = holdUntil;
      escribirJSON(pathReservas, r2);
    }

    return { ok:true, preference_id: pref, init_point: initPoint || null };
  } catch (err) {
    console.error("Post-crear-preferencia error:", err?.message || err);
    return { ok:true, preference_id: pref, init_point: initPoint || null };
  }
}

// =======================
// Webhook de Mercado Pago
// =======================
app.post("/webhook-mp", async (req, res) => {
  try {
    // Aceptamos rápido para que MP no reintente de más
    res.sendStatus(200);

    // MP envía { action, data: { id }, type } o similar
    const body = req.body || {};
    const paymentId = body?.data?.id || body?.id || body?.resource?.split?.("/")?.pop?.();
    if (!paymentId) return;

    // Consultamos el pago para conocer status y preference_id
    const tokensATestar = [];
    const cred = leerJSON(pathCreds);
    if (process.env.MP_ACCESS_TOKEN) tokensATestar.push(process.env.MP_ACCESS_TOKEN);
    for (const k of Object.keys(cred)) {
      if (cred[k]?.oauth?.access_token) tokensATestar.push(cred[k].oauth.access_token); // OAuth primero
      if (cred[k]?.access_token)        tokensATestar.push(cred[k].access_token);
      if (cred[k]?.mp_access_token)     tokensATestar.push(cred[k].mp_access_token);
    }

    let pago = null;
    for (const t of tokensATestar) {
      try {
        if (!t) continue;
        const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
          headers: { Authorization: `Bearer ${t}` }
        });
        if (r.ok) { pago = await r.json(); break; }
      } catch { /* seguimos probando */ }
    }
    if (!pago) return;

    const prefId = pago?.order?.id || pago?.preference_id || pago?.metadata?.preference_id;
    const status = pago?.status; // approved | pending | rejected | in_process | cancelled

    // Encontramos la reserva por metadata o por índice pref -> clave
    let clave = pago?.metadata?.clave;
    let complejoId = pago?.metadata?.complejoId;
    if ((!clave || !complejoId) && prefId) {
      const idx = leerJSON(pathIdx);
      clave = clave || idx[prefId]?.clave;
      complejoId = complejoId || idx[prefId]?.complejoId;
    }
    if (!clave) return;

    // ==== ACTUALIZAR EN DB ====
    try {
      await dao.actualizarReservaTrasPago({
        preference_id: prefId,
        payment_id: pago?.id,
        status,
        nombre: pago?.metadata?.nombre || null,
        telefono: pago?.metadata?.telefono || null
      });
    } catch (e) {
      console.error("DB actualizar tras pago:", e);
    }

    // ==== Mantener compat en archivo (para paneles viejos) ====
    const reservas = leerJSON(pathReservas);
    const r = reservas[clave] || {};
    r.preference_id = prefId || r.preference_id;
    r.payment_id = pago?.id || r.payment_id;

    if (status === "approved") {
      r.status = "approved";
      r.paidAt = Date.now();
      r.nombre = r.nombre || "";
      r.telefono = r.telefono || "";
      r.complejoId = r.complejoId || complejoId || "";

      const infoNoti = {
        clave,
        complejoId: r.complejoId,
        nombre: r.nombre,
        telefono: r.telefono,
        monto: r.monto || r.precio || r.senia || ""
      };
      escribirJSON(pathReservas, { ...reservas, [clave]: r });
      notificarAprobado(infoNoti).catch(()=>{});
      delete r.holdUntil;

    } else if (status === "rejected" || status === "cancelled") {
      delete reservas[clave];
      escribirJSON(pathReservas, reservas);
      return;

    } else {
      r.status = "pending"; // in_process / pending
      escribirJSON(pathReservas, { ...reservas, [clave]: r });
      return;
    }

    escribirJSON(pathReservas, { ...reservas, [clave]: r });
  } catch (e) {
    console.error("Error en webhook:", e?.message || e);
  }
});

// ===== OAuth Mercado Pago: conectar / estado / callback =====
app.get("/mp/conectar", (req, res) => {
  const { complejoId } = req.query;
  if (!complejoId) return res.status(400).send("Falta complejoId");
  
  const u = new URL("https://auth.mercadopago.com/authorization");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", process.env.MP_CLIENT_ID);
  u.searchParams.set("redirect_uri", process.env.MP_REDIRECT_URI);
  u.searchParams.set("state", complejoId);
  u.searchParams.set("scope", "offline_access read write"); // refresh + APIs

  res.redirect(u.toString());
});

app.get("/mp/estado", (req, res) => {
  const { complejoId } = req.query;
  if (!complejoId) return res.status(400).json({ ok:false, error:"Falta complejoId" });

  const creds = leerCredsMP_OAUTH();
  const conectado = Boolean(creds[complejoId]?.oauth?.access_token);
  res.json({ ok:true, conectado });
});

app.get("/mp/callback", async (req, res) => {
  const { code, state: complejoId } = req.query;
  if (!code || !complejoId) {
    return res.status(400).send("❌ Faltan parámetros en el callback");
  }

  try {
    // Intercambio del authorization_code por tokens OAuth
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
    if (!r.ok || !data.access_token) {
      console.error("OAuth error:", data);
      return res.status(400).send("❌ No se pudo completar la conexión con Mercado Pago.");
    }

    // Guardamos tokens en credenciales_mp.json
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

    res.send("✅ Mercado Pago conectado. Ya podés cerrar esta pestaña.");
  } catch (e) {
    console.error("Callback OAuth MP error:", e?.message || e);
    res.status(500).send("❌ Error inesperado conectando Mercado Pago.");
  }
});

// =======================
// Arranque del server
// =======================
app.listen(PORT, () => {
  console.log(`Server escuchando en http://0.0.0.0:${PORT}`);
});
