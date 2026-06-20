const { Pool } = require('pg');

/**
 * Railway (and most PaaS platforms) expose the database as a single
 * DATABASE_URL connection string, e.g.:
 *   postgresql://postgres:password@postgres.railway.internal:5432/railway
 *
 * When DATABASE_URL is present we use it directly.
 * When it is absent we fall back to individual DB_HOST / DB_PORT / etc. vars.
 *
 * connectionTimeoutMillis is raised to 10 s because Railway's internal
 * network can be slow on cold starts.
 */

const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      // Required for Railway / Supabase / Neon SSL connections.
      // Set DB_SSL=false in .env only if your host does not use SSL.
      ssl: process.env.DB_SSL === 'false'
        ? false
        : { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    }
  : {
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT, 10) || 5432,
      database: process.env.DB_NAME     || 'khatabill',
      user:     process.env.DB_USER     || 'postgres',
      password: process.env.DB_PASSWORD || '',
      ssl: process.env.DB_SSL === 'true'
        ? { rejectUnauthorized: false }
        : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    };

const pool = new Pool(poolConfig);

pool.on('connect', () => {
  const target = process.env.DATABASE_URL
    ? process.env.DATABASE_URL.replace(/:\/\/[^@]+@/, '://***@') // hide credentials in logs
    : `${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}`;
  console.log(`[DB] Connected to PostgreSQL at ${target}`);
});

pool.on('error', (err) => {
  console.error('[DB] PostgreSQL pool error:', err.message);
});

const query = (text, params) => pool.query(text, params);
const getClient = () => pool.connect();

module.exports = { query, getClient, pool };
