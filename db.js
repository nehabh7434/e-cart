const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

const schemaFiles = ['DDL.sql', 'indexes.sql', 'session.sql'];

function getPoolConfig(env = process.env) {
  const common = {
    max: 10,
    connectionTimeoutMillis: 10000,
  };

  if (env.DATABASE_URL?.trim()) {
    let connectionUrl;
    try {
      connectionUrl = new URL(env.DATABASE_URL.trim());
    } catch {
      throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL');
    }

    if (!['postgres:', 'postgresql:'].includes(connectionUrl.protocol) ||
        !connectionUrl.hostname ||
        !connectionUrl.username ||
        !connectionUrl.password ||
        connectionUrl.pathname.length < 2) {
      throw new Error('DATABASE_URL must include a PostgreSQL host, database, user, and password');
    }

    const sslMode = connectionUrl.searchParams.get('sslmode');
    if (sslMode && !['require', 'verify-ca', 'verify-full'].includes(sslMode)) {
      throw new Error('DATABASE_URL must not disable or weaken TLS certificate verification');
    }

    const sslOption = connectionUrl.searchParams.get('ssl');
    if (sslOption && !['true', '1'].includes(sslOption)) {
      throw new Error('DATABASE_URL must not disable or weaken TLS certificate verification');
    }

    for (const parameter of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert']) {
      connectionUrl.searchParams.delete(parameter);
    }

    return {
      ...common,
      connectionString: connectionUrl.toString(),
      ssl: { rejectUnauthorized: true },
    };
  }

  return {
    ...common,
    user: env.DB_USER,
    host: env.DB_HOST,
    database: env.DB_NAME,
    password: env.DB_PASSWORD,
    port: Number(env.DB_PORT) || 5432,
  };
}

function validateEnvironment(env = process.env) {
  const hasDatabaseUrl = Boolean(env.DATABASE_URL?.trim());

  if (!env.SESSION_SECRET?.trim()) {
    throw new Error('SESSION_SECRET must be set');
  }

  if (!hasDatabaseUrl &&
      ['DB_USER', 'DB_HOST', 'DB_NAME', 'DB_PASSWORD'].some((name) => !env[name])) {
    throw new Error('Set DATABASE_URL or all DB_USER, DB_HOST, DB_NAME, and DB_PASSWORD variables');
  }

  if (env.COOKIE_SECURE && !['true', 'false'].includes(env.COOKIE_SECURE)) {
    throw new Error('COOKIE_SECURE must be either true or false');
  }

  if (env.NODE_ENV === 'production') {
    if (!hasDatabaseUrl) {
      throw new Error('DATABASE_URL must be set in production');
    }
    if (Buffer.byteLength(env.SESSION_SECRET) < 32) {
      throw new Error('SESSION_SECRET must contain at least 32 bytes in production');
    }
    if (env.COOKIE_SECURE !== 'true') {
      throw new Error('COOKIE_SECURE=true is required in production');
    }
  }

  getPoolConfig(env);
}

const pool = new Pool(getPoolConfig());

async function initializeDatabase(databasePool = pool) {
  const client = await databasePool.connect();
  let transactionStarted = false;

  try {
    await client.query('BEGIN');
    transactionStarted = true;

    for (const file of schemaFiles) {
      const sql = await fs.readFile(path.join(__dirname, file), 'utf8');
      await client.query(sql);
    }

    await client.query('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Database initialization rollback failed:', rollbackError.message);
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { getPoolConfig, initializeDatabase, pool, validateEnvironment };
