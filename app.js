require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const app = express();
const port = 3000;

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT),
});

app.use(bodyParser.urlencoded({ extended: true }));
app.set('view engine', 'ejs');

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
  },
}));

function isLoggedIn(req, res, next) {
  if (req.session.userId) return res.redirect('/dashboard');
  next();
}

function isAuthenticated(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

function isValidEmail(email) {
  return typeof email === 'string' && email.trim() !== '' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 6;
}

function parsePositiveInteger(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) return null;
  return num;
}

app.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM Products');
    res.render('home-page', { products: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).send('Server error');
  }
});

app.get('/signup', (req, res) => {
  res.render('signup');
});

app.post('/signup', isLoggedIn, async (req, res) => {
  const { username, email, password } = req.body;

  if (!username?.trim() || !email?.trim() || !password) {
    return res.status(400).send('Username, email, and password are required');
  }
  if (!isValidEmail(email)) {
    return res.status(400).send('A valid email address is required');
  }
  if (!isValidPassword(password)) {
    return res.status(400).send('Password must be at least 6 characters');
  }
  if (username.trim().length > 100) {
    return res.status(400).send('Username must be 100 characters or fewer');
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING user_id',
      [username.trim(), normalizedEmail, hashedPassword]
    );
    return req.session.regenerate((sessionError) => {
      if (sessionError) {
        console.error('Error regenerating signup session:', sessionError);
        return res.status(500).send('Signup failed');
      }
      req.session.userId = result.rows[0].user_id;
      res.redirect('/dashboard');
    });
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(409).send('An account with this email already exists');
    }
    res.status(500).send('Signup failed');
  }
});

app.get('/login', isLoggedIn, (req, res) => {
  res.render('home-page');
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email?.trim() || !password) {
    return res.status(400).send('Email and password are required');
  }

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email.trim().toLowerCase()]
    );
    const user = result.rows[0];

    if (user && await bcrypt.compare(password, user.password_hash)) {
      return req.session.regenerate((err) => {
        if (err) {
          console.error('Error regenerating login session:', err);
          return res.status(500).send('Login failed');
        }
        req.session.userId = user.user_id;
        res.redirect('/dashboard');
      });
    } else {
      res.status(401).send('Invalid email or password');
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Login failed');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Logout failed');
    }
    res.redirect('/login');
  });
});

app.get('/dashboard', isAuthenticated, async (req, res) => {
  res.render('dashboard');
});

app.get('/list-products', isAuthenticated, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY product_id');
    res.render('products', { products: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading products');
  }
});

app.get('/add-to-cart', isAuthenticated, (req, res) => {
  res.render('add-to-cart');
});

app.post('/add-to-cart', isAuthenticated, async (req, res) => {
  const product_id = parsePositiveInteger(req.body.product_id);
  const quantity = parsePositiveInteger(req.body.quantity);
  const userId = req.session.userId;

  if (product_id === null) {
    return res.status(400).send('Product ID must be a valid positive integer');
  }
  if (quantity === null) {
    return res.status(400).send('Quantity must be a valid positive integer');
  }

  try {
    const productCheck = await pool.query('SELECT * FROM products WHERE product_id = $1', [product_id]);
    if (productCheck.rowCount === 0) return res.status(404).send('Product not found');

    if (quantity > productCheck.rows[0].stock_quantity) {
      return res.status(409).send('Insufficient stock');
    }

    const cartUpdate = await pool.query(`
      INSERT INTO cart(user_id, item_id, quantity)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, item_id)
      DO UPDATE SET quantity = cart.quantity + EXCLUDED.quantity
      WHERE cart.quantity + EXCLUDED.quantity <= $4
      RETURNING quantity
    `, [userId, product_id, quantity, productCheck.rows[0].stock_quantity]);

    if (cartUpdate.rowCount === 0) {
      return res.status(409).send('Insufficient stock');
    }

    res.redirect('/display-cart');
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to add product to cart');
  }
});

app.get('/remove-from-cart', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.userId;
    const cartItems = await pool.query(`
      SELECT c.item_id AS product_id, p.name
      FROM cart c
      JOIN products p ON c.item_id = p.product_id
      WHERE c.user_id = $1
    `, [userId]);

    res.render('remove-from-cart', { cartItems: cartItems.rows });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading cart items');
  }
});

app.post('/remove-from-cart', isAuthenticated, async (req, res) => {
  const product_id = parsePositiveInteger(req.body.product_id);
  const userId = req.session.userId;

  if (product_id === null) {
    return res.status(400).send('Product ID must be a valid positive integer');
  }

  try {
    const itemExists = await pool.query(
      'SELECT 1 FROM cart WHERE user_id = $1 AND item_id = $2',
      [userId, product_id]
    );

    if (itemExists.rowCount === 0) {
      return res.status(404).send('Item not found in your cart');
    }

    await pool.query(
      'DELETE FROM cart WHERE user_id = $1 AND item_id = $2',
      [userId, product_id]
    );

    res.redirect('/display-cart');
  } catch (err) {
    console.error('Error removing item:', err);
    res.status(500).send('Error removing item');
  }
});

app.get('/display-cart', isAuthenticated, async (req, res) => {
  const userId = req.session.userId;

  try {
    const result = await pool.query(`
      SELECT c.item_id AS product_id, p.name, p.price, c.quantity
      FROM cart c
      JOIN products p ON c.item_id = p.product_id
      WHERE c.user_id = $1
    `, [userId]);

    res.render('display-cart', { cartItems: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to load cart');
  }
});

app.post('/place-order', isAuthenticated, async (req, res) => {
  const userId = req.session.userId;
  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;

    const cartResult = await client.query(`
      SELECT c.item_id AS product_id, c.quantity, p.price, p.stock_quantity
      FROM cart c
      JOIN products p ON c.item_id = p.product_id
      WHERE c.user_id = $1
      ORDER BY c.item_id
      FOR UPDATE OF c, p
    `, [userId]);

    if (cartResult.rowCount === 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).send('Your cart is empty');
    }

    for (const item of cartResult.rows) {
      if (item.quantity > item.stock_quantity) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        return res.status(409).send('Insufficient stock for one or more items');
      }
    }

    const totalResult = await client.query(`
      SELECT SUM(c.quantity * p.price) AS total_amount
      FROM cart c
      JOIN products p ON c.item_id = p.product_id
      WHERE c.user_id = $1
    `, [userId]);

    const orderResult = await client.query(
      'INSERT INTO orders (user_id, total_amount) VALUES ($1, $2) RETURNING order_id',
      [userId, totalResult.rows[0].total_amount]
    );
    const orderId = orderResult.rows[0].order_id;

    for (const item of cartResult.rows) {
      await client.query(
        'INSERT INTO orderitems (order_id, product_id, quantity, price) VALUES ($1, $2, $3, $4)',
        [orderId, item.product_id, item.quantity, item.price]
      );

      const stockUpdate = await client.query(
        'UPDATE products SET stock_quantity = stock_quantity - $1 WHERE product_id = $2 AND stock_quantity >= $1',
        [item.quantity, item.product_id]
      );

      if (stockUpdate.rowCount === 0) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        return res.status(409).send('Insufficient stock for one or more items');
      }
    }

    await client.query('DELETE FROM cart WHERE user_id = $1', [userId]);
    await client.query('COMMIT');
    transactionStarted = false;
    res.redirect('/order-confirmation');
  } catch (err) {
    if (transactionStarted && client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Error rolling back checkout:', rollbackError);
      }
    }
    console.error('Error in /place-order:', err);
    res.status(500).send('Failed to place order');
  } finally {
    if (client) client.release();
  }
});

app.get('/order-confirmation', isAuthenticated, async (req, res) => {
  res.render('order-confirmation');
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

module.exports = { app, pool };
