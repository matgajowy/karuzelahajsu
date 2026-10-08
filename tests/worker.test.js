import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import worker from "../src/worker/index.js";
import { allowedMethods, findRoute } from "../src/worker/routes/index.js";

function createEnv({ user = null, assets = null, rows = [] } = {}) {
  const writes = [];
  const env = {
    writes,
    ASSETS: assets,
    DB: {
      prepare(sql) {
        return {
          first: async () => null,
          bind(...values) {
            return {
              first: async () => sql.includes("FROM sessions") ? user : null,
              run: async () => {
                writes.push({ sql, values });
                return { success: true };
              },
              all: async () => ({ results: rows }),
            };
          },
          all: async () => ({ results: rows }),
          run: async () => ({ success: true }),
        };
      },
    },
  };
  return env;
}

test("route registry covers all frontend API endpoints", () => {
  const frontendRoutes = [
    ["GET", "/api/me"],
    ["GET", "/api/leaderboard"],
    ["GET", "/api/feed"],
    ["GET", "/api/portfolio"],
    ["POST", "/api/profile"],
    ["GET", "/api/admin/users"],
    ["POST", "/api/admin/users"],
    ["GET", "/api/instruments/search"],
    ["POST", "/api/trade"],
    ["POST", "/api/logout"],
    ["GET", "/api/admin/audit"],
    ["GET", "/api/admin/sync-prices"],
  ];

  for (const [method, path] of frontendRoutes) {
    assert.equal(typeof findRoute(method, path), "function", `${method} ${path}`);
  }
});

test("page uses external scripts and delegated actions rather than inline handlers", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /\/assets\/js\/events\.js/);
  assert.doesNotMatch(html, /\son(?:click|change|submit|input|keypress)=/i);
  assert.match(html, /Cyrk Koin \(CK\)/);
  assert.match(html, /1 CK = 1\.00 PLN/);
  assert.match(html, /Gotówka \(CK\)/);
  assert.doesNotMatch(html, /Wynik \(PLN\)|Wycena \(PLN\)|100 000 PLN|zł/);
});

test("CK formatter provides safe text and visual token formats", async () => {
  const source = await readFile(new URL("../public/assets/js/utils.js", import.meta.url), "utf8");
  const result = runInNewContext(`${source}\nJSON.stringify({ visual: formatCK(12345.67), large: formatCK(12345.67, true, true), next: formatCK(10), text: formatCK(12345.67, false), invalid: formatCK(Infinity, false) })`);
  const formatted = JSON.parse(result);

  assert.equal(formatted.text, "12 345,67 CK");
  assert.equal(formatted.invalid, "0,00 CK");
  assert.match(formatted.visual, /class="ck-badge"/);
  assert.match(formatted.visual, /class="ck-gold-coin"/);
  assert.match(formatted.visual, /<text[^>]*>CK<\/text>/);
  assert.match(formatted.visual, /12 345,67/);
  assert.match(formatted.large, /class="ck-badge ck-badge-lg"/);
  assert.match(formatted.visual, /id="ckGoldFace1"/);
  assert.match(formatted.next, /id="ckGoldFace3"/);
  assert.match(formatted.next, /fill="url\(#ckGoldFace3\)"/);
});

test("unmatched methods return 405 and available methods", async () => {
  const response = await worker.fetch(
    new Request("https://dev.example/api/profile", { method: "GET" }),
    createEnv(),
    {},
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "POST");
});

test("unknown API routes return JSON 404", async () => {
  const response = await worker.fetch(
    new Request("https://dev.example/api/unknown"),
    createEnv(),
    {},
  );

  assert.equal(response.status, 404);
  assert.equal((await response.json()).status, "error");
});

test("OAuth start binds a unique CSRF state to a secure cookie", async () => {
  const env = createEnv();
  env.GITHUB_CLIENT_ID = "test-client";
  const response = await worker.fetch(
    new Request("https://dev.example/api/auth/github"),
    env,
    {},
  );
  const location = new URL(response.headers.get("Location"));
  const state = location.searchParams.get("state");

  assert.equal(response.status, 302);
  assert.match(response.headers.get("Set-Cookie"), new RegExp(`oauth_state_${state}=${state}`));
  assert.match(response.headers.get("Set-Cookie"), /Secure/);
  assert.equal(location.searchParams.get("redirect_uri"), "https://dev.example/api/auth/callback");
});

test("OAuth callback rejects missing CSRF state before exchanging a code", async () => {
  const response = await worker.fetch(
    new Request("https://dev.example/api/auth/callback?code=unused"),
    createEnv(),
    {},
  );

  assert.equal(response.status, 403);
  assert.match(await response.text(), /state/i);
});

test("dev OAuth gives a clear configuration response until a dev app is set up", async () => {
  const response = await worker.fetch(
    new Request("https://dev.example/api/auth/github"),
    { GITHUB_CLIENT_ID: "DEV_OAUTH_CLIENT_ID" },
    {},
  );

  assert.equal(response.status, 503);
});

test("profile update validates input and persists for the authenticated user", async () => {
  const env = createEnv({ user: { id: 7, is_admin: 0 } });
  const response = await worker.fetch(
    new Request("https://dev.example/api/profile", {
      method: "POST",
      headers: { Cookie: "session_token=test-session", "Content-Type": "application/json" },
      body: JSON.stringify({
        display_name: "New Name",
        avatar_url: "https://api.dicebear.com/7.x/bottts/svg?seed=test",
      }),
    }),
    env,
    {},
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "success");
  assert.ok(env.writes.some(({ sql, values }) =>
    sql.includes("UPDATE users SET display_name") &&
    values[0] === "New Name" &&
    values[2] === 7
  ));
});

test("admin can add a validated GitHub login to the whitelist", async () => {
  const env = createEnv({ user: { id: 3, is_admin: 1 } });
  const response = await worker.fetch(
    new Request("https://dev.example/api/admin/users", {
      method: "POST",
      headers: { Cookie: "session_token=admin-session", "Content-Type": "application/json" },
      body: JSON.stringify({
        github_login: "new-player",
        display_name: "New Player",
        is_admin: false,
      }),
    }),
    env,
    {},
  );

  assert.equal(response.status, 201);
  assert.equal((await response.json()).status, "success");
  assert.ok(env.writes.some(({ sql, values }) =>
    sql.includes("INSERT INTO users") &&
    values[0] === "new-player" &&
    values[1] === "New Player"
  ));
});

test("admin whitelist endpoint requires an administrator session", async () => {
  const env = createEnv();
  const response = await worker.fetch(
    new Request("https://dev.example/api/admin/users"),
    env,
    {},
  );

  assert.equal(response.status, 403);
  assert.equal(env.writes.length, 0);
});

test("leaderboard API exposes all portfolio values in CK at the fixed parity", async () => {
  const env = createEnv({
    rows: [{ Wycena_Calkowita_CK: 101000, Gotowka_CK: 1000 }],
  });
  const response = await worker.fetch(
    new Request("https://dev.example/api/leaderboard"),
    env,
    {},
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data[0].Zysk_Strata_CK, 1000);
  assert.equal(body.data[0].Stopa_Zwrotu, 0.01);
});

function createTradeEnv(currentCash) {
  const writes = [];
  const tradeUser = { id: 9, current_cash: currentCash, is_admin: 0 };
  const instrument = { ticker: "TEST", price: 100, fx_to_pln: 4 };
  const env = {
    writes,
    DB: {
      prepare(sql) {
        const statement = {
          sql,
          values: [],
          bind(...values) {
            this.values = values;
            return this;
          },
          async first() {
            if (sql.includes("FROM sessions")) return tradeUser;
            if (sql.startsWith("SELECT * FROM market_prices")) return instrument;
            if (sql.includes("u.current_cash,")) return { current_cash: currentCash, stocks_value: 0 };
            if (sql.includes("SELECT shares FROM holdings")) return null;
            return null;
          },
          async run() {
            writes.push({ sql, values: this.values });
            return { success: true };
          },
          async all() {
            return { results: [] };
          },
        };
        return statement;
      },
      async batch(statements) {
        writes.push(...statements.map(({ sql, values }) => ({ sql, values })));
        return [];
      },
    },
  };
  return env;
}

async function submitTestBuy(env, shares) {
  return worker.fetch(
    new Request("https://dev.example/api/trade", {
      method: "POST",
      headers: { Cookie: "session_token=test-session", "Content-Type": "application/json" },
      body: JSON.stringify({
        ticker: "TEST",
        type: "BUY",
        shares,
        thesis: "Kupuję pozycję testową do walidacji.",
      }),
    }),
    env,
    {},
  );
}

test("trade balance errors use CK and calculate USD value using the PLN parity rate", async () => {
  const response = await submitTestBuy(createTradeEnv(100), 1);
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.match(body.message, /Cyrk Koinów/);
  assert.match(body.message, /100\.00 CK/);
  assert.match(body.message, /400\.00 CK/);
});

test("trade audit log records converted transaction values as CK", async () => {
  const env = createTradeEnv(1000);
  const response = await submitTestBuy(env, 0.5);
  const body = await response.json();
  const audit = env.writes.find(({ sql }) => sql.includes("INSERT INTO audit_log"));

  assert.equal(response.status, 200);
  assert.equal(body.status, "success");
  assert.equal(JSON.parse(audit.values[2]).totalTradeCk, 200);
  assert.ok(env.writes.some(({ sql, values }) =>
    sql.includes("UPDATE users SET current_cash") && values[0] === 200
  ));
});
