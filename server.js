// ---- Cargas básicas
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const fetch = require("node-fetch"); // para consultar el pago en el webhook
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
function tokenPara(complejoId) {
  const cred = leerJSON(pathCreds);
  // 1) Token por complejo (onboarding)
  if (cred[complejoId]?.access_token) return cred[complejoId].access_token;
  // 2) Token global .env
  if (process.env.MP_ACCESS_TOKEN) return process.env.MP_ACCESS_TOKEN;
  // 3) Si no hay, devolvemos cadena vacía (fallará con "invalid_token" como hasta ahora)
  return "";
}
function mpClient(complejoId) {
  return new MercadoPagoConfig({ access_token: tokenPara(complejoId) });
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

// Datos del complejo
app.get("/datos_complejos", (_req, res) => {
  res.json(leerJSON(pathDatos));
});

app.post("/guardarDatos", (req, res) => {
  // Guarda el JSON completo (usa onboarding y panel)
  escribirJSON(pathDatos, req.body);
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
// PAGOS: crear preferencia + Webhook
// =======================

// Crea la preferencia y deja un HOLD sobre el turno
app.post("/crear-preferencia", async (req, res) => {
  const {
    complejoId,     // slug del complejo
    clave,          // clave única del turno: `${slug}-${cancha}-${Dia}-{HH:MM}`
    titulo,         // título del item
    precio,         // monto de la seña (número)
    nombre,         // nombre del cliente
    telefono        // teléfono del cliente
  } = req.body || {};

  if (!complejoId || !clave || !precio) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  const reservas = leerJSON(pathReservas);

  // ¿ya reservado?
  const existente = reservas[clave];
  if (existente && (existente.status === "approved" || estaHoldActiva(existente))) {
    return res.status(409).json({ error: "El turno ya está tomado" });
  }

  // Crear HOLD temporal para bloquear el turno
  const holdUntil = Date.now() + HOLD_MIN * 60 * 1000;
  reservas[clave] = {
    status: "hold",
    holdUntil,
    nombre: nombre || "",
    telefono: telefono || "",
    complejoId,
    monto: precio
  };
  escribirJSON(pathReservas, reservas);

  // Preferencia MP
  const token = tokenPara(complejoId);
  const mp = new MercadoPagoConfig({ access_token: token });
  const preference = new Preference(mp);

  // back_urls (dejamos las tuyas)
  const success = `http://localhost:${PORT}/reservar-exito.html`;
  const pending = `http://localhost:${PORT}/reservar-pendiente.html`;
  const failure = `http://localhost:${PORT}/reservar-error.html`;

  try {
    const prefBody = {
      items: [
        { title: titulo || "Seña de reserva", unit_price: Number(precio), quantity: 1 }
      ],
      back_urls: { success, pending, failure },
      auto_return: "approved",
      notification_url: `${process.env.PUBLIC_URL || `http://localhost:${PORT}`}/webhook-mp`,
      metadata: {
        clave,
        complejoId
      }
    };

    const result = await preference.create({ body: prefBody });
    const pref = result?.id || result?.body?.id || result?.response?.id;

    // indexamos preference -> clave (para el webhook)
    const idx = leerJSON(pathIdx);
    idx[pref] = { clave, complejoId };
    escribirJSON(pathIdx, idx);

    // Guardamos datos en la reserva
    const r2 = leerJSON(pathReservas);
    if (r2[clave]) {
      r2[clave].status = "pending";
      r2[clave].preference_id = pref;
      r2[clave].init_point = result?.init_point || result?.body?.init_point || result?.response?.init_point || "";
      r2[clave].holdUntil = holdUntil;
      escribirJSON(pathReservas, r2);
    }

    return res.json({
      ok: true,
      preference_id: pref,
      init_point: r2[clave]?.init_point || null
    });
  } catch (err) {
    // si falló MP, liberamos el HOLD
    const rr = leerJSON(pathReservas);
    delete rr[clave];
    escribirJSON(pathReservas, rr);

    const info = err?.message || "Error creando preferencia";
    console.error("MP error:", info);
    return res.status(400).json({ error: info });
  }
});

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
      if (cred[k]?.access_token) tokensATestar.push(cred[k].access_token);
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
    if (!clave && prefId) {
      const idx = leerJSON(pathIdx);
      clave = idx[prefId]?.clave;
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
      delete r.holdUntil;
    } else if (status === "rejected" || status === "cancelled") {
      // liberar el turno
      delete reservas[clave];
      escribirJSON(pathReservas, reservas);
      return;
    } else {
      r.status = "pending"; // in_process / pending
    }

    reservas[clave] = r;
    escribirJSON(pathReservas, reservas);
  } catch (e) {
    console.error("Error en webhook:", e?.message || e);
  }
});

// =======================
// END
// =======================
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});






