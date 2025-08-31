// ---- Cargas básicas
require("dotenv").config();
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

// ---- Config MP por complejo
// ---- Config MP por complejo (SOLO OAuth)
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
  return new MercadoPagoConfig({ access_token: tokenPara(complejoId) });
}
// =======================
// PARCHE AGREGADO (refresh + retry si invalid_token)
// =======================

// Helpers con nombres únicos para evitar colisiones
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

// ---- Anti doble-reserva: HOLD
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
// RUTAS EXISTENTES (no tocamos nombres)
// =======================

// Datos del complejo (sin caché)
app.get("/datos_complejos", (_req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.json(leerJSON(pathDatos));
});


app.post("/guardarDatos", (req, res) => {
  // Guarda el JSON completo (usa onboarding y panel)
  escribirJSON(pathDatos, req.body);
  res.json({ ok: true });
});

// NUEVA: alta/actualización de credenciales de MP por complejo
app.post("/alta-credencial", (req, res) => {
  const { id, mp_access_token, access_token } = req.body || {};
  if (!id || !(mp_access_token || access_token)) {
    return res.status(400).json({ error: "Falta id o token" });
  }
  const cred = leerJSON(pathCreds);
  cred[id] = cred[id] || {};
  // normalizamos a 'access_token' (el server lo busca así)
  cred[id].access_token = access_token || mp_access_token;
  escribirJSON(pathCreds, cred);
  res.json({ ok: true });
});

// Reservas (objeto completo)
app.get("/reservas", (_req, res) => {
  res.json(leerJSON(pathReservas));
});

// Guardar UNA reserva directa (lo usa reservar-exito.html si querés mantenerlo)
app.post("/guardarReserva", (req, res) => {
  const { clave, nombre, telefono } = req.body;
  const reservas = leerJSON(pathReservas);
  if (reservas[clave]) return res.status(400).json({ error: "Turno ya reservado" });
  reservas[clave] = { nombre, telefono, status: "approved", paidAt: Date.now() };
  escribirJSON(pathReservas, reservas);
  res.json({ ok: true });
});

// Guardar TODAS las reservas (bloquear/cancelar desde micomplejo.html)
app.post("/guardarReservas", (req, res) => {
  escribirJSON(pathReservas, req.body || {});
  res.json({ ok: true });
});

// Login simple de dueño (slug + clave en datos_complejos.json)
app.post("/login", (req, res) => {
  const { complejo, password } = req.body || {};
  const datos = leerJSON(pathDatos);
  if (!datos[complejo]) return res.status(404).json({ error: "Complejo inexistente" });
  const ok = (datos[complejo].clave || "") === (password || "");
  if (!ok) return res.status(401).json({ error: "Contraseña incorrecta" });
  res.json({ ok: true });
});

// =======================
// Notificaciones opcionales (WhatsApp Cloud / Resend)
// =======================

async function enviarWhatsApp(complejoId, texto) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) return; // no configurado

  const datos = leerJSON(pathDatos);
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

  const datos = leerJSON(pathDatos);
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
// PAGOS: crear preferencia + Webhook
// =======================

// =======================
// PAGOS: crear preferencia + Webhook (SOLO OAuth)
// =======================

app.post("/crear-preferencia", async (req, res) => {
  const {
    complejoId,
    clave,
    titulo,
    precio,     // puede venir o no
    senia,      // puede venir o no
    nombre,
    telefono
  } = req.body || {};

  // Aceptar senia o precio indistintamente
  const monto = Number((precio ?? senia));
  if (!complejoId || !clave || !monto) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  const reservas = leerJSON(pathReservas);

  // ¿ya reservado? (aprobado o con HOLD vigente)
  const existente = reservas[clave];
  if (existente && (existente.status === "approved" || estaHoldActiva(existente))) {
    return res.status(409).json({ error: "El turno ya está tomado" });
  }

  // HOLD temporal para bloquear el turno mientras se crea la preferencia
  const holdUntil = Date.now() + HOLD_MIN * 60 * 1000;
  reservas[clave] = {
    status: "hold",
    holdUntil,
    nombre: nombre || "",
    telefono: telefono || "",
    complejoId,
    monto
  };
  escribirJSON(pathReservas, reservas);

  // 1) Chequear que el complejo tenga OAuth (tokenPara ahora tira error si falta)
  let mpConfig;
  try {
    // Si tenés helper mpClient(complejoId) que usa tokenPara, podés usarlo:
    // mpConfig = mpClient(complejoId);
    // O crear el config directo con el token OAuth del dueño:
    const tokenDeDueno = tokenPara(complejoId);
    mpConfig = new MercadoPagoConfig({ access_token: tokenDeDueno });
  } catch (e) {
    // Liberar HOLD si el complejo no tiene OAuth
    delete reservas[clave];
    escribirJSON(pathReservas, reservas);

    if (e.code === "NO_OAUTH") {
      return res.status(409).json({
        error: "Este complejo aún no conectó su Mercado Pago. Pedile al dueño que toque 'Conectar Mercado Pago'."
      });
    }
    return res.status(500).json({ error: "Error obteniendo credenciales del dueño" });
  }

  // 2) Crear preferencia SIEMPRE con el token OAuth del dueño
  try {
    const preference = new Preference(mpConfig);
    const result = await preference.create({
      body: {
        items: [{
          title: titulo || "Seña de reserva",
          unit_price: monto,
          quantity: 1
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

    // Guardar datos de la preferencia en la reserva
    reservas[clave] = {
      ...reservas[clave],
      status: "hold",                  // se mantiene en HOLD hasta el webhook
      preference_id: result.id,
      init_point: result.init_point,
      sandbox_init_point: result.sandbox_init_point || null,
      created_at: Date.now()
    };
    escribirJSON(pathReservas, reservas);

    // Devolver al frontend lo necesario para redirigir al pago
    return res.json({
      preference_id: result.id,
      init_point: result.init_point
    });

  } catch (err) {
    // Si falla la creación, liberar el HOLD para que otro pueda intentar
    const rr = leerJSON(pathReservas);
    delete rr[clave];
    escribirJSON(pathReservas, rr);

    // Log más claro (Render logs)
    console.error("MP error crear-preferencia:", {
      message: err?.message,
      body: err?.body || err?.response || err
    });

    // Intentar extraer detalle útil de la respuesta de MP
    const detalle =
      (err?.body && (err.body.message || err.body.error || (Array.isArray(err.body.cause) && err.body.cause[0]?.description))) ||
      err?.message ||
      "Error creando preferencia";

    return res.status(400).json({ error: detalle });
  }
});

/* ============================================================
   LEGADO (backup): tu flujo anterior con retry/refresh
   Lo dejo envuelto en una función async para evitar await top-level.
   NO se llama desde ningún lado; solo queda por si querés volver.
   ============================================================ */
async function _legacyCrearPreferencia({ complejoId, clave, titulo, monto, holdUntil }) {
  // URLs de retorno y webhook
  const FRONT_URL  = process.env.PUBLIC_URL  || `https://ramiroaldeco.github.io/recomplejos-frontend`;
  const BACK_URL   = process.env.BACKEND_URL || `https://recomplejos-backend.onrender.com`;
  const success = `${FRONT_URL}/reservar-exito.html`;
  const pending = `${FRONT_URL}/reservar-pendiente.html`;
  const failure = `${FRONT_URL}/reservar-error.html`;

  // Armado de preferencia (reutilizable en retry)
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

  // Intento 1 con el token actual del complejo
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
    // Si el error es por invalid_token y tenemos refresh_token, refrescamos y reintentamos UNA vez
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
        // si falló MP aún después del refresh, liberamos el HOLD y devolvemos error
        const rr = leerJSON(pathReservas);
        delete rr[clave];
        escribirJSON(pathReservas, rr);

        const info = err2?.message || "Error creando preferencia";
        console.error("MP error tras refresh:", info);
        return { ok:false, error: info };
      }
    } else {
      // Error que no es invalid_token: liberar HOLD y salir
      const rr = leerJSON(pathReservas);
      delete rr[clave];
      escribirJSON(pathReservas, rr);

      const info = err1?.message || "Error creando preferencia";
      console.error("MP error:", info);
      return { ok:false, error: info };
    }
  }

  // Si llegamos acá, hay pref creada
  try {
    // indexamos preference -> clave (para el webhook)
    const idx = leerJSON(pathIdx);
    idx[pref] = { clave, complejoId };
    escribirJSON(pathIdx, idx);

    // Guardamos datos en la reserva
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
    // si algo rompe acá, igualmente la preferencia existe; solo logueamos
    console.error("Post-crear-preferencia error:", err?.message || err);
    return { ok:true, preference_id: pref, init_point: initPoint || null };
  }
}

// Webhook de Mercado Pago
app.post("/webhook-mp", async (req, res) => {
  try {
    // Aceptamos rápido para que MP no reintente de más
    res.sendStatus(200);

    // MP envía { action, data: { id }, type } o similar
    const body = req.body || {};
    const paymentId = body?.data?.id || body?.id;
    if (!paymentId) return;

    // Consultamos el pago para conocer status y preference_id
    // Probaremos con el token global y, si falla, con cada token de credenciales
    const tokensATestar = [];
    const cred = leerJSON(pathCreds);
    if (process.env.MP_ACCESS_TOKEN) tokensATestar.push(process.env.MP_ACCESS_TOKEN);
    for (const k of Object.keys(cred)) {
      if (cred[k]?.oauth?.access_token) tokensATestar.push(cred[k].oauth.access_token); // <-- OAuth primero
      if (cred[k]?.access_token)        tokensATestar.push(cred[k].access_token);
      if (cred[k]?.mp_access_token)     tokensATestar.push(cred[k].mp_access_token);
    }
    tokensATestar.push(""); // por si no hay nada

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

    // Actualizamos la reserva
    const reservas = leerJSON(pathReservas);
    const r = reservas[clave] || {};
    r.preference_id = prefId || r.preference_id;
    r.payment_id = pago?.id || r.payment_id;

    if (status === "approved") {
      r.status = "approved";
      r.paidAt = Date.now();
      // Aseguramos datos útiles para notificación
      r.nombre = r.nombre || "";
      r.telefono = r.telefono || "";
      r.complejoId = r.complejoId || complejoId || "";
      // Notificar (no bloqueante)
      const infoNoti = {
        clave,
        complejoId: r.complejoId,
        nombre: r.nombre,
        telefono: r.telefono,
        monto: r.monto || r.precio || r.senia || ""
      };
      escribirJSON(pathReservas, { ...reservas, [clave]: r });
      notificarAprobado(infoNoti).catch(()=>{});
      // limpiar hold
      delete r.holdUntil;
    } else if (status === "rejected" || status === "cancelled") {
      // liberar el turno
      delete reservas[clave];
      escribirJSON(pathReservas, reservas);
      return;
    } else {
      r.status = "pending"; // in_process / pending
      escribirJSON(pathReservas, { ...reservas, [clave]: r });
      return;
    }

    // guardar final por si faltaba algo
    escribirJSON(pathReservas, { ...reservas, [clave]: r });
  } catch (e) {
    console.error("Error en webhook:", e?.message || e);
  }
});

// ===== OAuth Mercado Pago: callback / conectar / estado =====
// ⚠️ IMPORTANTE: dejá estas rutas ANTES de app.listen(...) y de cualquier middleware 404

// Helpers con nombres únicos para evitar colisiones
// (ya definidos arriba como CREDS_MP_PATH_OAUTH / leerCredsMP_OAUTH / escribirCredsMP_OAUTH)

// Redirige al dueño a autorizar tu app (state = complejoId)
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

// Estado de conexión para pintar UI (conectado / no)
app.get("/mp/estado", (req, res) => {
  const { complejoId } = req.query;
  if (!complejoId) return res.status(400).json({ ok:false, error:"Falta complejoId" });

  const creds = leerCredsMP_OAUTH();
  const conectado = Boolean(creds[complejoId]?.oauth?.access_token);
  res.json({ ok:true, conectado });
});

// Callback al que vuelve Mercado Pago con ?code=...&state=complejoId
app.get("/mp/callback", async (req, res) => {
  const { code, state: complejoId } = req.query;
  if (!code || !complejoId) {
    return res.status(400).send("❌ Faltan parámetros en el callback");
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
    if (!r.ok || !data.access_token) {
      console.error("OAuth error:", data);
      return res.status(400).send("❌ No se pudo conectar Mercado Pago.");
    }

    const creds = leerCredsMP_OAUTH();
    creds[complejoId] = creds[complejoId] || {};
    creds[complejoId].oauth = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      user_id: data.user_id,
      updated_at: Date.now()
    };
    escribirCredsMP_OAUTH(creds);

  // ... dentro de /mp/callback
  // después de escribirCredsMP_OAUTH(creds);

  const slug = encodeURIComponent(complejoId);
  const base = process.env.PUBLIC_URL; // ej: https://ramiroaldeco.github.io/recomplejos-frontend
  const urlOnboarding = `${base}/onboarding.html?complejo=${slug}&mp=ok`;
  const urlFrontend   = `${base}/frontend.html?complejo=${slug}`;

  res.status(200).send(`<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<title>Mercado Pago conectado</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:system-ui,Segoe UI,Arial,sans-serif;padding:28px;background:#f7fff9}
  .card{max-width:620px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;
        box-shadow:0 4px 16px rgba(0,0,0,.08);text-align:center}
  h1{color:#0a7f46;margin:0 0 8px}
  p{color:#333}
  .row{display:flex;gap:12px;justify-content:center;margin-top:18px;flex-wrap:wrap}
  a.button{display:inline-block;padding:10px 14px;border-radius:8px;text-decoration:none}
  a.primary{background:#0b8457;color:#fff}
  a.secondary{background:#eef7f2;color:#0b8457;border:1px solid #0b8457}
  small{color:#666;display:block;margin-top:14px}
</style>
</head><body>
  <div class="card">
    <h1>✅ Mercado Pago conectado</h1>
    <p>Listo. Ya podés cobrar las señas para <strong>${complejoId}</strong>.</p>
    <div class="row">
      <a class="button primary"   href="${urlOnboarding}">Volver al Onboarding</a>
      <a class="button secondary" href="${urlFrontend}">Ir a Reservar</a>
    </div>
    <small>No olvides guardar los datos del complejo en el Onboarding.</small>
  </div>
</body></html>`);
  } catch (e) {
    console.error(e);
    res.status(500).send("❌ Error interno al conectar Mercado Pago.");
  }
});
// ---- DEBUG: credenciales guardadas por complejo (NO expone tokens completos)
app.get("/debug/credenciales", (_req, res) => {
  try {
    const cred = leerJSON(pathCreds); // usa tu helper y pathCreds que ya tenés
    const resumen = {};
    for (const k of Object.keys(cred)) {
      const c = cred[k] || {};
      resumen[k] = {
        tieneOAuth: !!(c.oauth && c.oauth.access_token),
        tieneManual: !!(c.access_token || c.mp_access_token),
        ultimoUpdate: c.oauth?.updated_at || null
      };
    }
    res.json({ ok: true, credenciales: resumen });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ---- DEBUG: qué token usaría para un complejo (solo preview)
app.get("/debug/token", (req, res) => {
  const { complejoId } = req.query || {};
  if (!complejoId) return res.status(400).json({ error: "falta complejoId" });

  const cred = leerJSON(pathCreds);
  const c = cred[complejoId] || {};
  const tok =
    (c.oauth && c.oauth.access_token) ||
    c.access_token ||
    c.mp_access_token ||
    process.env.MP_ACCESS_TOKEN ||
    "";

  return res.json({
    complejoId,
    tieneOAuth: !!(c.oauth && c.oauth.access_token),
    tieneManual: !!(c.access_token || c.mp_access_token),
    usaEnv: !((c.oauth && c.oauth.access_token) || c.access_token || c.mp_access_token) && !!process.env.MP_ACCESS_TOKEN,
    token_preview: tok ? (tok.slice(0, 8) + "..." + tok.slice(-4)) : "(vacío)"
  });
});

// =======================
// END
// =======================
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});

















