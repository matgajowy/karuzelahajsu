import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { findRoute } from "../src/worker/routes/index.js";
import { handleOpponentPortfolio } from "../src/worker/services/p2.js";

function createPortfolioEnv({ user = null, holdings = [], thesis = null } = {}) {
  const queries = [];
  return {
    queries,
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            queries.push({ sql, values });
            return {
              first: async () => {
                if (sql.includes("SELECT id, github_login")) return user;
                if (sql.includes("FROM transactions")) return thesis;
                return null;
              },
              all: async () => ({ results: holdings }),
            };
          },
        };
      },
    },
  };
}

test("opponent portfolio route is registered", () => {
  assert.equal(typeof findRoute("GET", "/api/opponent-portfolio"), "function");
});

test("opponent portfolio endpoint validates ids and excludes benchmarks", async () => {
  const env = createPortfolioEnv();

  const invalid = await handleOpponentPortfolio({
    env,
    url: new URL("https://example.test/api/opponent-portfolio?user_id=0"),
  });
  assert.equal(invalid.status, 400);
  assert.equal(env.queries.length, 0);

  const missing = await handleOpponentPortfolio({
    env,
    url: new URL("https://example.test/api/opponent-portfolio?user_id=12"),
  });
  assert.equal(missing.status, 404);
  assert.match(env.queries[0].sql, /github_login NOT IN \('benchmark_sp500', 'benchmark_wig20'\)/);
});

test("opponent portfolio endpoint returns holdings, valuation and latest thesis", async () => {
  const user = {
    id: 12,
    github_login: "player",
    display_name: "Test Player",
    avatar_url: null,
    current_cash: 250,
  };
  const holdings = [{
    ticker: "NVDA",
    name: "NVIDIA Corporation",
    shares: 2,
    avg_buy_price: 100,
    current_price: 120,
    currency: "USD",
    current_value_ck: 960,
    return_pct: 20,
  }];
  const thesis = {
    ticker: "NVDA",
    type: "BUY",
    thesis: "Wzrost po dobrych wynikach.",
    created_at: "2026-10-08 12:00:00",
  };
  const env = createPortfolioEnv({ user, holdings, thesis });
  const response = await handleOpponentPortfolio({
    env,
    url: new URL("https://example.test/api/opponent-portfolio?user_id=12"),
  });

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, {
    id: 12,
    display_name: "Test Player",
    avatar_url: null,
    cash_ck: 250,
    stocks_value_ck: 960,
    valuation_ck: 1210,
    holdings,
    last_thesis: thesis,
  });
  assert.ok(env.queries.some(({ sql, values }) =>
    sql.includes("FROM holdings h") && values[0] === 12
  ));
});

test("leaderboard accordion is wired for accessible expansion and portfolio copy", async () => {
  const [events, leaderboard] = await Promise.all([
    readFile(new URL("../public/assets/js/events.js", import.meta.url), "utf8"),
    readFile(new URL("../public/assets/js/leaderboard.js", import.meta.url), "utf8"),
  ]);

  assert.match(events, /"toggle-opponent-accordion": element => toggleOpponentAccordion/);
  assert.match(events, /"copy-accordion-holding": element => window\.karuzela\.copyTrade/);
  assert.match(events, /event\.key === "Enter" \|\| event\.key === " "/);
  assert.match(leaderboard, /\/api\/opponent-portfolio\?user_id=/);
  assert.match(leaderboard, /aria-expanded="false"/);
  assert.match(leaderboard, /Podział portfela/);
  assert.match(leaderboard, /data-action="copy-accordion-holding"/);
  assert.match(leaderboard, /last_thesis/);
  assert.doesNotMatch(leaderboard, /derbyTrack|marketRecap|ai_roast|Roast Master/);
});
