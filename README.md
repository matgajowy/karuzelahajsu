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
- `src/worker/services/` contains market-price, Gemini, and email integrations.
- `migrations/` contains the D1 schema history.

## Local checks

```sh
npm ci
npm run build
npm test
npx wrangler deploy --env dev --dry-run
```

## Development deployment

The `dev` Wrangler environment uses the separate `liga_db_dev` database. It
sends weekday briefings at `06:30` and `15:30` UTC and syncs market prices
every 15 minutes from `07:00` through `20:45` UTC. Initialize its schema and
deploy it with:

```sh
npx wrangler d1 migrations apply liga_db_dev --remote --env dev
npm run deploy:dev
```

Configure the briefing secrets directly in the Cloudflare Worker environment;
never put their values in `wrangler.toml` or source control:

```sh
npx wrangler secret put GEMINI_API_KEY --env dev
npx wrangler secret put RESEND_API_KEY --env dev
npx wrangler secret put SLACK_CHANNEL_EMAIL --env dev
```

`SLACK_CHANNEL_EMAIL` must be the email address generated for the Slack
channel. Resend must be permitted to deliver to that recipient. The fixed cron
times are UTC; local delivery time shifts when Poland changes between CET and
CEST. Configure the same three secrets on any other Worker environment where
you want AI-generated briefings and roast text.

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

## Production deployment

Deploy the top-level production Worker (not the `dev` environment) with:

```sh
npm run deploy:prod
```

The explicit empty Wrangler environment selector prevents a warning when the
configuration also defines named environments such as `dev`. Use this command
as the Cloudflare build/deploy command for production.

The existing production D1 database predates the tracked migration history and
already contains the `^GSPC` and `WIG20` market-price symbols. Do not run
`wrangler d1 migrations apply` against it until its baseline is reconciled:
Wrangler currently reports the initial schema migration as pending, and
applying it could attempt to recreate existing tables.
