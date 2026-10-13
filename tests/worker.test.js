import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import worker from "../src/worker/index.js";
import { allowedMethods, findRoute } from "../src/worker/routes/index.js";
import { syncAllMarketPrices } from "../src/worker/services/pricing.js";
import { handleOpponentPortfolio } from "../src/worker/services/p2.js";
import { generateText } from "../src/worker/services/ai.js";
import { sendEmailToSlack, sendEveningRecap, sendMorningBriefing } from "../src/worker/services/slackBriefing.js";

function createEnv({
  user = null,
  assets = null,
  rows = [],
  metadata = {},
  devAuthBypass = false,
  devAuthLogin = "demo_marta",
  demoUser = null,
  ai = null,
} = {}) {
  const writes = [];
  const env = {
    writes,
    ASSETS: assets,
    DEV_AUTH_BYPASS: devAuthBypass ? "true" : undefined,
    DEV_AUTH_LOGIN: devAuthBypass ? devAuthLogin : undefined,
    AI: ai,
    DB: {
      prepare(sql) {
        return {
          first: async () => {
            if (sql.includes("FROM sessions")) return user;
            if (sql.includes("FROM users") && sql.includes("github_login = ?")) {
              return demoUser?.github_login === devAuthLogin ? demoUser : null;
            }
            const metadataKey = sql.match(/key = '([^']+)'/)?.[1];
            return metadataKey ? metadata[metadataKey] || null : null;
          },
          bind(...values) {
            return {
              first: async () => {
                if (sql.includes("FROM sessions")) return user;
                if (sql.includes("FROM users") && sql.includes("github_login = ?")) {
                  return demoUser?.github_login === values[0] ? demoUser : null;
                }
                const metadataKey = sql.match(/key = '([^']+)'/)?.[1];
                return metadataKey ? metadata[metadataKey] || null : null;
              },
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
    ["GET", "/api/opponent-portfolio"],
    ["POST", "/api/profile"],
    ["POST", "/api/profile/generate-nickname"],
    ["GET", "/api/admin/users"],
    ["POST", "/api/admin/users"],
    ["GET", "/api/instruments/search"],
    ["POST", "/api/trade"],
    ["POST", "/api/logout"],
    ["GET", "/api/admin/audit"],
    ["GET", "/api/admin/sync-prices"],
    ["POST", "/api/admin/reset-benchmarks"],
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
  assert.match(html, /id="tradeAvailableCash"/);
  assert.match(html, /id="tradeModal" class="fixed inset-0 bg-black\/60 z-50/);
  assert.doesNotMatch(html, /id="tradeModal"[^>]*backdrop-blur/);
  const resetDialogIndex = html.indexOf('id="benchmarkResetModal"');
  const tradeModalIndex = html.indexOf('id="tradeModal"');
  const tradeFormEndIndex = html.indexOf("</form>", tradeModalIndex);
  const footerIndex = html.indexOf("<!-- STOPKA");
  assert.ok(resetDialogIndex > tradeFormEndIndex);
  assert.ok(resetDialogIndex < footerIndex);
  assert.match(html, /RESET-BENCHMARKS/);
  assert.match(html, /id="portfolioTotalValue"/);
  assert.match(html, /id="tradeAmount"/);
  assert.match(html, /id="tradeAmountRemainder"/);
  assert.match(html, /data-action="set-sell-share-percentage" data-percent="0\.25"/);
  assert.match(html, /data-action="set-sell-share-percentage" data-percent="0\.50"/);
  assert.match(html, /data-action="set-sell-share-percentage" data-percent="1"/);
  assert.match(html, /MAX \(pełne akcje\)/);
  assert.match(html, /href="\/favicon\.svg"/);
  assert.match(html, /id="generateNickBtn"/);
  assert.doesNotMatch(html, /derbyTrack|derby\.js|Memiczny Tor Wyścigowy/);
  assert.doesNotMatch(html, /dailyRecapBanner|marketRecapContent|marketRaceChart|opponentPortfolioDrawer/);
  assert.doesNotMatch(html, /chart\.umd\.min\.js/);
});

test("accordion portfolio remains wired and transaction feed has no roast", async () => {
  const events = await readFile(new URL("../public/assets/js/events.js", import.meta.url), "utf8");
  const leaderboard = await readFile(new URL("../public/assets/js/leaderboard.js", import.meta.url), "utf8");
  const portfolio = await readFile(new URL("../public/assets/js/portfolio.js", import.meta.url), "utf8");
  const feedRoute = await readFile(new URL("../src/worker/routes/feed.js", import.meta.url), "utf8");
  const tradeRoute = await readFile(new URL("../src/worker/routes/trades.js", import.meta.url), "utf8");

  assert.match(events, /"toggle-opponent-accordion": element => toggleOpponentAccordion/);
  assert.match(events, /"copy-accordion-holding": element => window\.karuzela\.copyTrade/);
  assert.match(leaderboard, /\/api\/opponent-portfolio\?user_id=/);
  assert.match(leaderboard, /last_thesis/);
  assert.match(leaderboard, /data-action="copy-accordion-holding"/);
  assert.doesNotMatch(portfolio, /Roast Master|ai_roast/);
  assert.doesNotMatch(feedRoute, /ai_roast/);
  assert.doesNotMatch(tradeRoute, /generateText|ai_roast|Roast Master/);
});

test("opponent portfolio endpoint returns holdings and latest thesis", async () => {
  const opponent = {
    id: 12,
    github_login: "player",
    display_name: "Test Player",
    avatar_url: null,
    current_cash: 250,
  };
  const holding = {
    ticker: "NVDA",
    name: "NVIDIA Corporation",
    shares: 2,
    avg_buy_price: 100,
    current_price: 110,
    currency: "USD",
    current_value_ck: 220,
    return_pct: 10,
  };
  const thesis = { ticker: "NVDA", type: "BUY", thesis: "Dane wskazują na wzrost.", created_at: "2025-01-01" };
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind: (...values) => {
            const statement = {
              first: async () => {
                if (sql.includes("SELECT id, github_login")) return values[0] === 12 ? opponent : null;
                if (sql.includes("FROM transactions")) return thesis;
                return null;
              },
              all: async () => ({ results: sql.includes("FROM holdings h") ? [holding] : [] }),
            };
            return statement;
          },
        };
      },
    },
  };

  const opponentResponse = await handleOpponentPortfolio({
    env,
    url: new URL("https://example.test/api/opponent-portfolio?user_id=12"),
  });
  assert.equal(opponentResponse.status, 200);
  assert.deepEqual((await opponentResponse.json()).data, {
    id: 12,
    display_name: "Test Player",
    avatar_url: null,
    cash_ck: 250,
    stocks_value_ck: 220,
    valuation_ck: 470,
    holdings: [holding],
    last_thesis: thesis,
  });
});

test("Gemini text generation sends the configured prompt and returns generated text", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl;
  let requestBody;
  globalThis.fetch = async (url, options) => {
    requestUrl = new URL(url);
    requestBody = JSON.parse(options.body);
    return Response.json({
      candidates: [{ content: { parts: [{ text: "  Roast giełdowy.  " }] } }],
    });
  };
  try {
    const text = await generateText(
      { GEMINI_API_KEY: "test-key" },
      "System po polsku",
      "Prompt użytkownika",
      "Fallback"
    );
    assert.equal(text, "Roast giełdowy.");
    assert.equal(requestUrl.pathname, "/v1beta/models/gemini-2.5-flash:generateContent");
    assert.equal(requestUrl.searchParams.get("key"), "test-key");
    assert.deepEqual(requestBody.systemInstruction, { parts: [{ text: "System po polsku" }] });
    assert.deepEqual(requestBody.contents, [{ parts: [{ text: "Prompt użytkownika" }] }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini text generation returns the supplied fallback when the API key is missing", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    assert.equal(await generateText({}, "System", "Prompt", "Fallback testowy"), "Fallback testowy");
  } finally {
    console.error = originalConsoleError;
  }
});

test("Resend sends the briefing email to the configured Slack channel address", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl;
  let requestHeaders;
  let requestBody;
  globalThis.fetch = async (url, options) => {
    requestUrl = String(url);
    requestHeaders = options.headers;
    requestBody = JSON.parse(options.body);
    return Response.json({ id: "email-test" });
  };
  try {
    const result = await sendEmailToSlack({
      RESEND_API_KEY: "resend-test",
      SLACK_CHANNEL_EMAIL: "channel@example.test",
    }, "Subject test", "<p>Briefing</p>");
    assert.equal(requestUrl, "https://api.resend.com/emails");
    assert.equal(requestHeaders.Authorization, "Bearer resend-test");
    assert.deepEqual(requestBody, {
      from: "Biurowy Makler <onboarding@resend.dev>",
      to: ["channel@example.test"],
      subject: "Subject test",
      html: "<p>Briefing</p>",
    });
    assert.equal(result.id, "email-test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("morning briefing composes market data and sends the fixed Slack subject", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const endpoint = String(url);
    requests.push({ endpoint, options });
    if (endpoint.includes("generativelanguage.googleapis.com")) {
      return Response.json({
        candidates: [{ content: { parts: [{ text: "Kawa gotowa. Rynek jeszcze w szlafroku." }] } }],
      });
    }
    return Response.json({ id: "morning-test" });
  };
  const env = {
    GEMINI_API_KEY: "gemini-test",
    RESEND_API_KEY: "resend-test",
    SLACK_CHANNEL_EMAIL: "briefings@example.test",
    DB: {
      prepare(sql) {
        return {
          first: async () => {
            if (sql.includes("fx_to_pln")) return { fx_to_pln: 4.02 };
            return { user_name: "Test User", ticker: "NVDA", type: "BUY", thesis: "Teza <w nawiasach>" };
          },
          all: async () => ({
            results: [
              { ticker: "^GSPC", name: "S&P 500", price: 5200, currency: "USD" },
              { ticker: "WIG20", name: "WIG20", price: 2800, currency: "PLN" },
            ],
          }),
        };
      },
    },
  };
  try {
    const result = await sendMorningBriefing(env);
    assert.equal(result.id, "morning-test");
    assert.equal(requests.length, 2);
    const geminiPrompt = JSON.parse(requests[0].options.body).contents[0].parts[0].text;
    assert.match(geminiPrompt, /USD\/CK: 4,0200/);
    assert.match(geminiPrompt, /Teza <w nawiasach>/);
    const email = JSON.parse(requests[1].options.body);
    assert.equal(email.subject, "☕ PORANNY BIULETYN: Kawa & Krew [08:30]");
    assert.match(email.html, /Kawa gotowa/);
    assert.match(email.html, /Teza &lt;w nawiasach&gt;/);
    assert.doesNotMatch(email.html, /Teza <w nawiasach>/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evening recap includes league standings and today's transaction count", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const endpoint = String(url);
    requests.push({ endpoint, options });
    if (endpoint.includes("generativelanguage.googleapis.com")) {
      return Response.json({
        candidates: [{ content: { parts: [{ text: "Dzwonek wybrzmiał." }] } }],
      });
    }
    return Response.json({ id: "evening-test" });
  };
  const env = {
    GEMINI_API_KEY: "gemini-test",
    RESEND_API_KEY: "resend-test",
    SLACK_CHANNEL_EMAIL: "briefings@example.test",
    DB: {
      prepare(sql) {
        return {
          all: async () => ({
            results: [
              { id: 1, github_login: "winner", display_name: "Lider", valuation_ck: 120000 },
              { id: 2, github_login: "bottom", display_name: "Ostatni", valuation_ck: 90000 },
              { id: 3, github_login: "benchmark_sp500", display_name: "S&P 500", valuation_ck: 110000 },
              { id: 4, github_login: "benchmark_wig20", display_name: "WIG20", valuation_ck: 105000 },
            ],
          }),
          first: async () => sql.includes("COUNT(*)") ? { count: 7 } : null,
        };
      },
    },
  };
  try {
    const result = await sendEveningRecap(env);
    assert.equal(result.id, "evening-test");
    const prompt = JSON.parse(requests[0].options.body).contents[0].parts[0].text;
    assert.match(prompt, /Lider: Lider/);
    assert.match(prompt, /Dół tabeli: Ostatni/);
    assert.match(prompt, /transakcji: 7/);
    assert.match(prompt, /S&P 500/);
    assert.match(JSON.parse(requests[1].options.body).subject, /Dzwonek & Zgliszcza \[17:30\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("morning cron dispatches the briefing without running the price sync", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const endpoint = String(url);
    requests.push(endpoint);
    if (endpoint.includes("generativelanguage.googleapis.com")) {
      return Response.json({
        candidates: [{ content: { parts: [{ text: "Poranek na giełdzie." }] } }],
      });
    }
    return Response.json({ id: "scheduled-briefing" });
  };
  const env = {
    GEMINI_API_KEY: "gemini-test",
    RESEND_API_KEY: "resend-test",
    SLACK_CHANNEL_EMAIL: "briefings@example.test",
    DB: {
      prepare(sql) {
        return {
          first: async () => sql.includes("fx_to_pln") ? { fx_to_pln: 4 } : null,
          all: async () => ({ results: [] }),
        };
      },
    },
  };
  const promises = [];
  try {
    await worker.scheduled({ cron: "30 6 * * 1-5" }, env, {
      waitUntil: promise => promises.push(promise),
    });
    await Promise.all(promises);
    assert.deepEqual(requests, [
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=gemini-test",
      "https://api.resend.com/emails",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CK formatter provides safe text and visual token formats", async () => {
  const source = await readFile(new URL("../public/assets/js/utils.js", import.meta.url), "utf8");
  const result = runInNewContext(`${source}\nJSON.stringify({ visual: formatCK(12345.67), large: formatCK(12345.67, true, true), next: formatCK(10), text: formatCK(12345.67, false), invalid: formatCK(Infinity, false) })`);
  const formatted = JSON.parse(result);

  assert.equal(formatted.text, "12 345,67 CK");
  assert.equal(formatted.invalid, "0,00 CK");
  assert.match(formatted.visual, /class="ck-coin"/);
  assert.match(formatted.visual, /<text[^>]*>CK<\/text>/);
  assert.match(formatted.visual, /12 345,67/);
  assert.doesNotMatch(formatted.visual, /ck-badge|ck-ticker/);
  assert.match(formatted.large, /class="ck-coin ck-coin-lg"/);
  assert.match(formatted.visual, /id="coinGold1"/);
  assert.match(formatted.next, /id="coinGold3"/);
  assert.match(formatted.next, /fill="url\(#coinGold3\)"/);
  assert.match(formatted.visual, /<feDropShadow[^>]*\/>/);
  assert.doesNotMatch(formatted.visual, /<\/feDropShadow>/);
});

test("percent and CK formatters neutralize rounded values near zero", async () => {
  const source = await readFile(new URL("../public/assets/js/utils.js", import.meta.url), "utf8");
  const result = runInNewContext(`${source}
    JSON.stringify({
      zeroPositive: formatPct(0.00004),
      zeroNegative: formatPct(-0.00004),
      positive: formatPct(0.00006),
      zeroColor: pctColorClass(0.00004),
      negativeColor: pctColorClass(-0.00006),
      negativeCent: formatCK(-0.004, false),
    })`);
  const formatted = JSON.parse(result);

  assert.equal(formatted.zeroPositive, "0.00%");
  assert.equal(formatted.zeroNegative, "0.00%");
  assert.equal(formatted.positive, "+0.01%");
  assert.equal(formatted.zeroColor, "text-slate-400");
  assert.equal(formatted.negativeColor, "text-rose-400");
  assert.equal(formatted.negativeCent, "0,00 CK");
});

test("benchmark rows do not consume live player ranks or medals", async () => {
  const source = await readFile(new URL("../public/assets/js/leaderboard.js", import.meta.url), "utf8");
  assert.match(source, /rankBadge = `<span class="text-slate-500 font-mono text-xs" title="Benchmark">-<\/span>`;/);
  assert.match(source, /let livePlayerRank = 0/);
  assert.match(source, /if \(!isBench\) livePlayerRank \+= 1/);
  assert.match(source, /role="img" aria-label="\$\{isSpFlag \? 'USA' : 'Polska'\}" class="w-7 h-7 rounded-full/);
});

test("time formatter returns local time and handles missing timestamps", async () => {
  const source = await readFile(new URL("../public/assets/js/utils.js", import.meta.url), "utf8");
  const result = runInNewContext(`${source}
    JSON.stringify({
      missing: formatTime(null),
      utc: formatTime("2026-10-08T08:30:00Z"),
      database: formatTime("2026-10-08 08:30:00"),
    })`);
  const formatted = JSON.parse(result);

  assert.equal(formatted.missing, "--:--");
  assert.equal(formatted.utc, formatted.database);
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

test("dev auth bypass authenticates as the configured demo user without a cookie", async () => {
  const demoUser = {
    id: 17,
    github_login: "demo_marta",
    display_name: "Marta Demo",
    avatar_url: null,
    current_cash: 45500,
    is_admin: 0,
  };
  const env = createEnv({ devAuthBypass: true, demoUser });

  const sessionResponse = await worker.fetch(
    new Request("https://dev.example/api/me"),
    env,
    {},
  );
  const session = await sessionResponse.json();

  assert.equal(session.authenticated, true);
  assert.equal(session.auth_mode, "dev-bypass");
  assert.equal(session.user.github_login, "demo_marta");
  assert.equal(session.user.is_admin, 0);

  const portfolioResponse = await worker.fetch(
    new Request("https://dev.example/api/portfolio"),
    env,
    {},
  );
  assert.equal(portfolioResponse.status, 200);
  assert.equal((await portfolioResponse.json()).cash_ck, 45500);

  const adminResponse = await worker.fetch(
    new Request("https://dev.example/api/admin/users"),
    env,
    {},
  );
  assert.equal(adminResponse.status, 403);
});

test("auth bypass is disabled unless its explicit environment flag is enabled", async () => {
  const env = createEnv({ devAuthLogin: "demo_marta" });
  const response = await worker.fetch(
    new Request("https://prod.example/api/me"),
    env,
    {},
  );

  assert.deepEqual(await response.json(), { authenticated: false });
});

test("dev auth bypass fails clearly when its configured demo account is missing", async () => {
  const env = createEnv({ devAuthBypass: true, demoUser: null });
  const response = await worker.fetch(
    new Request("https://dev.example/api/me"),
    env,
    {},
  );

  assert.deepEqual(await response.json(), { authenticated: false });
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

test("nickname generator requires an authenticated user", async () => {
  const response = await worker.fetch(
    new Request("https://dev.example/api/profile/generate-nickname", { method: "POST" }),
    createEnv(),
    {},
  );

  assert.equal(response.status, 401);
});

test("nickname generator uses Workers AI and returns a validated nickname", async () => {
  let model;
  const env = createEnv({
    user: { id: 7, is_admin: 0 },
    ai: {
      async run(modelName, input) {
        model = { modelName, input };
        return { response: "\"Rekin z Parkietu.\"" };
      },
    },
  });
  const response = await worker.fetch(
    new Request("https://dev.example/api/profile/generate-nickname", {
      method: "POST",
      headers: { Cookie: "session_token=test-session" },
    }),
    env,
    {},
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "success");
  assert.equal(body.data.nickname, "Rekin z Parkietu");
  assert.equal(body.data.fallback, false);
  assert.equal(model.modelName, "@cf/meta/llama-3.1-8b-instruct-fp8");
  assert.match(model.input.messages[0].content, /dokładnie JEDNĄ/);
});

test("nickname generator falls back if Workers AI throws", async () => {
  const env = createEnv({
    user: { id: 7, is_admin: 0 },
    ai: { run: async () => { throw new Error("AI unavailable"); } },
  });
  const response = await worker.fetch(
    new Request("https://dev.example/api/profile/generate-nickname", {
      method: "POST",
      headers: { Cookie: "session_token=test-session" },
    }),
    env,
    {},
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "success");
  assert.equal(body.data.fallback, true);
  assert.match(body.data.nickname, /^[\p{L}\p{M}\p{N}'’-]+(?: [\p{L}\p{M}\p{N}'’-]+){1,2}$/u);
});

test("feed query includes company names from market prices", async () => {
  const feedRow = {
    ticker: "NVDA",
    company_name: "NVIDIA Corp",
    user_name: "Player",
  };
  const env = createEnv({ rows: [feedRow] });
  const response = await worker.fetch(
    new Request("https://dev.example/api/feed"),
    env,
    {},
  );
  const body = await response.json();
  const feedSource = await readFile(new URL("../src/worker/routes/feed.js", import.meta.url), "utf8");
  const portfolioSource = await readFile(new URL("../public/assets/js/portfolio.js", import.meta.url), "utf8");
  const eventsSource = await readFile(new URL("../public/assets/js/events.js", import.meta.url), "utf8");

  assert.equal(body.data[0].company_name, "NVIDIA Corp");
  assert.match(feedSource, /LEFT JOIN market_prices p ON t\.ticker = p\.ticker/);
  assert.match(feedSource, /COALESCE\(p\.name, t\.ticker\) AS company_name/);
  assert.match(feedSource, /t\.total_value_pln AS total_value_ck/);
  assert.match(portfolioSource, /data-action="copy-feed-trade"/);
  assert.match(portfolioSource, /const canCopy = isBuy && !isBenchmark\(item\.user_name\) && !isBenchmarkTicker/);
  assert.match(portfolioSource, /group-hover:opacity-100/);
  assert.match(portfolioSource, /opacity-100 md:opacity-0/);
  assert.match(portfolioSource, /item\.total_value_ck \?\? item\.total_value_pln/);
  assert.match(eventsSource, /window\.karuzela\.copyTrade/);

  const renderedFeed = { innerHTML: "" };
  const utilsSource = await readFile(new URL("../public/assets/js/utils.js", import.meta.url), "utf8");
  const timeHelpers = utilsSource.slice(utilsSource.indexOf("const FEED_TIME_ZONE"));
  const rendered = await runInNewContext(
    `${timeHelpers}\n${portfolioSource}; fetchFeed().then(() => document.getElementById("feedContainer").innerHTML);`,
    {
      apiRequest: async () => ({
        status: "success",
        data: [
          { type: "BUY", ticker: "NVDA", user_name: "Trader", shares: 1, company_name: "NVIDIA", created_at: "2026-10-08T10:00:00Z" },
          { type: "SELL", ticker: "NVDA", user_name: "Trader", shares: 1, company_name: "NVIDIA", created_at: "2026-10-08T10:00:00Z" },
          { type: "BUY", ticker: "^GSPC", user_name: "Market Benchmark S&P 500", shares: 1, company_name: "S&P 500", created_at: "2026-10-08T10:00:00Z" },
          { type: "BUY", ticker: "WIG20", user_name: "Market Index", shares: 1, company_name: "WIG20", created_at: "2026-10-08T10:00:00Z" },
        ],
      }),
      document: { getElementById: () => renderedFeed },
      escapeHtml: value => String(value ?? ""),
      formatCK: value => String(value ?? 0),
      isBenchmark: name => /benchmark|index|s&p|wig/i.test(String(name ?? "")),
      formatQuotePrice: String,
      currentUser: null,
      userHoldings: [],
      console,
    },
  );
  assert.equal((rendered.match(/data-action="copy-feed-trade"/g) || []).length, 1);
  assert.match(rendered, /⚡<\/span>\s*<span>Kopiuj<\/span>/);
  assert.match(rendered, /md:pointer-events-none/);
});

test("copying a feed trade opens and prepares a BUY order", async () => {
  const focused = [];
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: "",
        innerHTML: "",
        innerText: "",
        disabled: false,
        className: "",
        classList: { add() {}, remove() {} },
        focus: () => focused.push(id),
      });
    }
    return elements.get(id);
  };
  const tickerInput = getElement("tradeTickerInput");
  const thesisInput = getElement("tradeThesis");
  const source = await readFile(new URL("../public/assets/js/trading.js", import.meta.url), "utf8");
  const context = {
    currentUser: { id: 1 },
    currentTradeType: "BUY",
    verifiedInstrument: null,
    selectedHoldingMaxShares: 0,
    window: {},
    location: { href: "" },
    document: { getElementById: getElement },
    userHoldings: [],
    formatCK: value => `${Number(value).toFixed(2)} CK`,
    formatQuotePrice: value => String(value),
    apiRequest: async path => {
      assert.equal(path, "/api/instruments/search?q=NVDA");
      return {
        status: "success",
        data: { ticker: "NVDA", name: "NVIDIA Corp", price: 45, price_ck: 45, currency: "USD" },
      };
    },
  };

  await runInNewContext(`${source}; window.karuzela.copyTrade("NVDA", "Piotr Wiśniewski");`, context);

  assert.equal(getElement("tradeTickerInput").value, "NVDA");
  assert.equal(getElement("tradeModal").classList.hidden, undefined);
  assert.equal(thesisInput.value, "Kopiuję ruch od @Piotr Wiśniewski! Też w to wchodzę.");
  assert.deepEqual(focused, ["tradeShares"]);
  assert.equal(getElement("verifiedInstrumentCard").classList.hidden, undefined);
  assert.equal(typeof context.window.karuzela.copyTrade, "function");
});

test("trade amount input buys whole shares and shows the remaining budget", async () => {
  const elements = {
    tradeShares: { value: "" },
    tradeAmount: { value: "50" },
    tradeAmountRemainder: {
      innerText: "",
      classList: {
        hidden: true,
        add() { this.hidden = true; },
        remove() { this.hidden = false; },
      },
    },
    estimatedCost: { innerHTML: "" },
    submitTradeBtn: { disabled: false },
  };
  const source = await readFile(new URL("../public/assets/js/trading.js", import.meta.url), "utf8");
  const result = runInNewContext(`${source}
    currentTradeType = "BUY";
    verifiedInstrument = { price_ck: 45 };
    syncTradeInput("amount");
    const budgetResult = {
      shares: document.getElementById("tradeShares").value,
      amount: document.getElementById("tradeAmount").value,
      remainder: document.getElementById("tradeAmountRemainder").innerText,
      visible: !document.getElementById("tradeAmountRemainder").classList.hidden,
      submitDisabled: document.getElementById("submitTradeBtn").disabled,
    };
    document.getElementById("tradeShares").value = "1.5";
    syncTradeInput("shares");
    budgetResult.fractionalSharesDisabled = document.getElementById("submitTradeBtn").disabled;
    budgetResult.fractionalSharesMessage = document.getElementById("tradeAmountRemainder").innerText;
    JSON.stringify(budgetResult);`, {
    document: { getElementById: id => elements[id] },
    currentTradeType: "BUY",
    verifiedInstrument: { price_ck: 30 },
    currentUser: null,
    userHoldings: [],
    formatCK: value => `${Number(value).toFixed(2)} CK`,
    escapeHtml: value => value,
    formatQuotePrice: value => String(value),
    apiRequest: async () => ({}),
    location: { href: "" },
    alert() {},
  });
  const resultData = JSON.parse(result);

  assert.equal(resultData.shares, "1");
  assert.equal(resultData.amount, "50");
  assert.equal(resultData.remainder, "Kupujesz: 1 szt. • Koszt: 45.00 CK • Niewykorzystana reszta: 5.00 CK");
  assert.equal(resultData.visible, true);
  assert.equal(resultData.submitDisabled, false);
  assert.equal(resultData.fractionalSharesDisabled, true);
  assert.equal(resultData.fractionalSharesMessage, "Zakup dostępny wyłącznie w pełnych akcjach.");
});

test("trade amount below the share price cannot be submitted", async () => {
  const elements = {
    tradeShares: { value: "" },
    tradeAmount: { value: "44" },
    tradeAmountRemainder: {
      innerText: "",
      classList: {
        hidden: true,
        add() { this.hidden = true; },
        remove() { this.hidden = false; },
      },
    },
    estimatedCost: { innerHTML: "" },
    submitTradeBtn: { disabled: false },
  };
  const source = await readFile(new URL("../public/assets/js/trading.js", import.meta.url), "utf8");
  const result = runInNewContext(`${source}
    currentTradeType = "BUY";
    verifiedInstrument = { price_ck: 45 };
    syncTradeInput("amount");
    JSON.stringify({
      shares: document.getElementById("tradeShares").value,
      remainder: document.getElementById("tradeAmountRemainder").innerText,
      submitDisabled: document.getElementById("submitTradeBtn").disabled,
    });`, {
    document: { getElementById: id => elements[id] },
    currentTradeType: "BUY",
    verifiedInstrument: { price_ck: 45 },
    currentUser: null,
    userHoldings: [],
    formatCK: value => `${Number(value).toFixed(2)} CK`,
    escapeHtml: value => value,
    formatQuotePrice: value => String(value),
    apiRequest: async () => ({}),
    location: { href: "" },
    alert() {},
  });
  const resultData = JSON.parse(result);

  assert.equal(resultData.shares, "");
  assert.equal(resultData.remainder, "Kupujesz: 0 szt. • Koszt: 0.00 CK • Niewykorzystana reszta: 44.00 CK");
  assert.equal(resultData.submitDisabled, true);
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

test("benchmark reset endpoint rejects non-admin sessions", async () => {
  const response = await worker.fetch(
    new Request("https://dev.example/api/admin/reset-benchmarks", {
      method: "POST",
      headers: { Cookie: "session_token=player-session", "Content-Type": "application/json" },
      body: JSON.stringify({ confirmPhrase: "RESET-BENCHMARKS" }),
    }),
    createEnv({ user: { id: 9, is_admin: 0 } }),
    {},
  );

  assert.equal(response.status, 403);
});

test("benchmark reset requires the explicit confirmation phrase", async () => {
  const response = await worker.fetch(
    new Request("https://dev.example/api/admin/reset-benchmarks", {
      method: "POST",
      headers: { Cookie: "session_token=admin-session", "Content-Type": "application/json" },
      body: JSON.stringify({ confirmPhrase: "reset-benchmarks" }),
    }),
    createEnv({ user: { id: 3, is_admin: 1 } }),
    {},
  );

  assert.equal(response.status, 400);
});

test("admin benchmark reset uses one atomic batch and writes an audit record", async () => {
  const batches = [];
  const benchmarks = [
    { id: 20, github_login: "benchmark_sp500", price: 5000, fx_to_pln: 4 },
    { id: 21, github_login: "benchmark_wig20", price: 2500, fx_to_pln: 1 },
  ];
  const env = {
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
            return sql.includes("FROM sessions") ? { id: 3, is_admin: 1 } : null;
          },
          async all() {
            if (sql.includes("FROM users u") && sql.includes("market_prices")) {
              return { results: benchmarks };
            }
            return { results: [] };
          },
        };
        return statement;
      },
      async batch(statements) {
        batches.push(statements);
        return [];
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://dev.example/api/admin/reset-benchmarks", {
      method: "POST",
      headers: {
        Cookie: "session_token=admin-session",
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.7",
      },
      body: JSON.stringify({ confirmPhrase: "RESET-BENCHMARKS" }),
    }),
    env,
    {},
  );

  assert.equal(response.status, 200);
  assert.equal(batches.length, 1);
  const batch = batches[0];
  assert.equal(batch.length, 5);
  assert.match(batch[0].sql, /UPDATE users SET current_cash = 0\.0/);
  assert.match(batch[1].sql, /DELETE FROM holdings/);
  assert.deepEqual(batch[2].values, ["^GSPC", "^GSPC", "benchmark_sp500"]);
  assert.deepEqual(batch[3].values, ["WIG20", "WIG20", "benchmark_wig20"]);
  assert.match(batch[2].sql, /100000\.0 \/ \(p\.price \* p\.fx_to_pln\)/);
  assert.match(batch[4].sql, /ADMIN_RESET_BENCHMARKS/);
  assert.deepEqual(batch[4].values, [
    3,
    JSON.stringify({
      benchmarks: [
        { login: "benchmark_sp500", ticker: "^GSPC", starting_value_ck: 100000 },
        { login: "benchmark_wig20", ticker: "WIG20", starting_value_ck: 100000 },
      ],
    }),
    "203.0.113.7",
  ]);
});

test("benchmark reset refreshes snapshots for active production periods", async () => {
  const batches = [];
  const env = {
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
            return sql.includes("FROM sessions") ? { id: 3, is_admin: 1 } : null;
          },
          async all() {
            if (sql.includes("FROM users u") && sql.includes("market_prices")) {
              return {
                results: [
                  { id: 20, github_login: "benchmark_sp500", price: 5000, fx_to_pln: 4 },
                  { id: 21, github_login: "benchmark_wig20", price: 2500, fx_to_pln: 1 },
                ],
              };
            }
            if (sql.includes("sqlite_master") && sql.includes("period_snapshots")) {
              return { results: [{ name: "period_snapshots" }] };
            }
            if (sql.includes("PRAGMA table_info(period_snapshots)")) {
              return {
                results: [
                  { name: "period_id" },
                  { name: "user_id" },
                  { name: "start_valuation_pln" },
                ],
              };
            }
            if (sql.includes("sqlite_master") && this.values[0] === "periods") {
              return { results: [{ name: "periods" }] };
            }
            if (sql.includes('PRAGMA table_info("periods")')) {
              return { results: [{ name: "id" }, { name: "status" }] };
            }
            return { results: [] };
          },
        };
        return statement;
      },
      async batch(statements) {
        batches.push(statements);
        return [];
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://dev.example/api/admin/reset-benchmarks", {
      method: "POST",
      headers: { Cookie: "session_token=admin-session", "Content-Type": "application/json" },
      body: JSON.stringify({ confirmPhrase: "RESET-BENCHMARKS" }),
    }),
    env,
    {},
  );

  assert.equal(response.status, 200);
  const snapshotUpdate = batches[0].find(({ sql }) => sql.includes("UPDATE period_snapshots"));
  assert.ok(snapshotUpdate);
  assert.match(snapshotUpdate.sql, /period_id IN \(SELECT id FROM "periods" WHERE UPPER\(status\) = 'ACTIVE'\)/);
});

test("leaderboard API exposes all portfolio values in CK at the fixed parity", async () => {
  const env = createEnv({
    rows: [{ Wycena_Calkowita_CK: 101000, Gotowka_CK: 1000 }],
    metadata: {
      last_price_sync: { value: "2026-10-08 08:30:00" },
      last_price_sync_status: { value: "partial" },
      last_price_sync_summary: { value: JSON.stringify({ total_count: 3, updated_count: 2, failed_count: 1, failed_tickers: ["WIG20"], errors: [] }) },
    },
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
  assert.equal(body.sync_status, "partial");
  assert.deepEqual(body.sync_summary.failed_tickers, ["WIG20"]);
});

function createPricingEnv(tickers) {
  const writes = [];
  const env = {
    writes,
    DB: {
      prepare(sql) {
        return {
          all: async () => ({ results: tickers }),
          bind(...values) {
            return {
              run: async () => {
                writes.push({ sql, values });
                return { success: true };
              },
            };
          },
        };
      },
    },
  };
  return env;
}

function yahooChartResponse(symbol, price, currency = "USD") {
  return {
    ok: true,
    json: async () => ({
      chart: {
        result: [{
          meta: { symbol, shortName: symbol, regularMarketPrice: price, currency },
        }],
      },
    }),
  };
}

function yahooSparkResponse(quotes) {
  return {
    ok: true,
    json: async () => ({
      spark: {
        result: quotes.map(quote => ({
          symbol: quote.symbol,
          response: [{ meta: quote }],
        })),
      },
    }),
  };
}

test("price sync refreshes legacy WIG20 from WIG20.WA and reports missed quotes", async () => {
  const env = createPricingEnv([
    { ticker: "WIG20", currency: "PLN" },
    { ticker: "WIG20.WA", currency: "PLN" },
    { ticker: "AAPL", currency: "USD" },
  ]);
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const requestUrl = new URL(url);
    requests.push(requestUrl);
    if (requestUrl.pathname.endsWith("/v8/finance/chart/PLN%3DX")) {
      return yahooChartResponse("PLN=X", 4, "PLN");
    }
    if (requestUrl.pathname.endsWith("/v8/finance/chart/PLN=X")) {
      return yahooChartResponse("PLN=X", 4, "PLN");
    }
    if (requestUrl.pathname === "/v7/finance/spark") {
      return yahooSparkResponse([
        { symbol: "WIG20.WA", shortName: "WIG20", regularMarketPrice: 4200, currency: "PLN" },
      ]);
    }
    return { ok: false, status: 429 };
  };

  try {
    const result = await syncAllMarketPrices(env);
    const priceUpdates = env.writes.filter(({ sql }) => sql.includes("UPDATE market_prices"));
    const statusWrite = env.writes.find(({ sql, values }) =>
      sql.includes("INSERT INTO app_metadata") && values[0] === "last_price_sync_status"
    );
    const summaryWrite = env.writes.find(({ sql, values }) =>
      sql.includes("INSERT INTO app_metadata") && values[0] === "last_price_sync_summary"
    );

    assert.equal(result.status, "partial");
    assert.equal(result.summary.total_count, 3);
    assert.equal(result.summary.updated_count, 2);
    assert.deepEqual(result.summary.failed_tickers, ["AAPL"]);
    assert.equal(priceUpdates.length, 2);
    assert.deepEqual(priceUpdates.map(({ values }) => values), [
      [4200, 1, "WIG20"],
      [4200, 1, "WIG20.WA"],
    ]);
    assert.equal(requests.length, 2);
    const batchUrl = requests.find(requestUrl => requestUrl.pathname === "/v7/finance/spark");
    assert.equal(batchUrl.searchParams.get("symbols"), "WIG20.WA,AAPL");
    assert.equal(batchUrl.searchParams.get("range"), "1d");
    assert.equal(batchUrl.searchParams.get("interval"), "1d");
    assert.equal(requests.filter(requestUrl => requestUrl.pathname.startsWith("/v8/finance/chart/")).length, 1);
    assert.equal(statusWrite.values[1], "partial");
    assert.deepEqual(JSON.parse(summaryWrite.values[1]), result.summary);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("price sync splits more than 20 tickers into Yahoo Spark batches", async () => {
  const tickers = Array.from({ length: 45 }, (_, index) => ({
    ticker: `TICKER${index}`,
    currency: "PLN",
  }));
  const env = createPricingEnv(tickers);
  const batchSizes = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const requestUrl = new URL(url);
    if (requestUrl.pathname.startsWith("/v8/finance/chart/")) {
      return yahooChartResponse("PLN=X", 4, "PLN");
    }
    assert.equal(requestUrl.pathname, "/v7/finance/spark");
    const requestedSymbols = requestUrl.searchParams.get("symbols").split(",");
    batchSizes.push(requestedSymbols.length);
    return yahooSparkResponse(requestedSymbols.map(symbol => ({
      symbol,
      shortName: symbol,
      regularMarketPrice: 100,
      currency: "PLN",
    })));
  };

  try {
    const result = await syncAllMarketPrices(env);
    assert.equal(result.status, "success");
    assert.equal(result.summary.updated_count, 45);
    assert.deepEqual(batchSizes, [20, 20, 5]);
    assert.ok(batchSizes.every(size => size <= 20));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("price sync does not update USD quotes when the conversion rate is unavailable", async () => {
  const env = createPricingEnv([{ ticker: "AAPL", currency: "USD" }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const requestUrl = new URL(url);
    if (requestUrl.pathname.startsWith("/v8/finance/chart/")) return { ok: false, status: 503 };
    return yahooSparkResponse([
      { symbol: "AAPL", shortName: "Apple", regularMarketPrice: 200, currency: "USD" },
    ]);
  };

  try {
    const result = await syncAllMarketPrices(env);
    assert.equal(result.status, "failed");
    assert.equal(result.summary.updated_count, 0);
    assert.deepEqual(result.summary.failed_tickers, ["AAPL"]);
    assert.deepEqual(result.summary.errors, ["Nie udało się pobrać kursu USD/CK."]);
    assert.equal(env.writes.some(({ sql }) => sql.includes("UPDATE market_prices")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

// Wednesday 2026-10-07 18:00 in Warsaw: USA ("TEST") session is open.
async function submitTestTrade(env, shares, type = "BUY") {
  const RealDate = Date;
  const fixed = Date.UTC(2026, 9, 7, 16, 0);
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  };
  try {
    return await sendTestTrade(env, shares, type);
  } finally {
    globalThis.Date = RealDate;
  }
}

function sendTestTrade(env, shares, type) {
  return worker.fetch(
    new Request("https://dev.example/api/trade", {
      method: "POST",
      headers: { Cookie: "session_token=test-session", "Content-Type": "application/json" },
      body: JSON.stringify({
        ticker: "TEST",
        type,
        shares,
        thesis: "Kupuję pozycję testową do walidacji.",
      }),
    }),
    env,
    {},
  );
}

async function submitTestBuy(env, shares) {
  return submitTestTrade(env, shares, "BUY");
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
  const env = createTradeEnv(2000);
  const response = await submitTestBuy(env, 1);
  const body = await response.json();
  const audit = env.writes.find(({ sql }) => sql.includes("INSERT INTO audit_log"));

  assert.equal(response.status, 200);
  assert.equal(body.status, "success");
  assert.equal(JSON.parse(audit.values[2]).totalTradeCk, 400);
  assert.ok(env.writes.some(({ sql, values }) =>
    sql.includes("UPDATE users SET current_cash") && values[0] === 400
  ));
});

test("trade API rejects fractional-share buys and sells before writing transactions", async () => {
  for (const type of ["BUY", "SELL"]) {
    const env = createTradeEnv(1000);
    const response = await submitTestTrade(env, 4.447, type);
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.message, `${type === "BUY" ? "Kupować" : "Sprzedawać"} można wyłącznie pełne akcje.`);
    assert.equal(env.writes.length, 0);
  }
});

test("sale percentage presets round down to whole shares", async () => {
  const elements = {
    tradeShares: { value: "" },
    tradeError: {
      innerText: "",
      classList: {
        hidden: true,
        add() { this.hidden = true; },
        remove() { this.hidden = false; },
      },
    },
    estimatedCost: { innerHTML: "" },
    submitTradeBtn: { disabled: true },
  };
  const source = await readFile(new URL("../public/assets/js/trading.js", import.meta.url), "utf8");
  const result = runInNewContext(`${source}
    currentTradeType = "SELL";
    verifiedInstrument = { price_ck: 45 };
    selectedHoldingMaxShares = 10;
    setSellSharePercentage(0.25);
    const quarter = document.getElementById("tradeShares").value;
    setSellSharePercentage(0.5);
    const half = document.getElementById("tradeShares").value;
    selectedHoldingMaxShares = 4.447;
    setSellSharePercentage(1);
    JSON.stringify({
      quarter,
      half,
      max: document.getElementById("tradeShares").value,
      disabled: document.getElementById("submitTradeBtn").disabled,
    });`, {
    document: { getElementById: id => elements[id] },
    currentTradeType: "SELL",
    verifiedInstrument: { price_ck: 45 },
    selectedHoldingMaxShares: 4.447,
    formatCK: value => `${Number(value).toFixed(2)} CK`,
  });

  assert.deepEqual(JSON.parse(result), { quarter: "2", half: "5", max: "4", disabled: false });
});

function createAssetsRecorder() {
  const requested = [];
  return {
    requested,
    fetch: async request => {
      requested.push(new URL(request.url).pathname);
      return new Response(`asset:${new URL(request.url).pathname}`, { status: 200 });
    },
  };
}

test("/v2 and /v2/ serve the new UI document while / keeps the legacy page", async () => {
  const assets = createAssetsRecorder();
  const env = createEnv({ assets });

  for (const path of ["/v2", "/v2/"]) {
    const response = await worker.fetch(new Request(`https://example.com${path}`), env, {});
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "asset:/index-v2");
  }
  const root = await worker.fetch(new Request("https://example.com/"), env, {});
  assert.equal(await root.text(), "asset:/");
  assert.deepEqual(assets.requested, ["/index-v2", "/index-v2", "/"]);
});

test("UI version is selected only by path: no cookie or query switch", async () => {
  const assets = createAssetsRecorder();
  const env = createEnv({ assets });
  const response = await worker.fetch(
    new Request("https://example.com/?ui=v2", { headers: { Cookie: "ui_version=v2" } }),
    env,
    {}
  );
  assert.equal(await response.text(), "asset:/");
  assert.equal(response.headers.get("Set-Cookie"), null);
});

test("/v2 does not swallow API routes or other paths", async () => {
  const assets = createAssetsRecorder();
  const env = createEnv({ assets });
  const api = await worker.fetch(new Request("https://example.com/api/v2/anything"), env, {});
  assert.equal(api.status, 404);
  assert.equal((await api.json()).status, "error");
  await worker.fetch(new Request("https://example.com/v2/other"), env, {});
  await worker.fetch(new Request("https://example.com/assets/v2/v2.css"), env, {});
  assert.deepEqual(assets.requested, ["/v2/other", "/assets/v2/v2.css"]);
});

test("v2 page keeps every element and action the shared scripts depend on", async () => {
  const [html, legacy, events, ...scripts] = await Promise.all([
    readFile(new URL("../public/index-v2.html", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/assets/js/events.js", import.meta.url), "utf8"),
    ...["app", "leaderboard", "portfolio", "profile", "admin", "trading"].map(name =>
      readFile(new URL(`../public/assets/js/${name}.js`, import.meta.url), "utf8")),
  ]);

  // Każde ID, po które sięga wspólny JS i które istnieje w starym UI, musi istnieć w v2.
  const scriptIds = new Set(scripts.flatMap(source =>
    [...source.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map(match => match[1])));
  const missingIds = [...scriptIds]
    .filter(id => legacy.includes(`id="${id}"`))
    .filter(id => !html.includes(`id="${id}"`));
  assert.ok(scriptIds.size > 20);
  assert.deepEqual(missingIds, []);

  const staticActions = [
    ...events.matchAll(/^\s+"([a-z-]+)":/gm),
    ...events.matchAll(/dataset\.action === "([a-z-]+)"/g),
  ].map(match => match[1]);
  const legacyActions = new Set([...legacy.matchAll(/data-action="([^"]+)"/g)].map(match => match[1]));
  const v2Actions = new Set([...html.matchAll(/data-action="([^"]+)"/g)].map(match => match[1]));
  const v2Replaced = new Set(["filter-feed", "select-chip-ticker"]);
  for (const action of legacyActions) {
    if (v2Replaced.has(action)) continue;
    assert.ok(staticActions.includes(action), `unknown action ${action}`);
    assert.ok(v2Actions.has(action), `v2 is missing action ${action}`);
  }

  assert.ok(scripts.length > 0);
  assert.match(html, /<link rel="stylesheet" href="\/assets\/v2\/v2\.css">/);
  assert.match(html, /href="\/api\/auth\/github"/);
  assert.doesNotMatch(html, /\son(?:click|change|submit|input|keypress)=/i);
  for (const script of ["state", "api", "utils", "leaderboard", "portfolio", "profile", "admin", "trading", "app", "events"]) {
    assert.match(html, new RegExp(`src="/assets/js/${script}\\.js"`));
  }
  // Wszystkie zasoby są ścieżkami root-relative — działają pod /v2 i /v2/.
  assert.doesNotMatch(html, /(?:src|href)="(?!https?:|\/|#|data:)[^"]+"/);
});

test("my-transactions requires a session and returns the user's own history", async () => {
  const anonymous = await worker.fetch(
    new Request("https://example.com/api/my-transactions"),
    createEnv(),
    {},
  );
  assert.equal(anonymous.status, 401);

  const rows = [{ id: 5, ticker: "PKN.WA", type: "BUY", shares: 2, price: 150, total_value_ck: 300, thesis: "Test thesis here", created_at: "2026-10-09 12:00:00", company_name: "ORLEN S.A.", currency: "PLN" }];
  const env = createEnv({
    devAuthBypass: true,
    demoUser: { id: 17, github_login: "demo_marta", display_name: "Marta", avatar_url: null, current_cash: 100, is_admin: 0 },
    rows,
  });
  const response = await worker.fetch(new Request("https://dev.example/api/my-transactions"), env, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "success");
  assert.deepEqual(body.data, rows);
});

test("v2 extensions only use hooks that exist in the shared scripts", async () => {
  const [v2, html, ...shared] = await Promise.all([
    readFile(new URL("../public/assets/v2/v2.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index-v2.html", import.meta.url), "utf8"),
    ...["app", "leaderboard", "portfolio", "trading"].map(name =>
      readFile(new URL(`../public/assets/js/${name}.js`, import.meta.url), "utf8")),
  ]);
  const sharedSource = shared.join("\n");
  // Każda funkcja opakowywana w v2.js musi nadal istnieć we wspólnych skryptach.
  for (const name of ["fetchUserPortfolio", "renderDashboard", "fetchAllData", "fetchFeed", "switchTab", "updateTradeAvailability", "openTradeModal", "closeTradeModal", "setTradeType"]) {
    assert.match(sharedSource, new RegExp(`function ${name}\\(`), name);
    assert.match(v2, new RegExp(`window\\.${name} = `), `v2.js should wrap ${name}`);
  }
  assert.match(html, /<script defer src="\/assets\/v2\/v2\.js"><\/script>/);
  // Każdy element, po który sięga v2.js, jest w dokumencie v2.
  const ids = new Set([...v2.matchAll(/\$\("([A-Za-z0-9]+)"\)/g)].map(match => match[1]));
  const missing = [...ids].filter(id => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

test("league allocation aggregates player holdings by market and excludes benchmarks", async () => {
  const queries = [];
  const env = {
    DB: {
      prepare(sql) {
        queries.push(sql);
        return {
          first: async () => (sql.includes("current_cash") && !sql.includes("holdings")
            ? { cash_ck: 91000.5 }
            : { gpw_ck: 42000, usa_ck: 28000 }),
        };
      },
    },
  };
  const response = await worker.fetch(new Request("https://example.com/api/league-allocation"), env, {});
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { gpw_ck: 42000, usa_ck: 28000, cash_ck: 91000.5 });
  assert.ok(queries.every(sql => sql.includes("benchmark_sp500") && sql.includes("benchmark_wig20")));
});

test("v2 markup is balanced and exposes the Ring dashboard hooks", async () => {
  const html = await readFile(new URL("../public/index-v2.html", import.meta.url), "utf8");
  const body = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const voidTags = new Set(["meta", "link", "img", "input", "br", "hr", "source", "path", "circle", "line", "rect", "stop", "defs"]);
  const stack = [];
  for (const [, closing, name, selfClosing] of body.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g)) {
    const tag = name.toLowerCase();
    if (voidTags.has(tag) || selfClosing) continue;
    if (closing) assert.equal(stack.pop(), tag, `unbalanced </${tag}>`);
    else stack.push(tag);
  }
  assert.deepEqual(stack, []);
  for (const id of ["v2Markets", "v2ValuePill", "v2UserCard", "v2Allocation", "v2RankCount", "v2ExposureBar", "v2PositionsBadge"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const action of ["rank-filter", "sort-positions", "analyze-portfolios", "open-audit"]) {
    assert.match(html, new RegExp(`data-v2-action="${action}"`));
  }
});

test("market stand-ups: feed returns news, filter pills and cron handlers are wired", async () => {
  const feed = await readFile(new URL("../src/worker/routes/feed.js", import.meta.url), "utf8");
  const events = await readFile(new URL("../public/assets/js/events.js", import.meta.url), "utf8");
  const portfolio = await readFile(new URL("../public/assets/js/portfolio.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const v2 = await readFile(new URL("../public/index-v2.html", import.meta.url), "utf8");
  assert.match(feed, /market_news/);
  assert.match(events, /"filter-feed": element => setFeedFilter/);
  assert.match(portfolio, /function setFeedFilter/);
  for (const filter of ["all", "trades", "news"]) {
    assert.match(html, new RegExp(`data-action="filter-feed" data-filter="${filter}"`));
    assert.match(v2, new RegExp(`data-v2-action="feed-filter" data-filter="${filter}"`));
  }
  assert.match(html, /href="\/assets\/css\/features\.css"/);
  assert.match(v2, /href="\/assets\/css\/features\.css"/);
});

test("feed endpoint returns market news next to transactions", async () => {
  const news = [{ id: 1, type: "STANDUP_MORNING", title: "Poranny stand-up", content: "Treść", created_at: "2026-10-12 06:00:00" }];
  const env = {
    DB: {
      prepare(sql) {
        return { all: async () => ({ results: sql.includes("market_news") ? news : [] }) };
      },
    },
  };
  const response = await worker.fetch(new Request("https://dev.example/api/feed"), env, {});
  const body = await response.json();
  assert.equal(body.status, "success");
  assert.deepEqual(body.news, news);
  assert.deepEqual(body.data, []);
});

test("scheduled stand-up crons write a market_news row and fall back without Gemini", async () => {
  const db = standupDb({ board: PLAYERS });
  const env = { STANDUP_MARKET_OVERRIDE: [], DB: db.DB };
  const pending = [];
  const ctx = { waitUntil: promise => pending.push(promise) };
  await worker.scheduled({ cron: "0 6 * * MON-FRI" }, env, ctx);
  await worker.scheduled({ cron: "0 14 * * MON-FRI" }, env, ctx);
  await Promise.all(pending);
  assert.deepEqual(db.inserted.map(values => values[0]), ["STANDUP_MORNING", "STANDUP_EVENING"]);
  assert.ok(db.inserted.every(values => values[1] && values[2]));
});

test("ticker autocomplete is wired in both UIs", async () => {
  const trading = await readFile(new URL("../public/assets/js/trading.js", import.meta.url), "utf8");
  const events = await readFile(new URL("../public/assets/js/events.js", import.meta.url), "utf8");
  assert.match(trading, /autocomplete=1/);
  assert.match(events, /onTickerInputDebounced/);
  for (const page of ["index.html", "index-v2.html"]) {
    const html = await readFile(new URL(`../public/${page}`, import.meta.url), "utf8");
    assert.match(html, /id="tickerAutocompleteDropdown"/, page);
    assert.match(html, /id="tradeTickerInput"[^>]*autocomplete="off"/, page);
  }
});

test("instruments autocomplete returns suggestions with market status", async () => {
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              all: async () => ({
                results: [
                  { ticker: "NVDA", name: "NVIDIA Corp", price: 120, currency: "USD", fx_to_pln: 4.0 }
                ]
              }),
            };
          },
        };
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://dev.example/api/instruments/search?q=NV&autocomplete=1"),
    env,
    {},
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "success");
  assert.equal(body.data[0].ticker, "NVDA");
  assert.equal(body.data[0].market, "USA");
  assert.ok(body.data[0].market_status);
});

test("ticker autocomplete is wired in the page and event handlers", async () => {
  const trading = await readFile(new URL("../public/assets/js/trading.js", import.meta.url), "utf8");
  const events = await readFile(new URL("../public/assets/js/events.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(trading, /autocomplete=1/);
  assert.match(events, /onTickerInputDebounced/);
  assert.match(html, /id="tickerAutocompleteDropdown"/);
  assert.match(html, /id="tradeTickerInput"[^>]*autocomplete="off"/);
});


// Mock D1 dla generateStandup: zapytania rozpoznawane po fragmencie SQL.
function standupDb({ board = [], previous = [], positions = [], active = [], newTrades = [], recent = [], failBoard = false } = {}) {
  const inserted = [];
  const sqls = [];
  const binds = [];
  const route = sql => {
    sqls.push(sql);
    if (sql.includes("COUNT(h.ticker) AS positions")) {
      if (failBoard) throw new Error("boom");
      return board;
    }
    if (sql.includes("FROM market_news")) return previous;
    if (sql.includes("return_pct")) return positions;
    if (sql.includes("COUNT(*) AS n")) return active;
    if (sql.includes("value_ck")) return newTrades;
    if (sql.includes("FROM transactions")) return recent;
    return [];
  };
  return {
    inserted, sqls, binds,
    DB: {
      prepare(sql) {
        return {
          all: async () => ({ results: route(sql) }),
          bind: (...values) => ({
            all: async () => { binds.push(values); return { results: route(sql) }; },
            run: async () => { if (sql.includes("INSERT INTO market_news")) inserted.push(values); return { success: true }; },
            first: async () => null,
          }),
        };
      },
    },
  };
}

const PLAYERS = [
  { id: 1, github_login: "ola", display_name: "Ola", current_cash: 30000, positions: 2, total_val: 150000 },
  { id: 2, github_login: "kuba", display_name: "Kuba", current_cash: 11000, positions: 3, total_val: 148000 },
  { id: 3, github_login: "piotr", display_name: "Piotr", current_cash: 83000, positions: 1, total_val: 95000 },
  { id: 4, github_login: "ada", display_name: "Ada", current_cash: 100000, positions: 0, total_val: 100000 },
  { id: 90, github_login: "benchmark_sp500", display_name: "S&P 500", current_cash: 0, positions: 1, total_val: 120000 },
  { id: 91, github_login: "benchmark_wig20", display_name: "WIG20", current_cash: 0, positions: 1, total_val: 118000 },
].sort((a, b) => b.total_val - a.total_val);

test("stand-up context does not depend on holdings.id and survives a failing query", async () => {
  const { generateStandup } = await import("../src/worker/services/ai.js");
  const db = standupDb({
    board: PLAYERS,
    recent: [{ ticker: "NVDA", type: "BUY", thesis: "AI", display_name: "Ola" }],
  });
  const env = { GEMINI_API_KEY: "test-key", STANDUP_MARKET_OVERRIDE: [], DB: db.DB };
  const originalFetch = globalThis.fetch;
  let prompt = "";
  globalThis.fetch = async (_url, init) => {
    prompt = JSON.parse(init.body).contents[0].parts[0].text;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ title: "T", content: "C" }) }] } }] }));
  };
  try {
    const result = await generateStandup(env, "STANDUP_MORNING");
    assert.equal(result.title, "T");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(!db.sqls.some(sql => /\bh\.id\b/.test(sql)), "holdings has no id column in production");
  assert.match(prompt, /"gracz":"Ola"/);
});

test("stand-up context survives a failing board query (other sections still built)", async () => {
  const { loadStandupContext } = await import("../src/worker/services/standupContext.js");
  const db = standupDb({ failBoard: true, newTrades: [{ ticker: "NVDA", type: "BUY", value_ck: 1000, thesis: "x", display_name: "Ola" }] });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const context = await loadStandupContext({ DB: db.DB }, "STANDUP_MORNING", { fetchMarket: async () => [] });
    assert.deepEqual(context.top, []);
    assert.equal(context.newTrades.length, 1);
  } finally {
    console.warn = warn;
  }
});

async function loadFormatStandup() {
  const source = await readFile(new URL("../public/assets/js/utils.js", import.meta.url), "utf8");
  return content => runInNewContext(`${source}\nformatStandupHtml(${JSON.stringify(content)})`);
}

test("stand-up formatter renders chips, headings, lists and bold, and escapes HTML", async () => {
  const format = await loadFormatStandup();
  const html = format([
    "> 🏆 Lider: Ola (+66,3%) • 📉 Dno: Piotr (+19,5%) • 💤 Kisiciele gotówki: 2",
    "",
    "## 🏆 Podium",
    "**Ola** znowu miała fart.",
    "Druga linia akapitu.",
    "",
    "## 🌍 Makro",
    "- **Stopy:** bez zmian",
    "- **USD/PLN:** drożeje",
  ].join("\n"));
  assert.match(html, /<div class="standup-summary">(<span class="standup-chip">[^<]+<\/span>){3}<\/div>/);
  assert.match(html, /<h5 class="standup-heading">🏆 Podium<\/h5>/);
  assert.match(html, /<p class="standup-p"><strong>Ola<\/strong> znowu miała fart\.<br>Druga linia akapitu\.<\/p>/);
  assert.match(html, /<ul class="standup-list"><li><strong>Stopy:<\/strong> bez zmian<\/li><li><strong>USD\/PLN:<\/strong> drożeje<\/li><\/ul>/);
});

test("stand-up formatter is XSS-safe and keeps legacy plain-text entries readable", async () => {
  const format = await loadFormatStandup();
  const hostile = format('## <img src=x onerror=alert(1)>\n<script>alert(1)</script> **<b>x</b>**\n- <a href="javascript:1">l</a>');
  assert.ok(!/<(script|img|a|b)\b/i.test(hostile), hostile);
  assert.match(hostile, /&lt;script&gt;/);
  const legacy = format("Pierwszy akapit starego wpisu.\n\nDrugi akapit.");
  assert.equal(legacy, '<p class="standup-p">Pierwszy akapit starego wpisu.</p><p class="standup-p">Drugi akapit.</p>');
});

test("stand-up content gets a deterministic facts bar and strips model-made quote lines", async () => {
  const { composeStandupContent, buildStandupFacts } = await import("../src/worker/services/ai.js");
  const context = {
    top: [{ display_name: "Ola", total_val: 166300 }],
    // kolejność jak w zapytaniu SQL: rosnąco po wycenie (najsłabszy pierwszy)
    bottom: [{ display_name: "Piotr", total_val: 119500 }, { display_name: "Kuba", total_val: 127400 }],
    cashSitters: [{}, {}],
  };
  assert.equal(
    buildStandupFacts(context),
    "> 🏆 Lider: Ola (+66,3%) • 📉 Dno: Piotr (+19,5%) • 💤 Kisiciele gotówki: 2",
  );
  const content = composeStandupContent(context, "> zmyślony pasek\n## 🏆 Podium\n**Ola** wygrywa.");
  assert.ok(content.startsWith("> 🏆 Lider: Ola"));
  assert.ok(!content.includes("zmyślony pasek"));
  assert.match(content, /## 🏆 Podium\n\*\*Ola\*\* wygrywa\./);
  assert.equal(composeStandupContent({}, "## Sekcja\ntekst"), "## Sekcja\ntekst");
});

test("stand-up fallback is data-driven (same sections, real names) and stored with the facts bar", async () => {
  const { generateStandup } = await import("../src/worker/services/ai.js");
  const db = standupDb({
    board: PLAYERS,
    newTrades: [{ ticker: "NVDA", type: "BUY", value_ck: 5000, shares: 3, thesis: "AI rządzi", display_name: "Ola" }],
  });
  const result = await generateStandup({ STANDUP_MARKET_OVERRIDE: [], DB: db.DB }, "STANDUP_MORNING");
  assert.equal(result.title, "Poranny Stand-up z Parkietu");
  assert.match(result.content, /^> 🏆 Lider: Ola \(\+50,0%\) • 📉 Dno: Piotr \(-5,0%\)/);
  assert.match(result.content, /## 🏆 Podium\n- \*\*Ola\*\* — 150.000 CK \(\+50,0%\)\n- \*\*Kuba\*\*/);
  assert.match(result.content, /## 📉 Dno tabeli\n- \*\*Piotr\*\* — 95.000 CK \(-5,0%\)/);
  assert.match(result.content, /## 🔁 Nowe ruchy\n- \*\*Ola\*\* kupuje NVDA — „AI rządzi”/);
  assert.equal(db.inserted[0][0], "STANDUP_MORNING");
  assert.equal(db.inserted[0][2], result.content);
});

test("Gemini calls are retried on temporary errors before falling back", async () => {
  const { generateStandup } = await import("../src/worker/services/ai.js");
  const env = { GEMINI_API_KEY: "key", GEMINI_RETRY_DELAY_MS: 0, STANDUP_MARKET_OVERRIDE: [], DB: standupDb({ board: PLAYERS }).DB };
  const originalFetch = globalThis.fetch;
  const statuses = [503, 429, 200];
  let calls = 0;
  globalThis.fetch = async () => {
    const status = statuses[calls++];
    if (status !== 200) return new Response("overloaded", { status });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ title: "Po ponowieniach", content: "## 🏆 Podium\n**Ola** wygrywa." }) }] } }] }));
  };
  try {
    const result = await generateStandup(env, "STANDUP_MORNING");
    assert.equal(calls, 3);
    assert.equal(result.title, "Po ponowieniach");
    assert.match(result.content, /\*\*Ola\*\* wygrywa\./);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini non-retryable errors (400) stop after one attempt and use the fallback", async () => {
  const { generateStandup } = await import("../src/worker/services/ai.js");
  const env = { GEMINI_API_KEY: "key", GEMINI_RETRY_DELAY_MS: 0, STANDUP_MARKET_OVERRIDE: [], DB: standupDb({ board: PLAYERS }).DB };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("bad request", { status: 400 }); };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await generateStandup(env, "STANDUP_EVENING");
    assert.equal(calls, 1);
    assert.equal(result.title, "Popołudniowy Stand-up z Parkietu");
    assert.match(result.content, /Komentarz AI jest chwilowo niedostępny/);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("feed timestamps are UTC from D1 and are displayed in Europe/Warsaw time", async () => {
  const source = await readFile(new URL("../public/assets/js/utils.js", import.meta.url), "utf8");
  const call = (value, now) =>
    runInNewContext(`${source}\nformatFeedTimestamp(${JSON.stringify(value)}, new Date(${JSON.stringify(now)}))`);
  // lato (CEST, UTC+2): 06:00:02 UTC -> 08:00
  assert.equal(call("2026-10-13 06:00:02", "2026-10-13T08:30:00Z"), "Dziś, 08:00");
  assert.equal(call("2026-10-12 14:00:06", "2026-10-13T08:30:00Z"), "Wczoraj, 16:00");
  // zima (CET, UTC+1): 06:00 UTC -> 07:00
  assert.match(call("2026-01-05 06:00:00", "2026-10-13T08:30:00Z"), /^5 sty,? 07:00$/);
  assert.equal(call("", "2026-10-13T08:30:00Z"), "—");
  // znacznik z oznaczeniem strefy nie jest przesuwany po raz drugi
  assert.equal(call("2026-10-13T06:00:02Z", "2026-10-13T08:30:00Z"), "Dziś, 08:00");
});

test("both UIs render stand-ups through the shared formatter", async () => {
  const portfolio = await readFile(new URL("../public/assets/js/portfolio.js", import.meta.url), "utf8");
  const v2 = await readFile(new URL("../public/assets/v2/v2.js", import.meta.url), "utf8");
  assert.match(portfolio, /formatStandupHtml\(item\.content\)/);
  assert.match(v2, /formatStandupHtml\(item\.content\)/);
  assert.doesNotMatch(portfolio, /whitespace-pre-line">\$\{escapeHtml\(item\.content\)/);
});

test("stand-up response parser handles fenced JSON, raw newlines and truncated output", async () => {
  const { parseStandupResponse } = await import("../src/worker/services/ai.js");
  const clean = parseStandupResponse(JSON.stringify({ title: "Tytuł", content: "## A\n- x" }));
  assert.deepEqual(clean, { title: "Tytuł", content: "## A\n- x" });

  const fenced = parseStandupResponse('```json\n{"title":"T","content":"## A\\n- x"}\n```');
  assert.equal(fenced.title, "T");
  assert.equal(fenced.content, "## A\n- x");

  // surowe nowe linie wewnątrz stringa — niepoprawny JSON, którego użyło Gemini
  const rawNewlines = parseStandupResponse('```json\n{\n  "title": "Poranek",\n  "content": "## 🌍 Makro\n- **Stopy:** a\n- **USD/PLN:** b"\n}\n```');
  assert.equal(rawNewlines.title, "Poranek");
  assert.equal(rawNewlines.content, "## 🌍 Makro\n- **Stopy:** a\n- **USD/PLN:** b");

  // urwany JSON: tytuł i początek treści nadal da się odzyskać
  const truncated = parseStandupResponse('{"title":"Urwany","content":"## A\\nzdanie"');
  assert.equal(truncated.title, "Urwany");

  assert.deepEqual(parseStandupResponse(""), {});
  assert.deepEqual(parseStandupResponse("zwykły tekst"), {});
});

test("generateStandup stores parsed sections (not a raw fenced JSON block) and asks for JSON mode", async () => {
  const { generateStandup } = await import("../src/worker/services/ai.js");
  const stored = [];
  const env = {
    GEMINI_API_KEY: "key",
    DB: {
      prepare() {
        return {
          all: async () => ({ results: [] }),
          bind: (...values) => ({ run: async () => { stored.push(values); return { success: true }; } }),
        };
      },
    },
  };
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    const text = '```json\n{"title": "Z fence",\n "content": "## 🏆 Podium\n**Ola** wygrywa."}\n```';
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
  };
  try {
    const result = await generateStandup(env, "STANDUP_MORNING");
    assert.equal(result.title, "Z fence");
    assert.match(result.content, /^## 🏆 Podium\n\*\*Ola\*\* wygrywa\.$/);
    assert.ok(!result.content.includes("```"));
    assert.equal(requestBody.generationConfig.responseMimeType, "application/json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("market moves: parses day change and drops failed symbols", async () => {
  const { fetchMarketMoves } = await import("../src/worker/services/standupContext.js");
  const fetchImpl = async url => {
    if (String(url).includes("PLN%3DX")) return new Response("nope", { status: 500 });
    const price = String(url).includes("GSPC") ? 5100 : 2400;
    return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: price, chartPreviousClose: price / 1.01 } }] } }));
  };
  const moves = await fetchMarketMoves(fetchImpl);
  assert.deepEqual(moves.map(m => m.label), ["S&P 500", "WIG20"]);
  assert.equal(moves[0].changePct, 1);
});

test("lens rotates deterministically per slot and only picks lenses with material", async () => {
  const { pickLens, findDuel } = await import("../src/worker/services/standupContext.js");
  const players = PLAYERS.filter(p => !p.github_login.startsWith("benchmark_"));
  const context = {
    duel: findDuel(players),
    positionsWorst: [{ display_name: "Piotr", ticker: "MSTR", name: "Strategy", return_pct: -23.4 }],
    positionsBest: [{ display_name: "Ola", ticker: "NVDA", name: "NVIDIA", return_pct: 31.2 }],
    newTrades: [{}, {}], mostActive: [{ display_name: "Kuba", n: 3 }],
    cashSitters: [{ display_name: "Ada" }], beatingMarket: 2, playerCount: 4, benchmarks: [{}],
  };
  const day = new Date("2026-10-14T06:00:00Z");
  const a = pickLens(context, "STANDUP_MORNING", day);
  assert.equal(pickLens(context, "STANDUP_MORNING", day).id, a.id);
  const ids = new Set();
  for (let offset = 0; offset < 30; offset += 1) {
    ids.add(pickLens(context, offset % 2 ? "STANDUP_EVENING" : "STANDUP_MORNING", new Date(day.getTime() + offset * 86400000)).id);
  }
  assert.ok(ids.size >= 4, `lenses used: ${[...ids].join(",")}`);
  // kolejne wydania (rosnące id ostatniego wpisu) nigdy nie dostają tego samego motywu
  let previousLens = null;
  for (let lastId = 10; lastId < 40; lastId += 1) {
    const lens = pickLens({ ...context, previous: [{ id: lastId }] }, "STANDUP_MORNING", day);
    assert.notEqual(lens.id, previousLens, `edition ${lastId}`);
    previousLens = lens.id;
  }
  assert.equal(pickLens({ benchmarks: [], playerCount: 0 }, "STANDUP_MORNING", day), null);
  assert.equal(findDuel(players).upper, "Ola");
  assert.equal(findDuel(players).lower, "Kuba");
});

test("prompt carries new trades, previous editions, market data and the morning/evening role", async () => {
  const { buildStandupPrompt } = await import("../src/worker/services/standupContext.js");
  const base = {
    playerCount: 4, top: [PLAYERS[1]], bottom: [PLAYERS[4] || PLAYERS[0]], cashSitters: [], benchmarks: [], beatingMarket: null,
    newTrades: [{ display_name: "Ola", type: "BUY", ticker: "ADBT", shares: 48, value_ck: 1200, thesis: "Spółki groszkowe" }],
    sinceLastAt: "2026-10-12 14:00:06",
    previous: [{ type: "STANDUP_EVENING", title: "Korpo-grill", content: "> pasek\n## A\nPapier toaletowy to frajerzy." }],
    market: [{ label: "S&P 500", price: 5100, changePct: 0.8 }],
  };
  const morning = buildStandupPrompt({ ...base, isMorning: true }, { instruction: "Pojedynek o 1. miejsce" }, { avoid: ["frajerzy"] });
  assert.match(morning, /PORANNE \(zapowiedź dnia\)/);
  assert.match(morning, /MOTYW PRZEWODNI.*Pojedynek o 1\. miejsce/);
  assert.match(morning, /"ticker":"ADBT"/);
  assert.match(morning, /"instrument":"S&P 500".*"zmiana_proc":0\.8/);
  assert.match(morning, /POPRZEDNIE WYDANIA/);
  assert.match(morning, /Papier toaletowy to frajerzy/);
  assert.ok(!morning.includes("> pasek"));
  assert.match(morning, /WYCZERPANE SŁOWA I OBRAZY.*frajerzy/);
  const evening = buildStandupPrompt({ ...base, isMorning: false, newTrades: [], market: [] }, null);
  assert.match(evening, /POPOŁUDNIOWE \(rozliczenie dnia\)/);
  assert.match(evening, /cisza na parkiecie/);
  assert.match(evening, /brak notowań/);
});

test("overused vocabulary from previous editions is detected (names excluded) and counted", async () => {
  const { overusedTerms, countOverused } = await import("../src/worker/services/standupContext.js");
  const context = {
    top: [{ display_name: "Serowy pogromca" }], bottom: [], cashSitters: [], newTrades: [], recentTrades: [],
    previous: [
      { content: "**Serowy pogromca** to frajerzy, a złotówka to papier toaletowy. Inflacja żre." },
      { content: "Znowu frajerzy i papier toaletowy, **Serowy pogromca** jak zwykle." },
      { content: "Coś zupełnie innego o spółkach i dywidendach." },
    ],
  };
  const terms = overusedTerms(context);
  assert.ok(terms.some(t => t.startsWith("frajer")), terms.join(","));
  assert.ok(terms.some(t => t.startsWith("papier")));
  assert.ok(!terms.some(t => t.startsWith("serowy")), "player names are not 'overused jokes'");
  assert.equal(countOverused("Nowy tekst bez starych motywów.", terms), 0);
  assert.ok(countOverused("Frajerzy znowu, papier i toaleta.", terms) >= 2);
});

test("freshness gate: a repetitive first draft triggers one rewrite and the fresher text wins", async () => {
  const { generateStandup } = await import("../src/worker/services/ai.js");
  const previous = [
    { id: 3, type: "STANDUP_EVENING", created_at: "2026-10-12 14:00:06", title: "Korpo-grill", content: "frajerzy papier toaletowy inflacja euforia kredyty gratulacje oszczędności" },
    { id: 2, type: "STANDUP_MORNING", created_at: "2026-10-12 07:45:30", title: "Łomot", content: "frajerzy papier toaletowy inflacja euforia kredyty gratulacje oszczędności" },
  ];
  const db = standupDb({ board: PLAYERS, previous });
  const originalFetch = globalThis.fetch;
  const drafts = [
    { title: "Stare żarty", content: "## 🏆 Podium\nFrajerzy, papier toaletowy, inflacja, euforia i kredyty. Gratulacje za oszczędności." },
    { title: "Świeży kąt", content: "## 🏆 Podium\n**Ola** prowadzi o włos przed **Kuba**; sesja zapowiada się nerwowo." },
  ];
  const prompts = [];
  let call = 0;
  globalThis.fetch = async (_url, init) => {
    prompts.push(JSON.parse(init.body).contents[0].parts[0].text);
    const draft = drafts[Math.min(call++, drafts.length - 1)];
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(draft) }] } }] }));
  };
  try {
    const result = await generateStandup({ GEMINI_API_KEY: "k", STANDUP_MARKET_OVERRIDE: [], DB: db.DB }, "STANDUP_MORNING");
    assert.equal(call, 2);
    assert.equal(result.title, "Świeży kąt");
    assert.match(prompts[1], /poprzednia wersja powtarzała stare żarty/);
    assert.ok(result.content.includes("prowadzi o włos"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dry-run mode returns the stand-up without writing to the database", async () => {
  const { generateStandup } = await import("../src/worker/services/ai.js");
  const db = standupDb({ board: PLAYERS });
  const log = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const result = await generateStandup({ STANDUP_DRY_RUN: "1", STANDUP_MARKET_OVERRIDE: [], DB: db.DB }, "STANDUP_EVENING");
    assert.ok(result.content.startsWith("> 🏆 Lider: Ola"));
  } finally {
    console.log = log;
  }
  assert.equal(db.inserted.length, 0);
  assert.ok(lines.some(line => line.startsWith("STANDUP_DRY_RUN")));
});

test("duel ignores cash sitters and ties", async () => {
  const { findDuel } = await import("../src/worker/services/standupContext.js");
  const players = [
    { display_name: "A", positions: 2, total_val: 102400 },
    { display_name: "B", positions: 1, total_val: 100400 },
    { display_name: "Ada", positions: 0, total_val: 100000 },
    { display_name: "Lukasz", positions: 0, total_val: 100000 },
  ];
  assert.deepEqual(findDuel(players), { rank: 1, upper: "A", lower: "B", gapPp: 2 });
  assert.equal(findDuel([{ display_name: "X", positions: 0, total_val: 100000 }, { display_name: "Y", positions: 0, total_val: 100000 }]), null);
});
