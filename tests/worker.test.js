import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../src/worker/index.js";
import { allowedMethods, findRoute } from "../src/worker/routes/index.js";

function createEnv({ user = null, assets = null } = {}) {
  const writes = [];
  const env = {
    writes,
    ASSETS: assets,
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              first: async () => sql.includes("FROM sessions") ? user : null,
              run: async () => {
                writes.push({ sql, values });
                return { success: true };
              },
              all: async () => ({ results: [] }),
            };
          },
          all: async () => ({ results: [] }),
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
