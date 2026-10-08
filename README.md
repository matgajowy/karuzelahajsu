# Karuzela Hajsu

Cloudflare Worker application for a small paper-trading league.

The league's virtual currency is Cyrk Koin (CK), fixed at `1 CK = 1 PLN`.
Legacy D1 columns retain their PLN names; their stored values are numerically
identical to CK, so existing balances and transaction history are unchanged.

## Project layout

- `public/` contains the static site, styles, and browser scripts.
- `src/worker/index.js` is the Worker entry point.
- `src/worker/routes/` contains HTTP handlers grouped by feature.
- `src/worker/lib/` contains shared HTTP and authentication helpers.
- `src/worker/services/` contains market-price integrations.
- `migrations/` contains the D1 schema history.

## Local checks

```sh
npm ci
npm run build
npm test
npx wrangler deploy --env dev --dry-run
```

## Development deployment

The `dev` Wrangler environment uses the separate `liga_db_dev` database and
does not run scheduled price updates. Initialize its schema and deploy it with:

```sh
npx wrangler d1 migrations apply liga_db_dev --remote --env dev
npx wrangler deploy --env dev
```

The development Worker has its own `workers.dev` URL. To test GitHub login,
create a separate GitHub OAuth App with that Worker URL's
`/api/auth/callback` as its callback URL, then configure `GITHUB_CLIENT_ID`
under `[env.dev.vars]` and set `GITHUB_CLIENT_SECRET` for the Worker environment
`dev` (for example, `npx wrangler secret put GITHUB_CLIENT_SECRET --env dev`).
Replace the placeholder Client ID before deploying. Do not add secrets to
`wrangler.toml`.

The dev environment currently enables a development-only auth bypass using the
`demo_marta` account in `liga_db_dev`, so authenticated application flows can
be tested without GitHub OAuth. All dev visitors share this demo account and
its portfolio. It is not an administrator, and admin-only actions stay
unavailable. The bypass is controlled by `DEV_AUTH_BYPASS` and
`DEV_AUTH_LOGIN` under `[env.dev.vars]`; do not add these variables to the
production `[vars]` section.

To test actual GitHub OAuth instead, disable `DEV_AUTH_BYPASS` in the dev
environment and add an initial administrator through D1 using the GitHub login
that will authorize the development OAuth App:

```sql
INSERT INTO users (github_login, display_name, is_admin)
VALUES ('your-github-login', 'Development Admin', 1);
```
