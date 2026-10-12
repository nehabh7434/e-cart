require('dotenv').config();
const { pool } = require('../db');

const demoProducts = [
  [1, 'Smartphone', '699.99', 50],
  [2, 'Laptop', '999.99', 30],
  [3, 'Refrigerator', '499.99', 20],
  [4, 'Microwave', '199.99', 25],
  [5, 'T-Shirt', '19.99', 100],
];

async function seedProducts(databasePool = pool) {
  const values = [];
  const placeholders = demoProducts.map((product, index) => {
    const offset = index * 4;
    values.push(...product);
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`;
  });

  const result = await databasePool.query(
    `INSERT INTO products (product_id, name, price, stock_quantity)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (product_id) DO NOTHING`,
    values
  );

  return result.rowCount;
}

async function main() {
  try {
    const insertedCount = await seedProducts();
    console.log(`Inserted ${insertedCount} demo products; existing product IDs were left unchanged.`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Product seeding failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { seedProducts };
