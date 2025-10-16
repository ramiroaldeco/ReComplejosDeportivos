// dao.js — versión alineada con server.js y front (claves/slug unificado)
const pool = require('./db');
const bcrypt = require('bcrypt'); // por si luego migrás login a hash

/* ===================== Helpers ===================== */

function slugCancha(nombre = "") {
  return String(nombre)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9]/g, "");
}
function hhmm(x) {
  // pg suele devolver 'HH:MM:SS' como string
  return String(x || "").slice(0, 5);
}
function ymd(d) {
  // fecha PG → 'YYYY-MM-DD'
  try {
    return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
  } catch {
    return String(d || "").slice(0, 10);
  }
}

/* ===================== COMPLEJOS ===================== */

// Devuelve objeto { [id]: {nombre, ciudad, maps, servicios, imagenes, horarios, canchas} }
async function listarComplejos() {
  // complejos
  const { rows: cx } = await pool.query(
    `select id, name, city, maps_iframe, servicios, imagenes, clave_legacy
       from complexes
       order by name`
  );

  // canchas + horarios
  const { rows: fields } = await pool.query(
    `select id, complex_id, name, jugadores, precio_pp, senia
       from fields
       order by id`
  );
  const { rows: sched } = await pool.query(
    `select complex_id, day_of_week, desde, hasta
       from schedules
       order by complex_id, day_of_week`
  );

  // salida compatible con tu front
  const out = {};
  for (const c of cx) {
    out[c.id] = {
      clave: c.clave_legacy || "",
      nombre: c.name,
      ciudad: c.city,
      maps: c.maps_iframe,
      servicios: Array.isArray(c.servicios) ? c.servicios : (c.servicios ? c.servicios : []),
      imagenes: Array.isArray(c.imagenes)  ? c.imagenes  : (c.imagenes  ? c.imagenes  : []),
      canchas: [],
      horarios: {}
    };
  }

  // map día 0..6 -> nombre (0=Domingo en la DB)
  const dowNames = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];

  for (const s of sched) {
    const dia = dowNames[s.day_of_week] || "Lunes";
    if (out[s.complex_id]) {
      out[s.complex_id].horarios[dia] = {
        desde: hhmm(s.desde) || "18:00",
        hasta: hhmm(s.hasta) || "23:00"
      };
    }
  }

  for (const f of fields) {
    if (!out[f.complex_id]) continue;
    const jugadores = Number(f.jugadores || 0);
    const precioPP  = Number(f.precio_pp  || 0);
    const senia     = Number(f.senia      || 0);
    out[f.complex_id].canchas.push({
      nombre: f.name,
      jugadores,
      // tres variantes para compatibilidad
      precioPP,                                      // por jugador
      precioPorJugador: precioPP,                    // alias que usa a veces tu front
      precioTotal: (precioPP * jugadores) || 0,      // total calculado
      senia
    });
  }

  return out;
}

// Upsert masivo del objeto “merged” que manda onboarding.html
// merged = { [id]: { nombre, ciudad, maps, servicios, imagenes, horarios, canchas, clave } }
async function guardarDatosComplejos(merged) {
  const client = await pool.connect();
  try {
    await client.query('begin');

    for (const id of Object.keys(merged || {})) {
      const d = merged[id] || {};

      // complexes
      await client.query(`
        insert into complexes (id, name, city, maps_iframe, servicios, imagenes, clave_legacy)
        values ($1,$2,$3,$4,$5,$6,$7)
        on conflict (id) do update set
          name=excluded.name,
          city=excluded.city,
          maps_iframe=excluded.maps_iframe,
          servicios=excluded.servicios,
          imagenes=excluded.imagenes,
          clave_legacy=excluded.clave_legacy
      `, [
        id,
        d.nombre || id,
        d.ciudad || null,
        d.maps || d.maps_iframe || null,
        JSON.stringify(d.servicios || []),
        JSON.stringify(d.imagenes || []),
        d.clave || null
      ]);

      // schedules (replace)
      if (d.horarios && typeof d.horarios === 'object') {
        await client.query(`delete from schedules where complex_id=$1`, [id]);
        const orden = ["Lunes","Martes","Miércoles","Jueves","Viernes","Sábado","Domingo"];
        const map = { "Domingo":0,"Lunes":1,"Martes":2,"Miércoles":3,"Jueves":4,"Viernes":5,"Sábado":6 };
        for (const nd of orden) {
          const h = d.horarios[nd] || {};
          const desde = h.desde || '18:00';
          const hasta = h.hasta || '23:00';
          await client.query(
            `insert into schedules (complex_id, day_of_week, desde, hasta)
             values ($1,$2,$3,$4)`,
            [id, map[nd], desde, hasta]
          );
        }
      }

      // fields (replace)
      if (Array.isArray(d.canchas)) {
        await client.query(`delete from fields where complex_id=$1`, [id]);
        for (const c of d.canchas) {
          const jug = Number(c.jugadores ?? 0);

          // origen posible: precioPP | precioPorJugador | precioTotal
          const precioPP =
            c.precioPP != null ? Number(c.precioPP) :
            c.precioPorJugador != null ? Number(c.precioPorJugador) :
            (c.precioTotal != null && jug) ? Number(c.precioTotal) / jug : 0;

          const senia = Number(c.senia ?? 0);

          await client.query(
            `insert into fields (complex_id, name, jugadores, precio_pp, senia)
             values ($1,$2,$3,$4,$5)`,
            [id, c.nombre || 'Cancha', jug, precioPP, senia]
          );
        }
      }
    }

    await client.query('commit');
    return { ok: true };
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

/* ===================== LOGIN DUEÑO (compat) ===================== */
async function loginDueno(complejoId, password) {
  const id = String(complejoId || "").trim();
  const pass = String(password || "").trim();

  const { rows } = await pool.query(
    `select coalesce(clave_legacy,'') as clave_legacy from complexes where id=$1`,
    [id]
  );
  if (!rows.length) return { ok: false };

  const guardada = String(rows[0].clave_legacy || "").trim();
  return { ok: guardada !== "" && guardada === pass };
}

/* ===================== RESERVAS (compat objeto) ===================== */

// reservations → objeto clave legacy (usamos SLUG de cancha para que coincida con el front)
async function listarReservasObjCompat() {
  const q = `
    select r.*, f.name as cancha
      from reservations r
      join fields f on f.id = r.field_id
  `;
  const { rows } = await pool.query(q);
  const out = {};
  for (const r of rows) {
    const fechaISO = ymd(r.fecha);
    const hh = hhmm(r.hora);
    const key = `${r.complex_id}-${slugCancha(r.cancha)}-${fechaISO}-${hh}`;
    const item = {
      status: r.status,
      nombre: r.nombre || "",
      telefono: r.telefono || "",
      monto: r.monto || undefined,
      preference_id: r.preference_id || undefined,
      payment_id: r.payment_id || undefined
    };
    if (r.status === 'blocked') item.bloqueado = true;
    if (r.hold_until) {
      const t = (r.hold_until instanceof Date) ? r.hold_until.getTime() : Number(new Date(r.hold_until).getTime());
      if (!Number.isNaN(t)) item.holdUntil = t;
    }
    out[key] = item;
  }
  return out;
}

// Guarda el objeto completo (primera versión: borra y recrea)
async function guardarReservasObjCompat(obj) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('delete from reservations');

    // query flexible para encontrar cancha
    const fieldQ = `
      select id from fields
      where complex_id=$1 and (
        name=$2
        or lower(regexp_replace(name,'\\s+','','g')) = lower(regexp_replace($2,'\\s+','','g'))
        or ($2 ~ '^[0-9]+$' and jugadores = ($2)::int)
      )
      limit 1
    `;

    for (const key of Object.keys(obj || {})) {
      // key: complexId-slugCancha-YYYY-MM-DD-HH:mm  (o variantes compatibles)
      const parts = key.split('-');
      if (parts.length < 4) continue;
      const complex_id = parts[0];
      const canchaKey = parts[1];

      const tail = parts.slice(2).join('-');
      const m = tail.match(/(\d{4}-\d{2}-\d{2})-(\d{2}:\d{2})$/);
      if (!m) continue;
      const fechaISO = m[1];
      const hora = m[2];

      const r = obj[key];

      // buscar por nombre original o por "slug"
      // (si la key es slug, este where ya contempla la comparación sin espacios)
      const f = await client.query(fieldQ, [complex_id, canchaKey]);
      if (!f.rowCount) continue;
      const field_id = f.rows[0].id;

      let status = r.status || (r.bloqueado ? 'blocked' : 'manual');

      await client.query(`
        insert into reservations (complex_id, field_id, fecha, hora, status, nombre, telefono, monto, preference_id, payment_id, hold_until)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, ${r.holdUntil ? 'to_timestamp($11/1000)' : 'null'})
      `, [
        complex_id, field_id, fechaISO, hora, status,
        r.nombre || null, r.telefono || null, r.monto || null,
        r.preference_id || null, r.payment_id || null,
        r.holdUntil || null
      ]);
    }

    await client.query('commit');
    return { ok:true };
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

/* ===================== UTIL: HOLD / PAGO ===================== */

async function crearHold({ complex_id, cancha, fechaISO, hora, nombre, telefono, monto, holdMinutes=10 }) {
  // búsqueda flexible por cancha
  const fieldQ = `
    select id from fields
    where complex_id=$1 and (
      name=$2
      or lower(regexp_replace(name,'\\s+','','g')) = lower(regexp_replace($2,'\\s+','','g'))
      or ($2 ~ '^[0-9]+$' and jugadores = ($2)::int)
    )
    limit 1
  `;
  const { rows } = await pool.query(fieldQ, [complex_id, cancha]);
  if (!rows.length) return false;
  const field_id = rows[0].id;

  const ins = await pool.query(`
    insert into reservations (complex_id, field_id, fecha, hora, status, nombre, telefono, monto, hold_until)
    values ($1,$2,$3,$4,'hold',$5,$6,$7, now() + ($8 || ' minutes')::interval)
    on conflict (complex_id,field_id,fecha,hora)
      where status in ('hold','pending','approved','manual','blocked')
      do nothing
    returning id
  `, [complex_id, field_id, fechaISO, hora, nombre || null, telefono || null, monto || null, holdMinutes]);

  return ins.rowCount > 0;
}

async function actualizarReservaTrasPago({ preference_id, payment_id, status, nombre, telefono }) {
  const { rowCount } = await pool.query(`
    update reservations
       set status = case
                      when $1='approved' then 'approved'
                      when $1 in ('rejected','cancelled') then 'cancelled'
                      else 'pending'
                    end,
           payment_id = $2,
           preference_id = coalesce(preference_id,$3),
           nombre = coalesce(nombre,$4),
           telefono = coalesce(telefono,$5),
           hold_until = null
     where preference_id = $3
  `, [status, payment_id, preference_id, nombre || null, telefono || null]);
  return rowCount > 0;
}

/* ===================== MP OAuth en DB ===================== */

async function upsertMpOAuth({ complex_id, access_token, refresh_token, scope, token_type, live_mode, expires_in }) {
  await pool.query(`
    create table if not exists mp_oauth (
      complex_id  text primary key,
      access_token text,
      refresh_token text,
      scope text,
      token_type text,
      live_mode boolean,
      expires_in integer,
      updated_at timestamptz default now()
    )
  `);
  await pool.query(`
    insert into mp_oauth (complex_id, access_token, refresh_token, scope, token_type, live_mode, expires_in, updated_at)
    values ($1,$2,$3,$4,$5,$6,$7, now())
    on conflict (complex_id) do update set
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      scope = excluded.scope,
      token_type = excluded.token_type,
      live_mode = excluded.live_mode,
      expires_in = excluded.expires_in,
      updated_at = now()
  `, [complex_id, access_token, refresh_token, scope || null, token_type || null, !!live_mode, expires_in || null]);
  return { ok: true };
}

async function getMpOAuth(complex_id) {
  const { rows } = await pool.query(
    `select access_token, refresh_token from mp_oauth where complex_id = $1`,
    [complex_id]
  );
  return rows[0] || null;
}

/* ===================== DUEÑO / CONTACTO ===================== */

// Lee contacto + switches de un complejo
async function leerContactoComplejo(complexId) {
  const { rows } = await pool.query(
    `SELECT owner_phone, owner_email, notif_whats, notif_email
     FROM complexes WHERE id = $1`,
    [complexId]
  );
  return rows[0] || null;
}

// Guarda contacto (tel + email) y, si vienen, switches
async function guardarContactoComplejo(complexId, { owner_phone, owner_email, notif_whats, notif_email }) {
  const { rows } = await pool.query(
    `UPDATE complexes
       SET owner_phone = COALESCE($2, owner_phone),
           owner_email = COALESCE($3, owner_email),
           notif_whats = COALESCE($4, notif_whats),
           notif_email = COALESCE($5, notif_email)
     WHERE id = $1
     RETURNING id, owner_phone, owner_email, notif_whats, notif_email`,
    [complexId, owner_phone ?? null, owner_email ?? null, notif_whats ?? null, notif_email ?? null]
  );
  return rows[0];
}

// Cambia SOLO switches de notificación
async function guardarNotificaciones(complexId, { notif_whats, notif_email }) {
  const { rows } = await pool.query(
    `UPDATE complexes
       SET notif_whats = COALESCE($2, notif_whats),
           notif_email = COALESCE($3, notif_email)
     WHERE id = $1
     RETURNING id, notif_whats, notif_email`,
    [complexId, notif_whats ?? null, notif_email ?? null]
  );
  return rows[0];
}

/* ===================== MERCADO PAGO (credenciales por complejo) ===================== */

// Guarda credenciales MP por complejo (post OAuth o manual)
async function guardarCredencialesMP(complexId, creds) {
  const {
    mp_user_id,
    mp_public_key,
    mp_access_token,
    mp_refresh_token,
    mp_token_expiry // ISO string opcional
  } = creds;

  const { rows } = await pool.query(
    `UPDATE complexes
       SET mp_user_id       = COALESCE($2, mp_user_id),
           mp_public_key    = COALESCE($3, mp_public_key),
           mp_access_token  = COALESCE($4, mp_access_token),
           mp_refresh_token = COALESCE($5, mp_refresh_token),
           mp_token_expiry  = COALESCE($6, mp_token_expiry)
     WHERE id = $1
     RETURNING id, mp_user_id, mp_public_key, mp_access_token IS NOT NULL AS has_token, mp_token_expiry`,
    [complexId, mp_user_id ?? null, mp_public_key ?? null, mp_access_token ?? null, mp_refresh_token ?? null, mp_token_expiry ?? null]
  );
  return rows[0];
}

// Lee credenciales MP por complejo (para crear preferencias, etc.)
async function leerCredencialesMP(complexId) {
  const { rows } = await pool.query(
    `SELECT mp_user_id, mp_public_key, mp_access_token, mp_refresh_token, mp_token_expiry
     FROM complexes WHERE id = $1`,
    [complexId]
  );
  return rows[0] || null;
}

/* ===================== EXPORTS ÚNICOS ===================== */

module.exports = {
  // === Complejos y datos base ===
  listarComplejos,
  guardarDatosComplejos,
  loginDueno,

  // === Reservas ===
  listarReservasObjCompat,
  guardarReservasObjCompat,
  crearHold,
  actualizarReservaTrasPago,

  // === MP OAuth ===
  upsertMpOAuth,
  getMpOAuth,

  // === Contacto y notificaciones ===
  leerContactoComplejo,
  guardarContactoComplejo,
  guardarNotificaciones,
  guardarCredencialesMP,
  leerCredencialesMP
};
