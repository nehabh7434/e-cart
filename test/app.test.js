const request = require('supertest');
const bcrypt = require('bcrypt');
const { app, pool, sessionStore } = require('../app');
const { getPoolConfig, initializeDatabase, validateEnvironment } = require('../db');
const { seedProducts } = require('../scripts/seed-products');

const products = [
  { id: 1, name: 'Test Phone', price: '125.50', stock: 8 },
  { id: 2, name: 'Test Book', price: '20.00', stock: 2 },
  { id: 3, name: 'Out of Stock Item', price: '9.99', stock: 0 },
];

let emailNumber = 0;

function freshEmail() {
  emailNumber += 1;
  return `buyer${emailNumber}@example.test`;
}

function failNextQuery(matcher, message = 'database unavailable') {
  const originalQuery = pool.query.bind(pool);
  let shouldFail = true;
  jest.spyOn(pool, 'query').mockImplementation((...args) => {
    const queryText = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    if (shouldFail && matcher.test(queryText || '')) {
      shouldFail = false;
      return Promise.reject(new Error(message));
    }
    return originalQuery(...args);
  });
}

async function register(agent = request.agent(app), details = {}) {
  const user = {
    username: 'Test Buyer',
    email: freshEmail(),
    password: 'secure-pass-123',
    ...details,
  };
  const response = await agent.post('/signup').type('form').send(user);
  const lookup = response.status === 302
    ? await pool.query('SELECT user_id FROM users WHERE email = $1', [user.email.trim().toLowerCase()])
    : { rows: [] };
  return { agent, user: { ...user, userId: lookup.rows[0]?.user_id }, response };
}

async function createUser(email = freshEmail(), password = 'secure-pass-123') {
  const hash = await bcrypt.hash(password, 4);
  const result = await pool.query(
    'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING user_id',
    ['Existing Buyer', email, hash]
  );
  return { userId: result.rows[0].user_id, email, password };
}

async function addCartItem(userId, productId, quantity) {
  await pool.query(
    'INSERT INTO cart (user_id, item_id, quantity) VALUES ($1, $2, $3)',
    [userId, productId, quantity]
  );
}

beforeEach(async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  await pool.query('TRUNCATE users, products RESTART IDENTITY CASCADE');
  for (const product of products) {
    await pool.query(
      'INSERT INTO products (product_id, name, price, stock_quantity) VALUES ($1, $2, $3, $4)',
      [product.id, product.name, product.price, product.stock]
    );
  }
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await sessionStore.close();
  await pool.end();
});

describe('database configuration', () => {
  test('uses verified TLS for Neon URLs and preserves other query parameters', () => {
    const config = getPoolConfig({
      DATABASE_URL: 'postgresql://app:password@ep-example.neon.tech/ecart?sslmode=require&channel_binding=require',
    });
    const url = new URL(config.connectionString);

    expect(config.ssl).toEqual({ rejectUnauthorized: true });
    expect(url.searchParams.get('sslmode')).toBeNull();
    expect(url.searchParams.get('channel_binding')).toBe('require');
  });

  test.each([
    'sslmode=disable',
    'sslmode=prefer',
    'sslmode=no-verify',
    'ssl=no-verify',
    'ssl=false',
  ])(
    'rejects weakened TLS option %s in a database URL',
    (sslOption) => {
      expect(() => getPoolConfig({
        DATABASE_URL: `postgresql://app:password@ep-example.neon.tech/ecart?${sslOption}`,
      })).toThrow('must not disable or weaken TLS certificate verification');
    }
  );

  test('preserves discrete local database settings', () => {
    const config = getPoolConfig({
      DB_USER: 'ecart',
      DB_PASSWORD: 'local-password',
      DB_HOST: 'localhost',
      DB_NAME: 'ecart',
    });

    expect(config).toMatchObject({
      user: 'ecart',
      password: 'local-password',
      host: 'localhost',
      database: 'ecart',
      port: 5432,
    });
    expect(config.connectionString).toBeUndefined();
  });

  test('requires HTTPS settings and a strong session secret in production', () => {
    const productionEnv = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://app:password@ep-example.neon.tech/ecart',
      SESSION_SECRET: 'a-production-session-secret-at-least-32-bytes',
      COOKIE_SECURE: 'true',
    };

    expect(() => validateEnvironment(productionEnv)).not.toThrow();
    expect(() => validateEnvironment({ ...productionEnv, COOKIE_SECURE: 'false' }))
      .toThrow('COOKIE_SECURE=true is required in production');
    expect(() => validateEnvironment({ ...productionEnv, SESSION_SECRET: 'short' }))
      .toThrow('at least 32 bytes in production');
  });
});

describe('public pages and product listing', () => {
  test('serves a lightweight health response without creating a session', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  test('renders the public login page from the home route', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(200);
    expect(response.text).toContain('Login to Your Account');
    expect(response.text).toContain('action="/login"');
  });

  test('lists products in product ID order for an authenticated user', async () => {
    const { agent } = await register();
    const response = await agent.get('/list-products');
    expect(response.status).toBe(200);
    expect(response.text.indexOf('Test Phone')).toBeLessThan(response.text.indexOf('Test Book'));
  });

  test('returns a server error when the public catalog query fails', async () => {
    failNextQuery(/SELECT \* FROM Products/i);
    const response = await request(app).get('/');
    expect(response.status).toBe(500);
    expect(response.text).toBe('Server error');
  });

  test('renders the login page with its existing form', async () => {
    const response = await request(app).get('/login');
    expect(response.status).toBe(200);
    expect(response.text).toContain('action="/login"');
  });

  test('renders the signup page with its existing form', async () => {
    const response = await request(app).get('/signup');
    expect(response.status).toBe(200);
    expect(response.text).toContain('action="/signup"');
  });
});

describe('signup and authentication', () => {
  test.each([
    [{ email: 'a@example.test', password: 'secure-pass-123' }, 'Username, email, and password are required'],
    [{ username: 'Buyer', password: 'secure-pass-123' }, 'Username, email, and password are required'],
    [{ username: 'Buyer', email: 'a@example.test' }, 'Username, email, and password are required'],
    [{ username: '   ', email: 'a@example.test', password: 'secure-pass-123' }, 'Username, email, and password are required'],
  ])('rejects signup with missing or blank required fields', async (details, expectedMessage) => {
    const response = await request(app).post('/signup').type('form').send(details);
    expect(response.status).toBe(400);
    expect(response.text).toBe(expectedMessage);
  });

  test.each(['not-an-email', 'missing-at.example.test', 'a@b'])(
    'rejects malformed signup email %s',
    async (email) => {
      const response = await request(app).post('/signup').type('form').send({
        username: 'Buyer',
        email,
        password: 'secure-pass-123',
      });
      expect(response.status).toBe(400);
      expect(response.text).toBe('A valid email address is required');
    }
  );

  test('rejects a short signup password', async () => {
    const response = await request(app).post('/signup').type('form').send({
      username: 'Buyer',
      email: 'short@example.test',
      password: '12345',
    });
    expect(response.status).toBe(400);
    expect(response.text).toContain('at least 6 characters');
  });

  test('rejects usernames longer than the database column', async () => {
    const response = await request(app).post('/signup').type('form').send({
      username: 'x'.repeat(101),
      email: 'long@example.test',
      password: 'secure-pass-123',
    });
    expect(response.status).toBe(400);
  });

  test('creates an account with a password hash and starts a session', async () => {
    const { agent, user, response } = await register();
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/dashboard');
    const stored = await pool.query('SELECT username, password_hash FROM users WHERE email = $1', [
      user.email,
    ]);
    expect(stored.rows[0].username).toBe(user.username);
    expect(stored.rows[0].password_hash).not.toBe(user.password);
    expect(await bcrypt.compare(user.password, stored.rows[0].password_hash)).toBe(true);
    expect((await agent.get('/dashboard')).status).toBe(200);
  });

  test('persists authenticated sessions in PostgreSQL with HTTP-only cookie attributes', async () => {
    const { agent, user, response } = await register();
    expect(response.status).toBe(302);

    const sessionCookie = response.headers['set-cookie'][0];
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Lax');
    expect(sessionCookie).toContain('Expires=');
    expect(sessionCookie).not.toContain('; Secure');

    const storedSession = await pool.query(
      `SELECT sess->>'userId' AS user_id
       FROM "session"
       WHERE expire > NOW() AND sess->>'userId' = $1
       LIMIT 1`,
      [String(user.userId)]
    );
    expect(storedSession.rows).toEqual([{ user_id: String(user.userId) }]);
    expect((await agent.get('/dashboard')).status).toBe(200);
  });

  test('database initialization is repeatable and preserves existing records', async () => {
    const user = await createUser();
    await initializeDatabase(pool);
    await initializeDatabase(pool);

    const savedUser = await pool.query('SELECT email FROM users WHERE user_id = $1', [user.userId]);
    const sessionTable = await pool.query(
      `SELECT to_regclass('public.session') AS table_name,
              EXISTS (
                SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND indexname = 'IDX_session_expire'
              ) AS index_exists`
    );
    expect(savedUser.rows).toEqual([{ email: user.email }]);
    expect(sessionTable.rows[0].table_name).toBe('session');
    expect(sessionTable.rows[0].index_exists).toBe(true);
  });

  test('demo product seeding is repeatable and does not overwrite existing products', async () => {
    const firstRunCount = await seedProducts(pool);
    const secondRunCount = await seedProducts(pool);
    const result = await pool.query(
      'SELECT product_id, name, price, stock_quantity FROM products ORDER BY product_id'
    );

    expect(firstRunCount).toBe(2);
    expect(secondRunCount).toBe(0);
    expect(result.rows).toHaveLength(5);
    expect(result.rows[0]).toEqual({
      product_id: 1,
      name: 'Test Phone',
      price: '125.50',
      stock_quantity: 8,
    });
    expect(result.rows.slice(3)).toEqual([
      { product_id: 4, name: 'Microwave', price: '199.99', stock_quantity: 25 },
      { product_id: 5, name: 'T-Shirt', price: '19.99', stock_quantity: 100 },
    ]);
  });

  test('trims the username and normalizes the email on signup', async () => {
    const email = `MiXeD${emailNumber}@Example.Test`;
    const { response } = await register(request.agent(app), {
      username: '  Buyer  ',
      email,
    });
    expect(response.status).toBe(302);
    const stored = await pool.query('SELECT username, email FROM users');
    expect(stored.rows[0]).toEqual({ username: 'Buyer', email: email.toLowerCase() });
  });

  test('rejects a duplicate email without exposing database details', async () => {
    const email = freshEmail();
    expect((await register(request.agent(app), { email })).response.status).toBe(302);
    const duplicate = await request(app).post('/signup').type('form').send({
      username: 'Another Buyer',
      email,
      password: 'secure-pass-123',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.text).toBe('An account with this email already exists');
    expect(duplicate.text).not.toContain('users_email_key');
  });

  test('rejects signup when the database insert fails', async () => {
    failNextQuery(/INSERT INTO users/i);
    const response = await request(app).post('/signup').type('form').send({
      username: 'Buyer',
      email: 'db-error@example.test',
      password: 'secure-pass-123',
    });
    expect(response.status).toBe(500);
    expect(response.text).toBe('Signup failed');
  });

  test('redirects a logged-in user away from signup submission', async () => {
    const { agent } = await register();
    const response = await agent.post('/signup').type('form').send({
      username: 'Second Buyer',
      email: freshEmail(),
      password: 'secure-pass-123',
    });
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/dashboard');
  });

  test('rejects login when required credentials are missing', async () => {
    const response = await request(app).post('/login').type('form').send({ email: 'a@example.test' });
    expect(response.status).toBe(400);
    expect(response.text).toBe('Email and password are required');
  });

  test('returns the same unauthorized response for an unknown account', async () => {
    const response = await request(app).post('/login').type('form').send({
      email: 'unknown@example.test',
      password: 'secure-pass-123',
    });
    expect(response.status).toBe(401);
    expect(response.text).toBe('Invalid email or password');
  });

  test('rejects an incorrect password', async () => {
    const user = await createUser();
    const response = await request(app).post('/login').type('form').send({
      email: user.email,
      password: 'wrong-password',
    });
    expect(response.status).toBe(401);
    expect(response.text).toBe('Invalid email or password');
  });

  test('logs in with a case-insensitive email and establishes a session', async () => {
    const user = await createUser();
    const agent = request.agent(app);
    const response = await agent.post('/login').type('form').send({
      email: user.email.toUpperCase(),
      password: user.password,
    });
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/dashboard');
    expect((await agent.get('/dashboard')).status).toBe(200);
  });

  test('redirects an authenticated visitor from the login page', async () => {
    const { agent } = await register();
    const response = await agent.get('/login');
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/dashboard');
  });

  test('returns a safe server error when the login query fails', async () => {
    failNextQuery(/SELECT \* FROM users WHERE email/i);
    const response = await request(app).post('/login').type('form').send({
      email: 'buyer@example.test',
      password: 'secure-pass-123',
    });
    expect(response.status).toBe(500);
    expect(response.text).toBe('Login failed');
  });

  test('logs out and invalidates the authenticated session', async () => {
    const { agent } = await register();
    const logout = await agent.get('/logout');
    expect(logout.status).toBe(302);
    expect(logout.headers.location).toBe('/login');
    expect((await agent.get('/dashboard')).status).toBe(302);
  });
});

describe('authorization and product routes', () => {
  test.each([
    ['dashboard', 'GET', '/dashboard'],
    ['product list', 'GET', '/list-products'],
    ['add-to-cart form', 'GET', '/add-to-cart'],
    ['remove-from-cart form', 'GET', '/remove-from-cart'],
    ['cart display', 'GET', '/display-cart'],
    ['order confirmation', 'GET', '/order-confirmation'],
    ['checkout', 'POST', '/place-order'],
    ['add-to-cart submission', 'POST', '/add-to-cart'],
    ['remove-from-cart submission', 'POST', '/remove-from-cart'],
  ])('requires authentication for the %s route', async (_name, method, route) => {
    const response = await request(app)[method.toLowerCase()](route);
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/login');
  });

  test('renders the product list for an authenticated user', async () => {
    const { agent } = await register();
    const response = await agent.get('/list-products');
    expect(response.status).toBe(200);
    expect(response.text).toContain('Test Phone');
    expect(response.text).toContain('Out of Stock Item');
  });

  test('returns an error when the authenticated product query fails', async () => {
    const { agent } = await register();
    failNextQuery(/SELECT \* FROM products ORDER BY product_id/i);
    const response = await agent.get('/list-products');
    expect(response.status).toBe(500);
    expect(response.text).toBe('Error loading products');
  });
});

describe('cart behavior', () => {
  test.each([
    ['missing', undefined],
    ['zero', '0'],
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['nonnumeric', 'abc'],
  ])('rejects a %s product ID', async (_name, productId) => {
    const { agent } = await register();
    const response = await agent.post('/add-to-cart').type('form').send({
      product_id: productId,
      quantity: '1',
    });
    expect(response.status).toBe(400);
    expect(response.text).toContain('Product ID');
  });

  test.each([
    ['missing', undefined],
    ['zero', '0'],
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['nonnumeric', 'abc'],
  ])('rejects a %s cart quantity', async (_name, quantity) => {
    const { agent } = await register();
    const response = await agent.post('/add-to-cart').type('form').send({
      product_id: '1',
      quantity,
    });
    expect(response.status).toBe(400);
    expect(response.text).toContain('Quantity');
  });

  test('returns not found when adding an unknown product', async () => {
    const { agent } = await register();
    const response = await agent.post('/add-to-cart').type('form').send({
      product_id: '99',
      quantity: '1',
    });
    expect(response.status).toBe(404);
    expect(response.text).toBe('Product not found');
  });

  test('rejects adding more than available stock', async () => {
    const { agent } = await register();
    const response = await agent.post('/add-to-cart').type('form').send({
      product_id: '1',
      quantity: '9',
    });
    expect(response.status).toBe(409);
    expect(response.text).toBe('Insufficient stock');
  });

  test('rejects adding a zero-stock product', async () => {
    const { agent } = await register();
    const response = await agent.post('/add-to-cart').type('form').send({
      product_id: '3',
      quantity: '1',
    });
    expect(response.status).toBe(409);
  });

  test('adds an item to the cart and redirects to the cart page', async () => {
    const { agent, user } = await register();
    const response = await agent.post('/add-to-cart').type('form').send({
      product_id: '1',
      quantity: '2',
    });
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/display-cart');
    const rows = await pool.query('SELECT quantity FROM cart WHERE item_id = 1');
    expect(rows.rows[0].quantity).toBe(2);
    expect(user.email).toContain('@example.test');
  });

  test('increments an existing cart line on repeated add', async () => {
    const { agent, user } = await register();
    await agent.post('/add-to-cart').type('form').send({ product_id: '1', quantity: '2' });
    await agent.post('/add-to-cart').type('form').send({ product_id: '1', quantity: '3' });
    const rows = await pool.query('SELECT quantity FROM cart WHERE user_id = (SELECT user_id FROM users WHERE email = $1)', [
      user.email,
    ]);
    expect(rows.rows[0].quantity).toBe(5);
  });

  test('does not increment a cart line beyond current stock', async () => {
    const { agent, user } = await register();
    await agent.post('/add-to-cart').type('form').send({ product_id: '1', quantity: '7' });
    const response = await agent.post('/add-to-cart').type('form').send({
      product_id: '1',
      quantity: '2',
    });
    expect(response.status).toBe(409);
    const rows = await pool.query(
      'SELECT quantity FROM cart WHERE user_id = (SELECT user_id FROM users WHERE email = $1)',
      [user.email]
    );
    expect(rows.rows[0].quantity).toBe(7);
  });

  test('does not mix cart contents between accounts', async () => {
    const first = await register();
    const second = await register();
    await first.agent.post('/add-to-cart').type('form').send({ product_id: '1', quantity: '2' });
    const secondCart = await second.agent.get('/display-cart');
    expect(secondCart.text).toContain('Your cart is empty');
  });

  test('returns a safe server error when adding to cart fails', async () => {
    const { agent } = await register();
    failNextQuery(/SELECT \* FROM products WHERE product_id/i);
    const response = await agent.post('/add-to-cart').type('form').send({
      product_id: '1',
      quantity: '1',
    });
    expect(response.status).toBe(500);
    expect(response.text).toBe('Failed to add product to cart');
  });

  test('renders the empty-cart state', async () => {
    const { agent } = await register();
    const response = await agent.get('/display-cart');
    expect(response.status).toBe(200);
    expect(response.text).toContain('Your cart is empty');
  });

  test('renders cart quantity, product details, and calculated line total', async () => {
    const { agent } = await register();
    await agent.post('/add-to-cart').type('form').send({ product_id: '1', quantity: '2' });
    const response = await agent.get('/display-cart');
    expect(response.status).toBe(200);
    expect(response.text).toContain('Test Phone');
    expect(response.text).toContain('251');
  });

  test('returns a safe server error when loading the cart fails', async () => {
    const { agent } = await register();
    failNextQuery(/SELECT c\.item_id AS product_id, p\.name, p\.price, c\.quantity/i);
    const response = await agent.get('/display-cart');
    expect(response.status).toBe(500);
    expect(response.text).toBe('Failed to load cart');
  });

  test('renders the remove form for a cart that contains an item', async () => {
    const { agent } = await register();
    await agent.post('/add-to-cart').type('form').send({ product_id: '1', quantity: '1' });
    const response = await agent.get('/remove-from-cart');
    expect(response.status).toBe(200);
    expect(response.text).toContain('Enter Product ID to Remove');
    expect(response.text).toContain('action="/remove-from-cart"');
    expect(response.text).toContain('name="product_id"');
  });

  test('returns a safe error when loading removable items fails', async () => {
    const { agent } = await register();
    failNextQuery(/SELECT c\.item_id AS product_id, p\.name\s+FROM cart/i);
    const response = await agent.get('/remove-from-cart');
    expect(response.status).toBe(500);
    expect(response.text).toBe('Error loading cart items');
  });

  test('rejects an invalid product ID when removing an item', async () => {
    const { agent } = await register();
    const response = await agent.post('/remove-from-cart').type('form').send({ product_id: '0' });
    expect(response.status).toBe(400);
  });

  test('returns not found when removing an item absent from the cart', async () => {
    const { agent } = await register();
    const response = await agent.post('/remove-from-cart').type('form').send({ product_id: '1' });
    expect(response.status).toBe(404);
    expect(response.text).toBe('Item not found in your cart');
  });

  test('removes an existing cart item', async () => {
    const { agent, user } = await register();
    await agent.post('/add-to-cart').type('form').send({ product_id: '1', quantity: '1' });
    const response = await agent.post('/remove-from-cart').type('form').send({ product_id: '1' });
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/display-cart');
    const rows = await pool.query(
      'SELECT 1 FROM cart WHERE user_id = (SELECT user_id FROM users WHERE email = $1)',
      [user.email]
    );
    expect(rows.rowCount).toBe(0);
  });

  test('returns a safe error when the remove query fails', async () => {
    const { agent } = await register();
    failNextQuery(/SELECT 1 FROM cart WHERE user_id/i);
    const response = await agent.post('/remove-from-cart').type('form').send({ product_id: '1' });
    expect(response.status).toBe(500);
    expect(response.text).toBe('Error removing item');
  });
});

describe('checkout transactions and stock safety', () => {
  test('returns a bad request for an empty checkout', async () => {
    const { agent } = await register();
    const response = await agent.post('/place-order');
    expect(response.status).toBe(400);
    expect(response.text).toBe('Your cart is empty');
    expect((await pool.query('SELECT count(*) FROM orders')).rows[0].count).toBe('0');
  });

  test('creates an order, records line items, decrements stock, and empties the cart', async () => {
    const { agent, user } = await register();
    await agent.post('/add-to-cart').type('form').send({ product_id: '1', quantity: '2' });
    const response = await agent.post('/place-order');
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/order-confirmation');
    const order = await pool.query('SELECT order_id, total_amount FROM orders');
    expect(order.rows[0].total_amount).toBe('251.00');
    const item = await pool.query('SELECT product_id, quantity, price FROM orderitems');
    expect(item.rows[0]).toMatchObject({ product_id: 1, quantity: 2, price: '125.50' });
    expect((await pool.query('SELECT stock_quantity FROM products WHERE product_id = 1')).rows[0].stock_quantity).toBe(6);
    expect((await pool.query(
      'SELECT count(*) FROM cart WHERE user_id = (SELECT user_id FROM users WHERE email = $1)',
      [user.email]
    )).rows[0].count).toBe('0');
  });

  test('uses current product price as the recorded order item price', async () => {
    const { agent } = await register();
    await agent.post('/add-to-cart').type('form').send({ product_id: '2', quantity: '1' });
    await pool.query('UPDATE products SET price = 25 WHERE product_id = 2');
    await agent.post('/place-order');
    const item = await pool.query('SELECT price FROM orderitems WHERE product_id = 2');
    expect(item.rows[0].price).toBe('25.00');
  });

  test('rejects checkout when stored cart quantity exceeds current stock', async () => {
    const { agent, user } = await register();
    await addCartItem(user.userId, 1, 9);
    const response = await agent.post('/place-order');
    expect(response.status).toBe(409);
    expect((await pool.query('SELECT count(*) FROM orders')).rows[0].count).toBe('0');
    expect((await pool.query('SELECT stock_quantity FROM products WHERE product_id = 1')).rows[0].stock_quantity).toBe(8);
    expect((await pool.query('SELECT count(*) FROM cart')).rows[0].count).toBe('1');
  });

  test('rolls back every item if one line has insufficient stock', async () => {
    const { agent, user } = await register();
    await addCartItem(user.userId, 1, 2);
    await addCartItem(user.userId, 2, 3);
    const response = await agent.post('/place-order');
    expect(response.status).toBe(409);
    expect((await pool.query('SELECT count(*) FROM orders')).rows[0].count).toBe('0');
    expect((await pool.query('SELECT count(*) FROM orderitems')).rows[0].count).toBe('0');
    expect((await pool.query('SELECT stock_quantity FROM products WHERE product_id = 1')).rows[0].stock_quantity).toBe(8);
    expect((await pool.query('SELECT count(*) FROM cart')).rows[0].count).toBe('2');
  });

  test('rolls back an order if a database error occurs after BEGIN', async () => {
    const { agent } = await register();
    await agent.post('/add-to-cart').type('form').send({ product_id: '1', quantity: '1' });
    await pool.query('DROP TRIGGER IF EXISTS test_reject_order_item ON orderitems');
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_reject_order_item() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'simulated order item failure';
      END;
      $$
    `);
    await pool.query(`
      CREATE TRIGGER test_reject_order_item
      BEFORE INSERT ON orderitems
      FOR EACH ROW EXECUTE FUNCTION test_reject_order_item()
    `);

    try {
      const response = await agent.post('/place-order');
      expect(response.status).toBe(500);
      expect((await pool.query('SELECT count(*) FROM orders')).rows[0].count).toBe('0');
      expect((await pool.query('SELECT stock_quantity FROM products WHERE product_id = 1')).rows[0].stock_quantity).toBe(8);
      expect((await pool.query('SELECT count(*) FROM cart')).rows[0].count).toBe('1');
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS test_reject_order_item ON orderitems');
      await pool.query('DROP FUNCTION IF EXISTS test_reject_order_item()');
    }
  });

  test('handles a checkout connection failure without crashing the route', async () => {
    const { agent } = await register();
    const realConnect = pool.connect.bind(pool);
    jest.spyOn(pool, 'connect').mockImplementation((callback) => {
      if (typeof callback === 'function') return realConnect(callback);
      return Promise.reject(new Error('connection unavailable'));
    });
    const response = await agent.post('/place-order');
    expect(response.status).toBe(500);
    expect(response.text).toBe('Failed to place order');
  });

  test('releases the checkout connection when cart is empty', async () => {
    const { agent } = await register();
    const realConnect = pool.connect.bind(pool);
    const releaseSpy = jest.fn();
    jest.spyOn(pool, 'connect').mockImplementation((callback) => {
      if (typeof callback === 'function') return realConnect(callback);
      return realConnect().then((client) => {
        const realRelease = client.release.bind(client);
        client.release = () => {
          releaseSpy();
          realRelease();
        };
        return client;
      });
    });
    const response = await agent.post('/place-order');
    expect(response.status).toBe(400);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  test('renders confirmation only for an authenticated user', async () => {
    const { agent } = await register();
    const response = await agent.get('/order-confirmation');
    expect(response.status).toBe(200);
    expect(response.text).toContain('successfully placed');
  });

  test('allows only one purchase when two users compete for the final unit', async () => {
    await pool.query('UPDATE products SET stock_quantity = 1 WHERE product_id = 1');
    const first = await register();
    const second = await register();
    await first.agent.post('/add-to-cart').type('form').send({ product_id: '1', quantity: '1' });
    await second.agent.post('/add-to-cart').type('form').send({ product_id: '1', quantity: '1' });
    const outcomes = await Promise.all([
      first.agent.post('/place-order'),
      second.agent.post('/place-order'),
    ]);
    expect(outcomes.map((result) => result.status).sort()).toEqual([302, 409]);
    expect((await pool.query('SELECT stock_quantity FROM products WHERE product_id = 1')).rows[0].stock_quantity).toBe(0);
    expect((await pool.query('SELECT count(*) FROM orders')).rows[0].count).toBe('1');
  });

  test('serializes simultaneous checkout submissions from the same cart', async () => {
    const { agent } = await register();
    await agent.post('/add-to-cart').type('form').send({ product_id: '1', quantity: '1' });
    const outcomes = await Promise.all([
      agent.post('/place-order'),
      agent.post('/place-order'),
    ]);
    expect(outcomes.map((result) => result.status).sort()).toEqual([302, 400]);
    expect((await pool.query('SELECT count(*) FROM orders')).rows[0].count).toBe('1');
    expect((await pool.query('SELECT stock_quantity FROM products WHERE product_id = 1')).rows[0].stock_quantity).toBe(7);
  });
});
