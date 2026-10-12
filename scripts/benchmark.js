require('dotenv').config();
const { Pool } = require('pg');

const runs = Number(process.env.BENCHMARK_RUNS || 3);
const userId = Number(process.env.BENCHMARK_USER_ID || 1);
const productId = Number(process.env.BENCHMARK_PRODUCT_ID || 1);
const email = process.env.BENCHMARK_EMAIL || 'benchmark@example.com';

if (!Number.isInteger(runs) || runs < 1) {
  throw new Error('BENCHMARK_RUNS must be a positive integer');
}
if (!Number.isInteger(userId) || userId < 1) {
  throw new Error('BENCHMARK_USER_ID must be a positive integer');
}
if (!Number.isInteger(productId) || productId < 1) {
  throw new Error('BENCHMARK_PRODUCT_ID must be a positive integer');
}

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT),
});

const benchmarks = [
  {
    name: 'Catalog listing',
    sql: 'SELECT * FROM products ORDER BY product_id',
    values: [],
  },
  {
    name: 'Login lookup',
    sql: 'SELECT * FROM users WHERE email = $1',
    values: [email],
  },
  {
    name: 'Product and stock lookup',
    sql: 'SELECT * FROM products WHERE product_id = $1',
    values: [productId],
  },
  {
    name: 'Cart listing',
    sql: `
      SELECT c.item_id AS product_id, p.name, p.price, c.quantity
      FROM cart c
      JOIN products p ON c.item_id = p.product_id
      WHERE c.user_id = $1
    `,
    values: [userId],
  },
];

async function main() {
  try {
    for (let run = 1; run <= runs; run += 1) {
      console.log(`\n=== Benchmark run ${run} of ${runs} ===`);
      for (const benchmark of benchmarks) {
        const result = await pool.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${benchmark.sql}`,
          benchmark.values
        );
        console.log(`\n--- ${benchmark.name} ---`);
        console.log(result.rows.map((row) => row['QUERY PLAN']).join('\n'));
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exitCode = 1;
});
