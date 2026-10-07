/**
 * Karuzela Hajsu — Backend Worker
 * Obsługa GitHub OAuth, silnika transakcyjnego, reguł 35%, awatarów i crona giełdowego.
 */

export default {
  // 1. Harmonogram Cron Trigger (automatyczna aktualizacja kursów)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncAllMarketPrices(env));
  },

  // 2. Obsługa żądań HTTP
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";

    // Obsługa CORS (dla zapytań lokalnych / opcjonalnych nagłówków)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    try {
      // --- ROUTE: OAuth Start ---
      if (url.pathname === "/api/auth/github") {
        const clientId = env.GITHUB_CLIENT_ID;
        const redirectUri = `${url.origin}/api/auth/callback`;
        const state = crypto.randomUUID();

        const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=read:user`;
        return Response.redirect(githubAuthUrl, 302);
      }

      // --- ROUTE: OAuth Callback ---
      if (url.pathname === "/api/auth/callback") {
        const code = url.searchParams.get("code");
        if (!code) return new Response("Brak kodu autoryzacji z GitHuba", { status: 400 });

        // Wymiana kodu na token
        const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
          },
          body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code,
          }),
        });

        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
          return new Response("Błąd autoryzacji w GitHub API", { status: 401 });
        }

        // Pobranie profilu użytkownika (login + avatar)
        const userProfileRes = await fetch("https://api.github.com/user", {
          headers: {
            "Authorization": `Bearer ${tokenData.access_token}`,
            "User-Agent": "Karuzela-Hajsu-App",
          },
        });
        const ghUser = await userProfileRes.json();

        // Weryfikacja białej listy w bazie D1
        const userRecord = await env.DB.prepare(
          "SELECT id, github_login, display_name, is_admin FROM users WHERE github_login = ?"
        ).bind(ghUser.login).first();

        if (!userRecord) {
          await logAudit(env, null, "LOGIN_FAILED_WHITELIST", { gh_login: ghUser.login }, clientIp, "REJECTED");
          return new Response(`Brak dostępu: Twój login (${ghUser.login}) nie znajduje się na białej liście ligi.`, { status: 403 });
        }

        // Zapisanie/odświeżenie awatara z GitHuba
        if (ghUser.avatar_url) {
          await env.DB.prepare("UPDATE users SET avatar_url = ? WHERE id = ?")
            .bind(ghUser.avatar_url, userRecord.id).run();
        }

        // Utworzenie tokenu sesji (ważny 14 dni)
        const sessionToken = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

        await env.DB.prepare(
          "INSERT INTO sessions (token, user_id, ip_address, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)"
        ).bind(sessionToken, userRecord.id, clientIp, request.headers.get("User-Agent") || "", expiresAt).run();

        await logAudit(env, userRecord.id, "LOGIN_SUCCESS", { gh_login: ghUser.login }, clientIp, "SUCCESS");

        return new Response(null, {
          status: 302,
          headers: {
            "Location": "/",
            "Set-Cookie": `session_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600; Secure`,
          },
        });
      }

      // --- ROUTE: Pobranie zalogowanego profilu (/api/me) ---
      if (url.pathname === "/api/me") {
        const user = await getSessionUser(request, env);
        if (!user) {
          return jsonResponse({ authenticated: false });
        }
        return jsonResponse({
          authenticated: true,
          user: {
            id: user.id,
            github_login: user.github_login,
            display_name: user.display_name,
            avatar_url: user.avatar_url,
            is_admin: user.is_admin,
          },
        });
      }

      // --- ROUTE: Wylogowanie (/api/logout) ---
      if (url.pathname === "/api/logout") {
        const cookie = request.headers.get("Cookie") || "";
        const match = cookie.match(/session_token=([^;]+)/);
        if (match) {
          await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(match[1]).run();
        }
        return new Response(JSON.stringify({ status: "success" }), {
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": "session_token=; Path=/; HttpOnly; Max-Age=0; Secure",
          },
        });
      }

      // --- ROUTE: Ranking i Metadane (/api/leaderboard) ---
      if (url.pathname === "/api/leaderboard") {
        const query = `
          SELECT 
            u.id,
            u.github_login,
            u.display_name AS Uczestnik,
            u.avatar_url,
            u.current_cash AS Gotowka_PLN,
            COALESCE(SUM(h.shares * p.price * p.fx_to_pln), 0) AS Wartosc_Akcji_PLN,
            (u.current_cash + COALESCE(SUM(h.shares * p.price * p.fx_to_pln), 0)) AS Wycena_Calkowita_PLN,
            COUNT(h.ticker) AS Liczba_Pozycji
          FROM users u
          LEFT JOIN holdings h ON u.id = h.user_id AND h.shares > 0
          LEFT JOIN market_prices p ON h.ticker = p.ticker
          GROUP BY u.id
        `;

        const { results } = await env.DB.prepare(query).all();

        // Odczytanie czasu ostatniej aktualizacji crona
        const syncMeta = await env.DB.prepare("SELECT value, updated_at FROM app_metadata WHERE key = 'last_price_sync'").first();

        const leaderboard = results.map(row => {
          const profit = row.Wycena_Calkowita_PLN - 100000.0;
          const returnPct = profit / 100000.0;
          return {
            ...row,
            Zysk_Strata_PLN: profit,
            Stopa_Zwrotu: returnPct,
          };
        }).sort((a, b) => b.Stopa_Zwrotu - a.Stopa_Zwrotu);

        return jsonResponse({
          status: "success",
          data: leaderboard,
          last_sync: syncMeta ? syncMeta.value : null,
        });
      }

      // --- ROUTE: Portfel zalogowanego gracza (/api/portfolio) ---
      if (url.pathname === "/api/portfolio") {
        const user = await getSessionUser(request, env);
        if (!user) return jsonResponse({ status: "error", message: "Wymagane logowanie" }, 401);

        const query = `
          SELECT 
            h.ticker,
            m.name,
            h.shares,
            h.avg_buy_price,
            m.price AS current_price,
            m.currency,
            m.fx_to_pln,
            (h.shares * m.price * m.fx_to_pln) AS current_value_pln,
            (((m.price - h.avg_buy_price) / h.avg_buy_price) * 100) AS return_pct
          FROM holdings h
          JOIN market_prices m ON h.ticker = m.ticker
          WHERE h.user_id = ? AND h.shares > 0
          ORDER BY current_value_pln DESC
        `;
        const { results } = await env.DB.prepare(query).bind(user.id).all();

        return jsonResponse({
          status: "success",
          cash: user.current_cash,
          data: results,
        });
      }

      // --- ROUTE: Wyszukiwarka walorów (/api/instruments/search) ---
      if (url.pathname === "/api/instruments/search") {
        const q = (url.searchParams.get("q") || "").trim().toUpperCase();
        if (!q) return jsonResponse({ status: "error", message: "Brak symbolu waloru" }, 400);

        const quote = await fetchYahooQuote(q);
        if (!quote) {
          return jsonResponse({ status: "error", message: `Walor "${q}" nie został znaleziony lub nie jest dozwolony.` }, 404);
        }

        // Pobranie aktualnego kursu USD/PLN
        let fxRate = 1.0;
        if (quote.currency === "USD") {
          const usdQuote = await fetchYahooQuote("PLN=X");
          fxRate = usdQuote ? usdQuote.price : 4.0;
        }

        // Zapis/odświeżenie w tabeli market_prices
        await env.DB.prepare(`
          INSERT INTO market_prices (ticker, name, price, currency, fx_to_pln, updated_at)
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(ticker) DO UPDATE SET price = excluded.price, fx_to_pln = excluded.fx_to_pln, updated_at = CURRENT_TIMESTAMP
        `).bind(quote.ticker, quote.name, quote.price, quote.currency, fxRate).run();

        return jsonResponse({
          status: "success",
          data: {
            ...quote,
            fx_to_pln: fxRate,
            price_pln: quote.price * fxRate,
          },
        });
      }

      // --- ROUTE: Składanie zlecenia (/api/trade) ---
      if (url.pathname === "/api/trade" && request.method === "POST") {
        const user = await getSessionUser(request, env);
        if (!user) return jsonResponse({ status: "error", message: "Wymagane logowanie" }, 401);

        const body = await request.json();
        const { ticker, type, shares, thesis } = body;

        // Walidacja podstawowa
        if (!ticker || !["BUY", "SELL"].includes(type) || !shares || shares <= 0) {
          return jsonResponse({ status: "error", message: "Nieprawidłowe dane zlecenia." }, 400);
        }

        if (!thesis || thesis.trim().length < 15) {
          return jsonResponse({ status: "error", message: "Uzasadnienie (Teza inwestycyjna) musi mieć co najmniej 15 znaków!" }, 400);
        }

        // Pobranie bieżącego kursu z bazy
        const inst = await env.DB.prepare("SELECT * FROM market_prices WHERE ticker = ?").bind(ticker).first();
        if (!inst) {
          return jsonResponse({ status: "error", message: "Walor nie został zweryfikowany w bazie." }, 400);
        }

        const pricePln = inst.price * inst.fx_to_pln;
        const totalTradePln = shares * pricePln;

        // Wycena całkowita portfela użytkownika
        const portSummary = await env.DB.prepare(`
          SELECT 
            u.current_cash,
            COALESCE(SUM(h.shares * p.price * p.fx_to_pln), 0) AS stocks_value
          FROM users u
          LEFT JOIN holdings h ON u.id = h.user_id AND h.shares > 0
          LEFT JOIN market_prices p ON h.ticker = p.ticker
          WHERE u.id = ?
          GROUP BY u.id
        `).bind(user.id).first();

        const totalPortfolioValue = (portSummary.current_cash || 0) + (portSummary.stocks_value || 0);

        if (type === "BUY") {
          // 1. Sprawdzenie salda gotówki
          if (user.current_cash < totalTradePln) {
            return jsonResponse({ status: "error", message: `Niewystarczające saldo gotówki. Posiadasz: ${user.current_cash.toFixed(2)} zł, potrzebujesz: ${totalTradePln.toFixed(2)} zł.` }, 400);
          }

          // 2. Walidacja limitu 35% na walor
          const existingHolding = await env.DB.prepare("SELECT shares FROM holdings WHERE user_id = ? AND ticker = ?").bind(user.id, ticker).first();
          const existingShares = existingHolding ? existingHolding.shares : 0;
          const postTradeTickerValue = (existingShares + shares) * pricePln;
          const exposurePct = (postTradeTickerValue / totalPortfolioValue) * 100;

          if (exposurePct > 35.01) {
            return jsonResponse({ 
              status: "error", 
              message: `Naruszenie limitu koncentracji (Max 35%). Po transakcji walor stanowiłby ${exposurePct.toFixed(1)}% Twojego portfela!` 
            }, 400);
          }

          // Wykonanie zakupu w atomowej paczce batch()
          await env.DB.batch([
            env.DB.prepare("UPDATE users SET current_cash = current_cash - ? WHERE id = ? AND current_cash >= ?").bind(totalTradePln, user.id, totalTradePln),
            env.DB.prepare(`
              INSERT INTO holdings (user_id, ticker, shares, avg_buy_price)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id, ticker) DO UPDATE SET
                avg_buy_price = ((holdings.shares * holdings.avg_buy_price) + (excluded.shares * excluded.avg_buy_price)) / (holdings.shares + excluded.shares),
                shares = holdings.shares + excluded.shares
            `).bind(user.id, ticker, shares, inst.price),
            env.DB.prepare(`
              INSERT INTO transactions (user_id, ticker, type, shares, price, total_value_pln, thesis)
              VALUES (?, ?, 'BUY', ?, ?, ?, ?)
            `).bind(user.id, ticker, shares, inst.price, totalTradePln, thesis.trim())
          ]);

          await logAudit(env, user.id, "TRADE_BUY", { ticker, shares, totalTradePln }, clientIp, "SUCCESS");
          return jsonResponse({ status: "success", message: "Zlecenie kupna zrealizowane pomyślnie!" });

        } else if (type === "SELL") {
          // Walidacja posiadanych akcji
          const existingHolding = await env.DB.prepare("SELECT shares FROM holdings WHERE user_id = ? AND ticker = ?").bind(user.id, ticker).first();
          if (!existingHolding || existingHolding.shares < shares) {
            const available = existingHolding ? existingHolding.shares : 0;
            return jsonResponse({ status: "error", message: `Nie posiadasz tylu akcji do sprzedaży. Dostępne: ${available} szt.` }, 400);
          }

          const remainingShares = existingHolding.shares - shares;

          const batchQueries = [
            env.DB.prepare("UPDATE users SET current_cash = current_cash + ? WHERE id = ?").bind(totalTradePln, user.id),
            env.DB.prepare(`
              INSERT INTO transactions (user_id, ticker, type, shares, price, total_value_pln, thesis)
              VALUES (?, ?, 'SELL', ?, ?, ?, ?)
            `).bind(user.id, ticker, shares, inst.price, totalTradePln, thesis.trim())
          ];

          if (remainingShares <= 0.0001) {
            batchQueries.push(env.DB.prepare("DELETE FROM holdings WHERE user_id = ? AND ticker = ?").bind(user.id, ticker));
          } else {
            batchQueries.push(env.DB.prepare("UPDATE holdings SET shares = ? WHERE user_id = ? AND ticker = ?").bind(remainingShares, user.id, ticker));
          }

          await env.DB.batch(batchQueries);
          await logAudit(env, user.id, "TRADE_SELL", { ticker, shares, totalTradePln }, clientIp, "SUCCESS");
          return jsonResponse({ status: "success", message: "Zlecenie sprzedaży zrealizowane pomyślnie!" });
        }
      }

      // --- ROUTE: Feed ostatnich zleceń (/api/feed) ---
      if (url.pathname === "/api/feed") {
        const query = `
          SELECT 
            t.id,
            t.ticker,
            t.type,
            t.shares,
            t.price,
            t.total_value_pln,
            t.thesis,
            t.created_at,
            u.display_name AS user_name,
            u.avatar_url
          FROM transactions t
          JOIN users u ON t.user_id = u.id
          ORDER BY t.created_at DESC
          LIMIT 25
        `;
        const { results } = await env.DB.prepare(query).all();
        return jsonResponse({ status: "success", data: results });
      }

      // --- ROUTE: Audyt (Tylko Admin) (/api/admin/audit) ---
      if (url.pathname === "/api/admin/audit") {
        const user = await getSessionUser(request, env);
        if (!user || user.is_admin !== 1) {
          return jsonResponse({ status: "error", message: "Brak uprawnień administratora." }, 403);
        }

        const query = `
          SELECT 
            a.id,
            a.action,
            a.payload,
            a.ip_address,
            a.status,
            a.created_at,
            COALESCE(u.display_name, 'Niezalogowany / System') AS user_name
          FROM audit_log a
          LEFT JOIN users u ON a.user_id = u.id
          ORDER BY a.created_at DESC
          LIMIT 100
        `;
        const { results } = await env.DB.prepare(query).all();
        return jsonResponse({ status: "success", data: results });
      }

      // --- ROUTE: Ręczna synchronizacja cen (Tylko Admin) (/api/admin/sync-prices) ---
      if (url.pathname === "/api/admin/sync-prices") {
        const user = await getSessionUser(request, env);
        if (!user || user.is_admin !== 1) {
          return jsonResponse({ status: "error", message: "Brak uprawnień administratora." }, 403);
        }

        const syncLogs = await syncAllMarketPrices(env);
        return jsonResponse({ status: "success", message: "Synchronizacja zakończona", logs: syncLogs });
      }

      return new Response("Not Found", { status: 404 });

    } catch (err) {
      console.error("Worker Global Error:", err);
      return jsonResponse({ status: "error", message: err.message }, 500);
    }
  }
};

// ==========================================
// FUNKCJE POMOCNICZE
// ==========================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function getSessionUser(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/session_token=([^;]+)/);
  if (!match) return null;

  const session = await env.DB.prepare(`
    SELECT s.*, u.id, u.github_login, u.display_name, u.avatar_url, u.current_cash, u.is_admin
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > CURRENT_TIMESTAMP
  `).bind(match[1]).first();

  return session;
}

async function logAudit(env, userId, action, payload, ip, status) {
  try {
    await env.DB.prepare(`
      INSERT INTO audit_log (user_id, action, payload, ip_address, status)
      VALUES (?, ?, ?, ?, ?)
    `).bind(userId, action, typeof payload === "string" ? payload : JSON.stringify(payload), ip, status).run();
  } catch (e) {
    console.error("Audit log error:", e);
  }
}

// Pobieranie kursów giełdowych z Yahoo Finance
async function fetchYahooQuote(symbol) {
  try {
    const cleanSym = symbol.trim().toUpperCase();
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cleanSym)}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
    });

    if (!res.ok) return null;
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta || !meta.regularMarketPrice) return null;

    let currency = meta.currency || "USD";
    if (cleanSym.endsWith(".WA")) currency = "PLN";

    return {
      ticker: cleanSym,
      name: meta.shortName || meta.longName || cleanSym,
      price: Number(meta.regularMarketPrice),
      currency: currency.toUpperCase(),
    };
  } catch (e) {
    console.error(`Błąd Yahoo Finance dla ${symbol}:`, e);
    return null;
  }
}

// Pełna synchronizacja wszystkich walorów w obiegu + indeksów
async function syncAllMarketPrices(env) {
  const logs = [];

  // 1. Kurs USD/PLN
  let usdPln = 4.0;
  const usdQuote = await fetchYahooQuote("PLN=X");
  if (usdQuote) {
    usdPln = usdQuote.price;
    logs.push(`Kurs USD/PLN: ${usdPln.toFixed(4)}`);
  }

  // 2. Pobranie unikalnych tickerów z bazy
  const { results: tickers } = await env.DB.prepare("SELECT ticker, currency FROM market_prices").all();

  for (const item of tickers) {
    const q = await fetchYahooQuote(item.ticker);
    if (q) {
      const fx = q.currency === "USD" ? usdPln : 1.0;
      await env.DB.prepare(`
        UPDATE market_prices 
        SET price = ?, fx_to_pln = ?, updated_at = CURRENT_TIMESTAMP
        WHERE ticker = ?
      `).bind(q.price, fx, item.ticker).run();
      logs.push(`Zaktualizowano ${item.ticker}: ${q.price} ${q.currency}`);
    }
  }

  // 3. Zapis znacznika czasu do app_metadata
  await env.DB.prepare(`
    INSERT INTO app_metadata (key, value, updated_at)
    VALUES ('last_price_sync', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
  `).run();

  logs.push("Zapisano timestamp synchronizacji w app_metadata.");
  return logs;
}