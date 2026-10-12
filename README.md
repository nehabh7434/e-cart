# E-Cart

E-Cart is a small e-commerce web application built as a full-stack project with Node.js, Express, EJS, and PostgreSQL. I wanted to practice the parts of a shop that involve more than displaying products: account creation, a persistent cart, and placing an order without overselling stock.

## Features

- Account signup and login with bcrypt password hashing and server-side sessions.
- Product catalog, per-user cart, item removal, and order confirmation.
- Checkout in a PostgreSQL transaction, with row locks and guarded stock updates.
- SQL schema and indexes, integration tests, and a GitHub Actions workflow.
- Docker Compose setup for running the app and PostgreSQL together.

## Technology and structure

- **Application:** Node.js 22, Express 5, EJS, `express-session`, `body-parser`
- **Database:** PostgreSQL 16 with `pg`
- **Password hashing:** bcrypt
- **Tests:** Jest and Supertest
- **Development and CI:** Docker, Docker Compose, and GitHub Actions

The Express routes and database queries are in `app.js`; EJS templates are in `views/`. `DDL.sql` defines the application tables and indexes, while `data.sql` provides sample products for a new local database. `indexes.sql` contains idempotent index statements. Integration tests and their isolated schema live in `test/`, and `scripts/prepare-test-db.js` creates the test database before running Jest.

## Database design

The schema has five tables:

- `Users` stores usernames, unique email addresses, and password hashes.
- `Products` stores the catalog and available stock.
- `Cart` links users to products and enforces one row per user/product pair.
- `Orders` stores a placed order and its total.
- `OrderItems` records the products, quantities, and prices captured for each order.

Foreign keys maintain the relationships, and the cart quantity has a positive-value check. Indexes cover cart lookups by product, order history by user and date, order dates, and order items by product. Primary keys and the unique email constraint provide their own indexes.

## Authentication and sessions

Passwords are hashed with bcrypt before storage. On successful signup or login, the session is regenerated before the user ID is saved, reducing session-fixation risk. The session cookie is HTTP-only and uses `SameSite=Lax`; its `Secure` flag is enabled only when `COOKIE_SECURE=true`.

`SESSION_SECRET` must be supplied through the environment. The local example values are placeholders, not production credentials. For local HTTP at `http://localhost:3000`, use `COOKIE_SECURE=false`. A production deployment must use HTTPS and set `COOKIE_SECURE=true`. If TLS terminates at a reverse proxy, configure Express to trust only the proxy hops that are actually controlled by the deployment, before installing session middleware. For example, a deployment with exactly one trusted proxy can use `app.set('trust proxy', 1)`. Do not enable proxy trust indiscriminately.

The app does not configure a persistent session store, so `express-session` uses its in-memory default. That is suitable only for local development and is a production deployment limitation.

## Checkout and stock handling

Checkout runs in a PostgreSQL transaction. It locks the current user's cart rows and matching product rows in product ID order, checks each requested quantity against current stock, records the order and its item prices, and decrements stock only when enough remains. If an item is no longer available, checkout rolls back; when successful, it clears the cart and commits. This coordinates concurrent checkouts through PostgreSQL row locks and the conditional stock update.

## Local setup

You need Node.js 22 or later and PostgreSQL 16 or a compatible PostgreSQL server.

1. Install dependencies with `npm ci`.
2. Copy `.env.example` to `.env` and set local database credentials plus a long, random `SESSION_SECRET`. Keep `COOKIE_SECURE=false` for local HTTP.
3. Create the configured database and apply `DDL.sql`, then load sample products from `data.sql`.
4. Start the app with `npm start` and open `http://localhost:3000`.

Do not commit `.env` or use its placeholder values for a public deployment.

## Docker Compose setup

1. Copy `.env.example` to `.env`; set `DB_PASSWORD` and `SESSION_SECRET` to local values. Leave `COOKIE_SECURE=false` for the local HTTP address.
2. Run `docker compose up --build`.
3. Open `http://localhost:3000`.

Compose starts PostgreSQL and waits for its health check before starting the app. On first initialization, PostgreSQL runs `DDL.sql` and loads `data.sql`. Database files persist in the `postgres-data` volume; the initialization scripts do not rerun while that volume already contains a database.

For production, provide strong deployment-specific database credentials and a random session secret, serve the application only behind HTTPS, and set `COOKIE_SECURE=true`. Configure proxy trust for the real network topology if HTTPS terminates before Express. The included Compose file is a local development setup, not a complete production hosting configuration.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`, `DB_NAME` | Application database connection |
| `SESSION_SECRET` | Required secret used to sign session cookies |
| `COOKIE_SECURE` | Set to `true` for HTTPS; use `false` for local HTTP |
| `APP_PORT` | Host port published by Docker Compose (defaults to `3000`) |
| `TEST_DB_USER`, `TEST_DB_PASSWORD`, `TEST_DB_HOST`, `TEST_DB_PORT`, `TEST_DB_NAME` | PostgreSQL connection and isolated database used by the test setup |
| `TEST_DB_ADMIN_DATABASE` | Database used to create the test database (defaults to `postgres`) |

The test runner defaults the test database name to `ecart_test`; its name must start with `ecart_test` and must not match `DB_NAME`.

## Routes

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/` | Public | Render the home page and product catalog |
| `GET` | `/signup` | Public | Render signup form |
| `POST` | `/signup` | Public | Validate details, create account, and sign in |
| `GET` | `/login` | Public / signed-in redirect | Render the login form or redirect an authenticated user |
| `POST` | `/login` | Public | Authenticate and start a session |
| `GET` | `/logout` | Public | Destroy the current session |
| `GET` | `/dashboard` | Signed in | Render the dashboard |
| `GET` | `/list-products` | Signed in | Show products |
| `GET`, `POST` | `/add-to-cart` | Signed in | Render the form and add a product to the cart |
| `GET`, `POST` | `/remove-from-cart` | Signed in | Show removable items and remove a product |
| `GET` | `/display-cart` | Signed in | Show the current user's cart |
| `POST` | `/place-order` | Signed in | Validate stock and place an order |
| `GET` | `/order-confirmation` | Signed in | Render order confirmation |

These routes render HTML pages and accept form submissions; there is no separate JSON API.

## Tests and CI

The integration tests use Jest and Supertest against PostgreSQL. The setup script creates or reuses an `ecart_test...` database, applies `test/schema.sql`, and runs Jest with coverage. The test database role needs permission to create databases. Tests truncate fixture tables, so never point test settings at production data.

Run the suite with:

```sh
npm test
```

Coverage is collected for `app.js`, with minimum 85% thresholds for statements, branches, functions, and lines. GitHub Actions runs on pushes and pull requests: it provisions a disposable PostgreSQL service, installs dependencies with `npm ci`, runs the integration suite, and builds the Docker image. The CI database credentials are test-only values for that ephemeral service; no local Windows PostgreSQL installation or repository secret is needed.

## Limitations and possible next steps

This project does not process payments, provide product or order administration, or expose a JSON API. Its default in-memory session store is not suitable for a multi-instance production deployment. The Docker setup serves HTTP directly and does not configure TLS or a production reverse proxy. Possible next steps include a managed persistent session store, production hosting and HTTPS configuration, payment integration, administrative workflows, CSRF protection, and more deployment-focused operational checks.
