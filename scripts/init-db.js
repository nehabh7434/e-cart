require('dotenv').config();
const { initializeDatabase, pool } = require('../db');

async function main() {
  try {
    await initializeDatabase(pool);
    console.log('Database schema and session table are ready.');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Database initialization failed:', error.message);
  process.exitCode = 1;
});
