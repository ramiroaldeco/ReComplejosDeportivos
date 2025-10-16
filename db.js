const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // tu variable en Render
  ssl: { rejectUnauthorized: false }          // 🔑 necesario para Neon
});

module.exports = pool;


