// server.js (Reservas Para Complejos) — versión corregida
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch"); // v2 en package.json
const { MercadoPagoConfig, Preference } = require("mercadopago");

const dao = require("./dao");

// --- App & middlewares
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// --- Paths de respaldos JSON (compat)
const pathDatos    = path.join(__dirname, "datos_complejos.json");
const pathReservas = path.join(__dirname, "reservas.json");
const pathCreds    = path.join(__dirname, "credenciales_mp.json");
const pathIdx      = path.join(__dirname, "prefidx.json");

// --- Helpers de archivo JSON
function leerJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}
function escribirJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

// asegurar archivos de backup
if (!fs.existsSync(pathDatos))    escribirJSON(pathDatos, {});
if (!fs.existsSync(pathReservas)) escribirJSON(pathReservas, {});
if (!fs.existsSync(pathCreds))    escribirJSON(pathCreds, {});
if (!fs.existsSync(pathIdx))      escribirJSON(pathIdx, {});

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
 * Nuevo: obtener el access_token de MP priorizando la DB (tabla mp_oauth)
 * y con fallback a credenciales_mp.json por compatibilidad.
 * -> Usalo con:  const token = await tokenParaAsync(complejoId)
 */
async function tokenParaAsync(complejoId) {
  // 1) DB primero
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

/**
 * Legacy (solo archivo). La dejo por compat, pero preferí usar tokenParaAsync().
 */
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
// Refresca token con refresh_token guardado
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

  // persistir
  creds[complejoId] = creds[complejoId] || {};
  creds[complejoId].oauth = {
    ...(creds[complejoId].oauth || {}),
    access_token: j.access_token,
    refresh_token: j.refresh_token || c.oauth?.refresh_token,
    user_id: j.user_id ?? c.oauth?.user_id,
    updated_at: Date.now()
  };
  escribirCredsMP_OAUTH(creds);
  return j.access_token;
}

// Variante usada en crear-preferencia
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
  return newCreds.access_token;
}

// =======================
// HOLD anti doble-reserva (legacy archivo de compat + limpieza)
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
      delete reservas[k]; // liberar
      cambio = true;
    }
  }
  if (cambio) escribirJSON(pathReservas, reservas);
}
setInterval(limpiarHoldsVencidos, 60 * 1000); // cada minuto

// =======================
// Helpers fecha/hora/clave
// =======================
function slugCancha(nombre=""){
  return String(nombre).toLowerCase().replace(/\s+/g,"").replace(/[^a-z0-9]/g,"");
}
function esFechaISO(d){ return /^\d{4}-\d{2}-\d{2}$/.test(d); }
function esHora(h){ return /^\d{2}:\d{2}$/.test(h); }
function nombreDia(fechaISO){
  const d = new Date(`${fechaISO}T00:00:00-03:00`);
  const dias = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
  return dias[d.getDay()];
}
function entre(hora, desde, hasta){
  if(!desde || !hasta) return false;
  return (desde <= hasta) ? (hora >= desde && hora <= hasta)
                          : (hora >= desde || hora <= hasta);
}
function validarTurno({complejoId, canchaNombre, fecha, hora}){
  const datos = _cacheComplejosCompat; // cache poblado en /datos_complejos
  const info = datos?.[complejoId];
  if(!info) return {ok:false, error:"Complejo inexistente"};

  const cancha = (info.canchas || []).find(c => slugCancha(c.nombre) === slugCancha(canchaNombre));
  if(!cancha) return {ok:false, error:"Cancha inexistente"};

  if(!esFechaISO(fecha) || !esHora(hora)) return {ok:false, error:"Fecha u hora inválida"};

  const ahora = new Date();
  const turno = new Date(`${fecha}T${hora}:00-03:00`);
  if (turno.getTime() < ahora.getTime()) return {ok:false, error:"Turno en el pasado"};

  const nomDia = nombreDia(fecha);
  const hDia = (info.horarios || {})[nomDia] || {};
  const desde = hDia.desde || "18:00";
  const hasta = hDia.hasta || "23:00";
  if(!entre(hora, desde, hasta)) return {ok:false, error:`Fuera de horario (${nomDia} ${desde}-${hasta})`};

  return {ok:true, cancha};
}
function claveDe({complejoId, canchaNombre, fecha, hora}){
  return `${complejoId}-${slugCancha(canchaNombre)}-${fecha}-${hora}`;
}

// =======================
// RUTAS EXISTENTES (con BD) + NUEVAS
// =======================

// Cache breve para validación
let _cacheComplejosCompat = {};

// Datos de complejos (desde BD) con fallback a archivo
app.get("/datos_complejos", async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    const d = await dao.listarComplejos();   // BD
    _cacheComplejosCompat = d;               // refresca cache
    res.json(d);
  } catch (e) {
    console.error("DB /datos_complejos", e);
    res.json(leerJSON(pathDatos));           // fallback archivo
  }
});

// Guardar datos mergeados (onboarding)
app.post("/guardarDatos", async (req, res) => {
  try {
    const nuevos = req.body || {};
    await dao.guardarDatosComplejos(nuevos); // BD
    const actuales = leerJSON(pathDatos);    // backup opcional
    const merged = { ...actuales, ...nuevos };
    escribirJSON(pathDatos, merged);
    res.json({ ok: true });
  } catch (e) {
    console.error("DB /guardarDatos", e);
    res.status(500).json({ error: "DB error al guardar" });
  }
});

// Alta/actualización credencial “legacy” (si hiciera falta para pruebas)
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

// Reservas → leer de BD (compat: archivo si falla)
app.get("/reservas", async (_req, res) => {
  try {
    const r = await dao.listarReservasObjCompat(); // BD
    res.json(r);
  } catch (e) {
    console.error("DB /reservas", e);
    res.json(leerJSON(pathReservas)); // fallback
  }
});
// === LOGIN DUEÑO ===
app.post("/login", async (req, res) => {
  const id   = String(req.body?.complejo || "").trim();   // slug del complejo
  const pass = String(req.body?.password || "").trim();   // clave del dueño

  if (!id || !pass) return res.status(400).json({ error: "Faltan datos" });

  let ok = false;

  // 1) Chequeo en la DB
  try {
    const r = await dao.loginDueno(id, pass); // debe devolver { ok: true/false }
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


// Guardar reservas masivo (panel dueño)
app.post("/guardarReservas", async (req, res) => {
  try {
    await dao.guardarReservasObjCompat(req.body || {}); // BD
    escribirJSON(pathReservas, req.body || {});         // backup
    res.json({ ok: true });
  } catch (e) {
    console.error("DB /guardarReservas", e);
    res.status(500).json({ error: "DB error al guardar" });
  }
});

// ¿Está libre este turno?
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
  } catch {
    // fallback archivo
    const reservas = leerJSON(pathReservas);
    const clave = claveDe({complejoId, canchaNombre: cancha, fecha, hora});
    const r = reservas[clave];
    const ocupado = Boolean(r && (r.status === "approved" || estaHoldActiva(r)));
    return res.json({ ok:true, libre: !ocupado, via:"archivo" });
  }
});

// Estado de una reserva por clave
app.get("/estado-reserva", async (req,res)=>{
  const { clave } = req.query || {};
  if(!clave) return res.status(400).json({ error:"Falta clave" });
  try {
    const obj = await dao.listarReservasObjCompat();
    const r = obj[clave];
    if(!r) return res.json({ ok:true, existe:false, status:"none" });
    return res.json({ ok:true, existe:true, status:r.status, data:r });
  } catch {
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
    cancha, fecha, hora,
    // LEGADO
    clave: claveLegacy,
    titulo,
    precio, senia,
    nombre, telefono
  } = req.body || {};

  const monto = Number((precio ?? senia));
  if (!complejoId || !monto) {
    return res.status(400).json({ error: "Faltan datos (complejoId/monto)" });
  }

  // construir/validar clave
  let clave = claveLegacy;
  if (cancha && fecha && hora) {
    const v = validarTurno({complejoId, canchaNombre: cancha, fecha, hora});
    if(!v.ok) return res.status(400).json({ error: v.error });
    clave = claveDe({complejoId, canchaNombre: cancha, fecha, hora});
  }
  if (!clave) {
    return res.status(400).json({ error: "Faltan cancha/fecha/hora (o clave)" });
  }

  // --- HOLD en BD (solo si llegaron cancha/fecha/hora) ---
if (cancha && fecha && hora) {
  const v = validarTurno({ complejoId, canchaNombre: cancha, fecha, hora });
  if (!v.ok) return res.status(400).json({ error: v.error });

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
    console.error("DB crear hold:", e);
    // No rompas el flujo: seguimos sin HOLD en BD (legacy),
    // igual se hará HOLD en archivo más abajo.
  }
} else if (!claveLegacy) {
  // Si no hay datos del turno ni clave legacy, no podemos seguir.
  return res.status(400).json({ error: "Faltan cancha/fecha/hora (o clave)" });
}
  // HOLD también en archivo (compat panel viejo)
  const reservas = leerJSON(pathReservas);
  const holdUntil = Date.now() + HOLD_MIN * 60 * 1000;
  reservas[clave] = {
    ...(reservas[clave] || {}),
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

  // helper para crear preferencia con el token que toque
  const crearCon = async (accessToken) => {
    const mp = new MercadoPagoConfig({ accessToken });
    const preference = new Preference(mp);
    return await preference.create({
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
  };

  try {
    // 1) token actual del dueño
    let tokenActual;
    try {
      // ahora
tokenActual = await tokenParaAsync(complejoId);

    } catch (e) {
      // liberar hold en archivo
      const rr = leerJSON(pathReservas);
      delete rr[clave];
      escribirJSON(pathReservas, rr);

      if (e.code === "NO_OAUTH") {
        return res.status(409).json({
          error: "Este complejo aún no conectó su Mercado Pago. Pedile al dueño que toque 'Conectar Mercado Pago'."
        });
      }
      return res.status(500).json({ error: "Error obteniendo credenciales del dueño" });
    }

    // 2) Intento de creación con retry por token vencido
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
            err2?.message || "Error creando preferencia";
          return res.status(400).json({ error: detalle2 });
        }
      } else {
        const rr = leerJSON(pathReservas);
        delete rr[clave];
        escribirJSON(pathReservas, rr);
        const detalle =
          (err?.body && (err.body.message || err.body.error || (Array.isArray(err.body.cause) && err.body.cause[0]?.description))) ||
          err?.message || "Error creando preferencia";
        return res.status(400).json({ error: detalle });
      }
    }

    // 3) Preferencia OK → indexamos prefId -> clave/complejo y devolvemos
    const prefId   = result?.id || result?.body?.id || result?.response?.id;
    const initPoint = result?.init_point || result?.body?.init_point || result?.response?.init_point || "";

    const idx = leerJSON(pathIdx);
    idx[prefId] = { clave, complejoId };
    escribirJSON(pathIdx, idx);

    const r2 = leerJSON(pathReservas);
    if (r2[clave]) {
      r2[clave] = {
        ...r2[clave],
        status: "pending",
        preference_id: prefId,
        init_point: initPoint,
        holdUntil
      };
      escribirJSON(pathReservas, r2);
    }

    return res.json({ preference_id: prefId, init_point: initPoint });
  } catch (e) {
    // Excepción general → liberar hold en archivo
    const rr = leerJSON(pathReservas);
    delete rr[clave];
    escribirJSON(pathReservas, rr);

    const detalle =
      (e?.body && (e.body.message || e.body.error || (Array.isArray(e.body.cause) && e.body.cause[0]?.description))) ||
      e?.message || "Error creando preferencia";
    return res.status(400).json({ error: detalle });
  }
});

// =======================
// Webhook de Mercado Pago
// =======================
app.post("/webhook-mp", async (req, res) => {
  try {
    // responder rápido para que MP no reintente de más
    res.sendStatus(200);

    const body = req.body || {};
    const paymentId = body?.data?.id || body?.id;
    if (!paymentId) return;

    // buscamos el pago consultando con cualquier token válido que tengamos
    const tokensATestar = [];
    const cred = leerJSON(pathCreds);
    if (process.env.MP_ACCESS_TOKEN) tokensATestar.push(process.env.MP_ACCESS_TOKEN);
    for (const k of Object.keys(cred)) {
      if (cred[k]?.oauth?.access_token) tokensATestar.push(cred[k].oauth.access_token);
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
      } catch { /* seguir probando */ }
    }
    if (!pago) return;

    const prefId = pago?.order?.id || pago?.preference_id || pago?.metadata?.preference_id;
    const status = pago?.status; // approved | pending | rejected | in_process | cancelled

    // localizar clave/complejo por metadata o índice pref -> clave
    let clave = pago?.metadata?.clave;
    let complejoId = pago?.metadata?.complejoId;
    if ((!clave || !complejoId) && prefId) {
      const idx = leerJSON(pathIdx);
      clave = clave || idx[prefId]?.clave;
      complejoId = complejoId || idx[prefId]?.complejoId;
    }
    if (!clave) return;

    // actualizar BD (si está disponible)
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

    // mantener compat en archivo
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

      escribirJSON(pathReservas, { ...reservas, [clave]: r });
      // notificaciones (opcionales)
      const infoNoti = {
        clave,
        complejoId: r.complejoId,
        nombre: r.nombre,
        telefono: r.telefono,
        monto: r.monto || r.precio || r.senia || ""
      };
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

// ===== OAuth Mercado Pago: conectar / estado / callback
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
    // si vienen mal los params, vuelvo al onboarding con error
    const u = new URL(`${process.env.PUBLIC_URL}/onboarding.html`);
    u.searchParams.set("mp", "error");
    return res.redirect(u.toString());
  }

  try {
    // Intercambio authorization_code → tokens
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
      // redirijo con error si falló el intercambio
      const u = new URL(`${process.env.PUBLIC_URL}/onboarding.html`);
      u.searchParams.set("complejo", complejoId);
      u.searchParams.set("mp", "error");
      return res.redirect(u.toString());
    }

    // Persisto credenciales OAuth del DUEÑO de ese complejo
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

    // Redirijo al onboarding con confirmación
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
// Notificaciones opcionales (WhatsApp y email)
// =======================
async function enviarWhatsApp(complejoId, texto) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) return;

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
      body: JSON.stringify({ from, to: [para], subject: asunto, html })
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
// Arranque
// =======================
app.listen(PORT, () => {
  console.log(`Server escuchando en http://0.0.0.0:${PORT}`);
});
