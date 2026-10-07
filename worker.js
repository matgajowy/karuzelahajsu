/**
 * Karuzela Hajsu — Backend Worker v3.0
 * Okresowość (Sprint Śr-Śr, Kwartał, Rok), Relative Snapshot Returns, Blokada Po Starcie & Whitelist.
 */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncAllMarketPrices(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
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

        const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code,
          }),
        });

        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) return new Response("Błąd autoryzacji w GitHub API", { status: 401 });

        const userProfileRes = await fetch("https://api.github.com/user", {
          headers: { "Authorization": `Bearer ${tokenData.access_token}`, "User-Agent": "Karuzela-Hajsu-App" },
        });
        const ghUser = await userProfileRes.json();

        // Weryfikacja białej listy w D1
        const userRecord = await env.DB.prepare(
          "SELECT id, github_login, display_name, avatar_url, is_admin, status FROM users WHERE github_login = ?"
        ).bind(ghUser.login).first();

        if (!userRecord) {
          await logAudit(env, null, "LOGIN_REJECTED", { gh_login: ghUser.login }, clientIp, "REJECTED");
          return new Response(`Brak dostępu: Użytkownik "${ghUser.login}" nie znajduje się na białej liście ligi.`, { status: 403 });
        }

        if (userRecord.status === "ALUMNI") {
          return new Response("To konto ma status ALUMNI (zakończona gra w lidze).", { status: 403 });
        }

        if (!userRecord.avatar_url && ghUser.avatar_url) {
          await env.DB.prepare("UPDATE users SET avatar_url = ? WHERE id = ?").bind(ghUser.avatar_url, userRecord.id).run();
        }

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

      // --- ROUTE: Pobranie profilu (/api/me) ---
      if (url.pathname === "/api/me") {
        const user = await getSessionUser(request, env);
        if (!user) return jsonResponse({ authenticated: false });

        return jsonResponse({
          authenticated: true,
          user: {
            id: user.id,
            github_login: user.github_login,
            display_name: user.display_name,
            avatar_url: user.avatar_url,
            is_admin: user.is_admin,
            status: user.status
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

      // --- ROUTE: Lista Cykli Czasowych (/api/periods) ---
      if (url.pathname === "/api/periods") {
        const { results } = await env.DB.prepare(`
          SELECT id, type, name, start_date, end_date, status, is_locked, prize_description
          FROM periods
          ORDER BY CASE type WHEN 'SPRINT' THEN 1 WHEN 'MID_TERM' THEN 2 WHEN 'LONG_TERM' THEN 3 ELSE 4 END, id DESC
        `).all();
        return jsonResponse({ status: "success", data: results });
      }

      // --- ROUTE: Oficjalny Ranking z Podziałem na Horyzonty Czasowe (/api/leaderboard) ---
      if (url.pathname === "/api/leaderboard") {
        let periodId = url.searchParams.get("period_id");
        let activePeriod = null;

        if (periodId) {
          activePeriod = await env.DB.prepare("SELECT * FROM periods WHERE id = ?").bind(periodId).first();
        } else {
          // Domyślnie bierzemy aktywny SPRINT
          activePeriod = await env.DB.prepare("SELECT * FROM periods WHERE type = 'SPRINT' AND status = 'ACTIVE' ORDER BY id DESC LIMIT 1").first();
        }

        // Pobranie bieżących wycen portfela
        const query = `
          SELECT 
            u.id,
            u.github_login,
            u.display_name AS Uczestnik,
            u.avatar_url,
            u.status AS user_status,
            u.current_cash AS Gotowka_PLN,
            COALESCE(SUM(h.shares * p.price * p.fx_to_pln), 0) AS Wartosc_Akcji_PLN,
            (u.current_cash + COALESCE(SUM(h.shares * p.price * p.fx_to_pln), 0)) AS Wycena_Calkowita_PLN,
            COUNT(h.ticker) AS Liczba_Pozycji,
            ps.start_valuation_pln
          FROM users u
          LEFT JOIN holdings h ON u.id = h.user_id AND h.shares > 0
          LEFT JOIN market_prices p ON h.ticker = p.ticker
          LEFT JOIN period_snapshots ps ON ps.user_id = u.id AND ps.period_id = ?
          WHERE u.status != 'ALUMNI'
          GROUP BY u.id
        `;

        const targetPeriodId = activePeriod ? activePeriod.id : 0;
        const { results } = await env.DB.prepare(query).bind(targetPeriodId).all();
        const syncMeta = await env.DB.prepare("SELECT value FROM app_metadata WHERE key = 'last_price_sync'").first();

        const leaderboard = results.map(row => {
          // Baza do obliczenia zwrotu:
          // Jeśli gracz ma zarejestrowany snapshot w tym cyklu -> bierzemy start_valuation_pln
          // Jeśli nie (nowy gracz) -> baza to kapitał początkowy 100 000 zł, a gracz dostaje status ROOKIE
          const baseValuation = row.start_valuation_pln || 100000.0;
          const profit = row.Wycena_Calkowita_PLN - baseValuation;
          const returnPct = baseValuation > 0 ? (profit / baseValuation) : 0;
          const isRookie = !row.start_valuation_pln && !row.github_login.startsWith("benchmark");

          return {
            ...row,
            Baza_Wyceny_PLN: baseValuation,
            Zysk_Strata_PLN: profit,
            Stopa_Zwrotu: returnPct,
            is_rookie_in_period: isRookie
          };
        }).sort((a, b) => b.Stopa_Zwrotu - a.Stopa_Zwrotu);

        return jsonResponse({
          status: "success",
          period: activePeriod,
          data: leaderboard,
          last_sync: syncMeta ? syncMeta.value : null,
        });
      }

      // --- ROUTE: Portfel Gracza (/api/portfolio) ---
      if (url.pathname === "/api/portfolio") {
        const user = await getSessionUser(request, env);
        if (!user) return jsonResponse({ status: "error", message: "Wymagane logowanie" }, 401);

        const query = `
          SELECT 
            h.ticker, m.name, h.shares, h.avg_buy_price,
            m.price AS current_price, m.currency, m.fx_to_pln,
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

      // --- ROUTE: Wyszukiwarka instrumentów (/api/instruments/search) ---
      if (url.pathname === "/api/instruments/search") {
        const q = (url.searchParams.get("q") || "").trim().toUpperCase();
        if (!q) return jsonResponse({ status: "error", message: "Brak symbolu waloru" }, 400);

        const quote = await fetchYahooQuote(q);
        if (!quote) return jsonResponse({ status: "error", message: `Walor "${q}" nie został znaleziony.` }, 404);

        let fxRate = 1.0;
        if (quote.currency === "USD") {
          const usdQuote = await fetchYahooQuote("PLN=X");
          fxRate = usdQuote ? usdQuote.price : 4.0;
        }

        await env.DB.prepare(`
          INSERT INTO market_prices (ticker, name, price, currency, fx_to_pln, updated_at)
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(ticker) DO UPDATE SET price = excluded.price, fx_to_pln = excluded.fx_to_pln, updated_at = CURRENT_TIMESTAMP
        `).bind(quote.ticker, quote.name, quote.price, quote.currency, fxRate).run();

        return jsonResponse({
          status: "success",
          data: { ...quote, fx_to_pln: fxRate, price_pln: quote.price * fxRate },
        });
      }

      // --- ROUTE: Składanie zlecenia (/api/trade) ---
      if (url.pathname === "/api/trade" && request.method === "POST") {
        const user = await getSessionUser(request, env);
        if (!user) return jsonResponse({ status: "error", message: "Wymagane logowanie" }, 401);

        const { ticker, type, shares, thesis } = await request.json();
        if (!ticker || !["BUY", "SELL"].includes(type) || !shares || shares <= 0) {
          return jsonResponse({ status: "error", message: "Nieprawidłowe parametry zlecenia." }, 400);
        }

        if (!thesis || thesis.trim().length < 15) {
          return jsonResponse({ status: "error", message: "Teza inwestycyjna musi mieć min. 15 znaków!" }, 400);
        }

        const inst = await env.DB.prepare("SELECT * FROM market_prices WHERE ticker = ?").bind(ticker).first();
        if (!inst) return jsonResponse({ status: "error", message: "Walor nie istnieje w bazie." }, 400);

        const pricePln = inst.price * inst.fx_to_pln;
        const totalTradePln = shares * pricePln;

        const portSummary = await env.DB.prepare(`
          SELECT u.current_cash, COALESCE(SUM(h.shares * p.price * p.fx_to_pln), 0) AS stocks_value
          FROM users u
          LEFT JOIN holdings h ON u.id = h.user_id AND h.shares > 0
          LEFT JOIN market_prices p ON h.ticker = p.ticker
          WHERE u.id = ? GROUP BY u.id
        `).bind(user.id).first();

        const totalPortfolioValue = (portSummary.current_cash || 0) + (portSummary.stocks_value || 0);

        if (type === "BUY") {
          if (user.current_cash < totalTradePln) {
            return jsonResponse({ status: "error", message: `Brak środków. Dostępne: ${user.current_cash.toFixed(2)} zł, wymagane: ${totalTradePln.toFixed(2)} zł.` }, 400);
          }

          const existingHolding = await env.DB.prepare("SELECT shares FROM holdings WHERE user_id = ? AND ticker = ?").bind(user.id, ticker).first();
          const existingShares = existingHolding ? existingHolding.shares : 0;
          const postTradeTickerValue = (existingShares + shares) * pricePln;
          const exposurePct = (postTradeTickerValue / totalPortfolioValue) * 100;

          if (exposurePct > 35.01) {
            return jsonResponse({ status: "error", message: `Limit 35% przekroczony! Pozycja stanowiłaby ${exposurePct.toFixed(1)}% portfela.` }, 400);
          }

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
          return jsonResponse({ status: "success", message: "Zlecenie kupna zrealizowane!" });

        } else if (type === "SELL") {
          const existingHolding = await env.DB.prepare("SELECT shares FROM holdings WHERE user_id = ? AND ticker = ?").bind(user.id, ticker).first();
          if (!existingHolding || existingHolding.shares < shares) {
            return jsonResponse({ status: "error", message: "Nie posiadasz tylu akcji do sprzedaży." }, 400);
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
          return jsonResponse({ status: "success", message: "Zlecenie sprzedaży zrealizowane!" });
        }
      }

      // --- ROUTE: Feed zleceń (/api/feed) ---
      if (url.pathname === "/api/feed") {
        const query = `
          SELECT t.id, t.ticker, t.type, t.shares, t.price, t.total_value_pln, t.thesis, t.created_at,
                 u.display_name AS user_name, u.avatar_url
          FROM transactions t
          JOIN users u ON t.user_id = u.id
          ORDER BY t.created_at DESC
          LIMIT 25
        `;
        const { results } = await env.DB.prepare(query).all();
        return jsonResponse({ status: "success", data: results });
      }

      // --- ROUTE: Admin — Zarządzanie Cyklami Czasowymi (/api/admin/periods) ---
      if (url.pathname === "/api/admin/periods") {
        const user = await getSessionUser(request, env);
        if (!user || user.is_admin !== 1) return jsonResponse({ status: "error", message: "Brak uprawnień admina." }, 403);

        if (request.method === "POST") {
          const { type, name, start_date, end_date, prize_description } = await request.json();
          if (!type || !name || !start_date || !end_date) {
            return jsonResponse({ status: "error", message: "Wypełnij wszystkie pola okresu." }, 400);
          }

          const periodRes = await env.DB.prepare(`
            INSERT INTO periods (type, name, start_date, end_date, status, is_locked, prize_description)
            VALUES (?, ?, ?, ?, 'PENDING', 0, ?)
          `).bind(type, name, start_date, end_date, prize_description || "").run();

          await logAudit(env, user.id, "ADMIN_CREATE_PERIOD", { type, name, start_date, end_date }, clientIp, "SUCCESS");
          return jsonResponse({ status: "success", message: "Nowy okres został utworzony jako PENDING." });
        }
      }

      // --- ROUTE: Admin — Edycja Okresu (Z TWARDĄ BLOKADĄ PO STARCIE) ---
      if (url.pathname.startsWith("/api/admin/periods/") && request.method === "PUT") {
        const user = await getSessionUser(request, env);
        if (!user || user.is_admin !== 1) return jsonResponse({ status: "error", message: "Brak uprawnień admina." }, 403);

        const periodId = url.pathname.split("/").pop();
        const period = await env.DB.prepare("SELECT * FROM periods WHERE id = ?").bind(periodId).first();
        if (!period) return jsonResponse({ status: "error", message: "Okres nie istnieje." }, 404);

        // TWARDA ZASADA IMMUTABILITY: Blokada jakiejkolwiek modyfikacji po starcie
        const now = new Date();
        const startDate = new Date(period.start_date);

        if (period.status === "ACTIVE" || period.is_locked === 1 || now >= startDate) {
          return jsonResponse({ 
            status: "error", 
            message: "REGULAMIN LIGI: Okres już wystartował! Zgodnie z zasadami fair-play daty trwania aktywnego cyklu są zamrożone i nie można ich zmieniać po starcie." 
          }, 400);
        }

        const { name, start_date, end_date, prize_description } = await request.json();
        await env.DB.prepare(`
          UPDATE periods 
          SET name = COALESCE(?, name),
              start_date = COALESCE(?, start_date),
              end_date = COALESCE(?, end_date),
              prize_description = COALESCE(?, prize_description)
          WHERE id = ?
        `).bind(name, start_date, end_date, prize_description, periodId).run();

        await logAudit(env, user.id, "ADMIN_UPDATE_PERIOD", { periodId, start_date, end_date }, clientIp, "SUCCESS");
        return jsonResponse({ status: "success", message: "Parametry okresu zaktualizowane." });
      }

      // --- ROUTE: Admin — Rotacja Graczy (Status ACTIVE / ALUMNI) ---
      if (url.pathname === "/api/admin/users/status" && request.method === "POST") {
        const user = await getSessionUser(request, env);
        if (!user || user.is_admin !== 1) return jsonResponse({ status: "error", message: "Brak uprawnień admina." }, 403);

        const { target_user_id, status } = await request.json();
        if (!["ACTIVE", "ROOKIE", "ALUMNI"].includes(status)) {
          return jsonResponse({ status: "error", message: "Nieprawidłowy status użytkownika." }, 400);
        }

        await env.DB.prepare("UPDATE users SET status = ? WHERE id = ?").bind(status, target_user_id).run();
        await logAudit(env, user.id, "ADMIN_SET_USER_STATUS", { target_user_id, status }, clientIp, "SUCCESS");
        return jsonResponse({ status: "success", message: `Status użytkownika zmieniony na ${status}.` });
      }

      // --- ROUTE: Audyt (Admin) ---
      if (url.pathname === "/api/admin/audit") {
        const user = await getSessionUser(request, env);
        if (!user || user.is_admin !== 1) return jsonResponse({ status: "error", message: "Brak uprawnień." }, 403);

        const { results } = await env.DB.prepare(`
          SELECT a.id, a.action, a.payload, a.ip_address, a.status, a.created_at,
                 COALESCE(u.display_name, 'Niezalogowany / System') AS user_name
          FROM audit_log a
          LEFT JOIN users u ON a.user_id = u.id
          ORDER BY a.created_at DESC
          LIMIT 100
        `).all();
        return jsonResponse({ status: "success", data: results });
      }

      // --- ROUTE: Ręczna synchronizacja cen ---
      if (url.pathname === "/api/admin/sync-prices") {
        const user = await getSessionUser(request, env);
        if (!user || user.is_admin !== 1) return jsonResponse({ status: "error", message: "Brak uprawnień." }, 403);

        const logs = await syncAllMarketPrices(env);
        return jsonResponse({ status: "success", message: "Synchronizacja zakończona", logs });
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
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

async function getSessionUser(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/session_token=([^;]+)/);
  if (!match) return null;

  return await env.DB.prepare(`
    SELECT s.*, u.id, u.github_login, u.display_name, u.avatar_url, u.current_cash, u.is_admin, u.status
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > CURRENT_TIMESTAMP
  `).bind(match[1]).first();
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

async function fetchYahooQuote(symbol) {
  try {
    const cleanSym = symbol.trim().toUpperCase();
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cleanSym)}?interval=1d&range=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });

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

async function syncAllMarketPrices(env) {
  const logs = [];
  let usdPln = 4.0;
  const usdQuote = await fetchYahooQuote("PLN=X");
  if (usdQuote) usdPln = usdQuote.price;

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

  // Automatyczne sprawdzanie i otwieranie/zamykanie cykli
  await checkAndRotatePeriods(env);

  await env.DB.prepare(`
    INSERT INTO app_metadata (key, value, updated_at)
    VALUES ('last_price_sync', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
  `).run();

  return logs;
}

async function checkAndRotatePeriods(env) {
  // Aktywacja oczekujących cykli, które dotarły do start_date
  const pendingPeriods = await env.DB.prepare(
    "SELECT id FROM periods WHERE status = 'PENDING' AND start_date <= datetime('now')"
  ).all();

  for (const p of pendingPeriods.results) {
    await env.DB.prepare("UPDATE periods SET status = 'ACTIVE', is_locked = 1 WHERE id = ?").bind(p.id).run();
    // Utworzenie snapshotów dla wszystkich aktywnych graczy na dzwonek startowy
    await env.DB.prepare(`
      INSERT OR IGNORE INTO period_snapshots (period_id, user_id, start_valuation_pln)
      SELECT ?, u.id, (u.current_cash + COALESCE(SUM(h.shares * p.price * p.fx_to_pln), 0))
      FROM users u
      LEFT JOIN holdings h ON u.id = h.user_id AND h.shares > 0
      LEFT JOIN market_prices p ON h.ticker = p.ticker
      WHERE u.status = 'ACTIVE'
      GROUP BY u.id
    `).bind(p.id).run();
  }
}