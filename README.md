# E-Cart

E-Cart is a full-stack shop application built with Node.js, Express, EJS, and PostgreSQL. I built it to practice account handling, server-side sessions, cart operations, and checkout where stock must remain consistent when requests overlap.

## Features

- Signup and login with bcrypt password hashes and PostgreSQL-backed sessions.
- Product listing and per-user cart management.
- Transactional checkout with product row locks and guarded stock decrements.
- Repeatable database schema setup, integration tests, Docker Compose, and GitHub Actions.

The app does not accept or process payments.

## Stack and layout

- Node.js 22, Express 5, EJS, `express-session`, and `connect-pg-simple`
- PostgreSQL 16 with the `pg` driver
- Jest and Supertest
- Docker, Docker Compose, and GitHub Actions

`app.js` contains the routes and server setup. `db.js` creates the single shared PostgreSQL pool and applies the schema. `DDL.sql` defines application tables, `indexes.sql` contains query indexes, and `session.sql` defines the persistent session table. `data.sql` contains sample products for local Docker only; schema initialization never loads sample data. Views are in `views/`, and integration tests and their isolated schema are in `test/`.

## Database design and checkout

The schema has five application tables: `Users`, `Products`, `Cart`, `Orders`, and `OrderItems`. Foreign keys maintain relationships, the email address is unique, and cart quantities must be positive. Indexes support cart lookups by product, order history by user/date, date-based order queries, order-item product lookups, and session expiry.

Checkout runs in one PostgreSQL transaction. It locks the user's cart and matching product rows in product-ID order, checks current stock, records the order and item prices, and decrements inventory only when enough stock remains. An unavailable item rolls back the transaction; a successful checkout clears the cart and commits. No payment provider is configured.

## Authentication and sessions

Passwords are hashed with bcrypt. Signup and login regenerate the session before storing the user ID. Sessions are stored in PostgreSQL using the same `pg` pool as application queries, and expired rows are pruned by `connect-pg-simple`. Cookies are HTTP-only, `SameSite=Lax`, and expire after 24 hours.

`SESSION_SECRET` is required when starting the server. Production requires at least 32 bytes. For local HTTP, set `COOKIE_SECURE=false`; production startup requires `COOKIE_SECURE=true`. Render terminates HTTPS at its trusted proxy, so the app trusts one proxy hop in production. This lets Express recognize the forwarded HTTPS protocol for secure cookies; do not increase the trust count unless the actual network topology requires it.

## Local setup

You need Node.js 22.x and PostgreSQL 16 or compatible.

1. Run `npm ci`.
2. Copy `.env.example` to `.env`. Set `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_NAME`, `DB_PORT`, and a long random `SESSION_SECRET`. Leave `DATABASE_URL` empty to use the local `DB_*` settings.
3. Create the configured PostgreSQL database and run:

   ```sh
   npm run db:init
   ```

   This creates missing application tables, indexes, and the session table. It is repeatable and does not drop or reset data.
4. For sample products, load `data.sql` once into a new local database. It is separate from schema initialization and should not be used to reset a database containing real data.
5. Run `npm start` and open <http://localhost:3000>.

Do not commit `.env` or put real credentials in `.env.example`.

## Docker Compose

1. Copy `.env.example` to `.env` and set local `DB_PASSWORD` and `SESSION_SECRET` values. Keep `COOKIE_SECURE=false`.
2. Run `docker compose up --build`.
3. Open <http://localhost:3000>.

Compose starts PostgreSQL and waits for its health check before starting the app. A new PostgreSQL volume receives `DDL.sql` and sample products from `data.sql`; app startup then applies the repeatable schema initialization, including the session table. The `postgres-data` volume persists between runs. The Compose configuration is for local development, not production hosting.

## Render with Neon

This repository is prepared for a Render Node.js Web Service using Neon PostgreSQL; no Render or Neon resources are created by this project setup. In Render, set the build command to `npm ci` and the start command to `npm start`, and configure the environment variables below. Render supplies `PORT`; the server binds to `0.0.0.0` and exposes `GET /health` for a health check.

The app accepts a Neon `DATABASE_URL` and continues to support discrete `DB_*` variables for local and Docker use. When `DATABASE_URL` is set it takes precedence. TLS is enabled with certificate verification; connection-string options that disable or weaken verification are rejected. Use the Neon pooled connection string for the long-lived Render service where appropriate. Keep the URL in Render's secret environment configuration, not in Git, logs, or shell history.

The server applies `DDL.sql`, `indexes.sql`, and `session.sql` in a transaction before it begins listening. You can also run the same safe, repeatable initialization explicitly from a shell with the target database environment configured:

```sh
npm run db:init
```

The command creates missing tables and indexes only; it does not seed products, delete tables, or reset data. Configure the target `DATABASE_URL` in the shell's environment before running it, and do not put the actual connection string directly in a command or commit it. Schema changes that alter existing columns should be handled with a reviewed migration rather than relying on `CREATE TABLE IF NOT EXISTS`.

Render's reverse proxy is trusted for one hop only. This is needed for Express to use Render's forwarded HTTPS information when sending `Secure` cookies. Setting a broader trust policy can allow spoofed forwarded headers to affect security-sensitive request properties.

### Required Render environment variables

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Neon PostgreSQL connection URL; configure as a secret |
| `SESSION_SECRET` | Random secret of at least 32 bytes; configure as a secret |
| `COOKIE_SECURE` | `true` |
| `PORT` | Supplied by Render; do not hard-code it |

Do not set `DB_*` when using `DATABASE_URL`; it takes precedence. The server refuses production startup if `DATABASE_URL`, a sufficiently long `SESSION_SECRET`, or `COOKIE_SECURE=true` is missing.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Optional PostgreSQL connection URL; takes precedence over discrete settings |
| `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`, `DB_NAME` | Local/Docker PostgreSQL connection |
| `SESSION_SECRET` | Required session signing secret; at least 32 bytes in production |
| `COOKIE_SECURE` | `false` for local HTTP; `true` for HTTPS production |
| `PORT` | Web server port supplied by Render; falls back to `3000` outside platforms that set it |
| `APP_PORT` | Host port published by Docker Compose; defaults to `3000` |
| `TEST_DB_USER`, `TEST_DB_PASSWORD`, `TEST_DB_HOST`, `TEST_DB_PORT`, `TEST_DB_NAME` | Isolated PostgreSQL test database settings |
| `TEST_DB_ADMIN_DATABASE` | Administrative database used to create the test database; defaults to `postgres` |

## Routes

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | Public | Lightweight health response |
| `GET` | `/` | Public | Home page and product catalog |
| `GET` | `/signup` | Public | Signup form |
| `POST` | `/signup` | Public | Create an account and start a session |
| `GET` | `/login` | Public / signed-in redirect | Login form |
| `POST` | `/login` | Public | Authenticate and start a session |
| `GET` | `/logout` | Public | Destroy the current session |
| `GET` | `/dashboard` | Signed in | Dashboard |
| `GET` | `/list-products` | Signed in | Product list |
| `GET`, `POST` | `/add-to-cart` | Signed in | Add an item to the cart |
| `GET`, `POST` | `/remove-from-cart` | Signed in | Remove a cart item |
| `GET` | `/display-cart` | Signed in | Current user's cart |
| `POST` | `/place-order` | Signed in | Place an order |
| `GET` | `/order-confirmation` | Signed in | Order confirmation |

The application serves rendered HTML forms and pages; it does not expose a separate JSON API.

## Tests and CI

Run the Jest/Supertest integration suite with:

```sh
npm test
```

The test setup creates or reuses an isolated database whose name starts with `ecart_test`, applies `test/schema.sql`, then runs tests with coverage. Its PostgreSQL role needs permission to create databases. Tests truncate fixture tables, so never aim the test configuration at production data. Coverage thresholds are set to 85% for statements, branches, functions, and lines.

GitHub Actions runs on pushes and pull requests. It starts a disposable PostgreSQL service, installs dependencies with `npm ci`, runs the test setup and suite, and builds the Docker image. CI uses test-only credentials and does not rely on a developer's local database.

## Current limitations

There is no payment processing, product/order administration, or JSON API. The Compose setup is local-only and does not configure a production TLS endpoint. The database bootstrap handles creation of the current schema but is not a versioned migration system; future changes to existing tables need reviewed migrations. Possible next steps include payment-provider integration, administrative workflows, CSRF protection, and a formal migration process.
