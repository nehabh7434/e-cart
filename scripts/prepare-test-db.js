require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

function getConnectionOptions(database) {
  return {
    user: process.env.TEST_DB_USER || process.env.DB_USER,
    host: process.env.TEST_DB_HOST || process.env.DB_HOST,
    password: process.env.TEST_DB_PASSWORD || process.env.DB_PASSWORD,
    port: Number(process.env.TEST_DB_PORT || process.env.DB_PORT),
    database,
  };
}

async function main() {
  const databaseName = process.env.TEST_DB_NAME || 'ecart_test';
  if (!/^ecart_test(?:_[a-z0-9]+)*$/.test(databaseName)) {
    throw new Error('TEST_DB_NAME must start with "ecart_test" and contain only lowercase letters, numbers, and underscores');
  }
  if (databaseName === process.env.DB_NAME) {
    throw new Error('Refusing to use DB_NAME as the test database');
  }

  const admin = new Pool(getConnectionOptions(process.env.TEST_DB_ADMIN_DATABASE || 'postgres'));
  try {
    const existing = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [databaseName]
    );
    if (existing.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      console.log(`Created isolated PostgreSQL test database "${databaseName}"`);
    } else {
      console.log(`Using isolated PostgreSQL test database "${databaseName}"`);
    }
  } finally {
    await admin.end();
  }

  const testDatabase = new Pool(getConnectionOptions(databaseName));
  try {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'test', 'schema.sql'), 'utf8');
    await testDatabase.query(schema);
  } finally {
    await testDatabase.end();
  }

  process.env.DB_USER = process.env.TEST_DB_USER || process.env.DB_USER;
  process.env.DB_HOST = process.env.TEST_DB_HOST || process.env.DB_HOST;
  process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || process.env.DB_PASSWORD;
  process.env.DB_PORT = process.env.TEST_DB_PORT || process.env.DB_PORT;
  process.env.DB_NAME = databaseName;
  process.env.SESSION_SECRET = 'jest-supertest-session-secret';
  process.env.NODE_ENV = 'test';

  const { runCLI } = require('jest');
  const { results } = await runCLI(
    { runInBand: true, coverage: true },
    [process.cwd()]
  );
  if (!results.success) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Test database setup failed:', error.message);
  process.exitCode = 1;
});
