async function syncMarketPrices(env) {
  const log = [];
  let usdPlnRate = 4.00;

  try {
    const fxRes = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/USDPLN=X?interval=1d&range=1d", {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const fxData = await fxRes.json();
    usdPlnRate = fxData.chart.result[0].meta.regularMarketPrice || usdPlnRate;
    log.push(`FX USD/PLN: ${usdPlnRate}`);
  } catch (e) {
    log.push(`Błąd FX, fallback: ${usdPlnRate}`);
  }

  const { results: tickers } = await env.DB.prepare("SELECT ticker, currency FROM market_prices").all();

  for (const item of tickers) {
    try {
      const yahooSymbol = item.ticker === "WIG20" ? "WIG20.WA" : item.ticker;
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=1d`, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      const data = await res.json();
      const currentPrice = data.chart?.result?.[0]?.meta?.regularMarketPrice;

      if (currentPrice && Number.isFinite(currentPrice)) {
        const fx = item.currency === "USD" ? usdPlnRate : 1.0;
        await env.DB.prepare(`
          UPDATE market_prices 
          SET price = ?, fx_to_pln = ?, updated_at = CURRENT_TIMESTAMP 
          WHERE ticker = ?
        `).bind(currentPrice, fx, item.ticker).run();
        log.push(`${item.ticker}: ${currentPrice} ${item.currency}`);
      }
    } catch (err) {
      log.push(`Błąd ${item.ticker}: ${err.message}`);
    }
  }

  return log;
}

// Funkcja pomocnicza do pobrania aktualnego kursu USD/PLN
async function getUsdPlnRate() {
  try {
    const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/USDPLN=X?interval=1d&range=1d", {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const data = await res.json();
    return data.chart?.result?.[0]?.meta?.regularMarketPrice || 4.00;
  } catch {
    return 4.00;
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncMarketPrices(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const clientIp = request.headers.get("cf-connecting-ip") || "unknown";
    const userAgent = request.headers.get("user-agent") || "unknown";

    const corsHeaders = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": url.origin,
      "Access-Control-Allow-Credentials": "true"
    };

    async function getAuthenticatedUser() {
      const cookieHeader = request.headers.get("Cookie") || "";
      const match = cookieHeader.match(/session=([a-zA-Z0-9_-]+)/);
      if (!match) return null;

      const token = match[1];
      return await env.DB.prepare(`
        SELECT u.id, u.github_login, u.display_name, u.current_cash, u.is_admin 
        FROM sessions s 
        JOIN users u ON s.user_id = u.id 
        WHERE s.token = ? AND s.expires_at > datetime('now')
      `).bind(token).first();
    }

    async function logAudit(userId, action, payload, status) {
      try {
        await env.DB.prepare(`
          INSERT INTO audit_log (user_id, action, payload, ip_address, status) 
          VALUES (?, ?, ?, ?, ?)
        `).bind(userId, action, JSON.stringify(payload), clientIp, status).run();
      } catch (e) {
        console.error("Audit error:", e);
      }
    }

    // --- WYSZUKIWARKA I WALIDACJA TICKERÓW LIVE (/api/instruments/search) ---
    if (url.pathname === "/api/instruments/search") {
      const q = (url.searchParams.get("q") || "").trim().toUpperCase();
      if (!q || q.length < 1 || q.length > 15) {
        return new Response(JSON.stringify({ status: "error", message: "Podaj prawidłowy ticker (1-15 znaków)." }), { status: 400, headers: corsHeaders });
      }

      try {
        // 1. Sprawdź, czy walor istnieje w Yahoo Finance
        const yahooRes = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(q)}?interval=1d&range=1d`, {
          headers: { "User-Agent": "Mozilla/5.0" }
        });

        if (!yahooRes.ok) {
          return new Response(JSON.stringify({ status: "error", message: `Symbol "${q}" nie został znaleziony na rynku.` }), { status: 404, headers: corsHeaders });
        }

        const data = await yahooRes.json();
        const meta = data.chart?.result?.[0]?.meta;

        if (!meta || !meta.regularMarketPrice) {
          return new Response(JSON.stringify({ status: "error", message: `Brak aktualnych kwotowań dla instrumentu "${q}".` }), { status: 404, headers: corsHeaders });
        }

        // 2. Walidacja typu instrumentu: dopuszczamy akcje i ETF-y
        const instType = (meta.instrumentType || "").toUpperCase();
        if (instType && !["EQUITY", "ETF", "MUTUALFUND"].includes(instType)) {
          return new Response(JSON.stringify({ 
            status: "error", 
            message: `Instrument typu ${instType} jest niedozwolony. Regulamin dopuszcza wyłącznie akcje (EQUITY) oraz fundusze ETF.` 
          }), { status: 400, headers: corsHeaders });
        }

        const currency = (meta.currency || "USD").toUpperCase();
        const price = meta.regularMarketPrice;
        const shortName = meta.shortName || meta.symbol;

        // Ustalenie kursu FX
        let fxRate = 1.0;
        if (currency === "USD") {
          fxRate = await getUsdPlnRate();
        } else if (currency !== "PLN") {
          return new Response(JSON.stringify({ status: "error", message: `Waluta ${currency} nie jest obecnie obsługiwana (wspieramy PLN i USD).` }), { status: 400, headers: corsHeaders });
        }

        // 3. Dynamiczne zarejestrowanie waloru w bazie market_prices
        await env.DB.prepare(`
          INSERT INTO market_prices (ticker, name, price, currency, fx_to_pln, updated_at)
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(ticker) DO UPDATE SET
            price = excluded.price,
            fx_to_pln = excluded.fx_to_pln,
            updated_at = CURRENT_TIMESTAMP
        `).bind(q, shortName, price, currency, fxRate).run();

        return new Response(JSON.stringify({
          status: "success",
          data: {
            ticker: q,
            name: shortName,
            price,
            currency,
            fx_to_pln: fxRate,
            price_pln: price * fxRate
          }
        }), { headers: corsHeaders });

      } catch (err) {
        return new Response(JSON.stringify({ status: "error", message: `Błąd weryfikacji waloru: ${err.message}` }), { status: 500, headers: corsHeaders });
      }
    }

    // --- ADMIN: RĘCZNY SYNC KURSÓW ---
    if (url.pathname === "/api/admin/sync-prices") {
      const user = await getAuthenticatedUser();
      if (!user || user.is_admin !== 1) {
        return new Response(JSON.stringify({ status: "error", message: "Wymagany admin." }), { status: 403, headers: corsHeaders });
      }
      const logs = await syncMarketPrices(env);
      return new Response(JSON.stringify({ status: "success", logs }), { headers: corsHeaders });
    }

    // --- ADMIN: AUDYT ---
    if (url.pathname === "/api/admin/audit") {
      const user = await getAuthenticatedUser();
      if (!user || user.is_admin !== 1) {
        return new Response(JSON.stringify({ status: "error", message: "Brak uprawnień." }), { status: 403, headers: corsHeaders });
      }
      const { results } = await env.DB.prepare(`
        SELECT a.id, COALESCE(u.display_name, 'Gość') AS user_name, a.action, a.payload, a.ip_address, a.status, a.created_at
        FROM audit_log a LEFT JOIN users u ON a.user_id = u.id ORDER BY a.created_at DESC LIMIT 50
      `).all();
      return new Response(JSON.stringify({ status: "success", data: results }), { headers: corsHeaders });
    }

    // --- FEED TRANSAKCJI ---
    if (url.pathname === "/api/feed") {
      const { results } = await env.DB.prepare(`
        SELECT t.id, u.display_name AS user_name, t.ticker, t.type, t.shares, t.price, t.total_value_pln, t.thesis, t.created_at
        FROM transactions t JOIN users u ON t.user_id = u.id ORDER BY t.created_at DESC LIMIT 20
      `).all();
      return new Response(JSON.stringify({ status: "success", data: results }), { headers: corsHeaders });
    }

    // --- AUTH GITHUB ---
    if (url.pathname === "/api/auth/github") {
      const clientId = env.GITHUB_CLIENT_ID;
      if (!clientId) return new Response("Brak GITHUB_CLIENT_ID", { status: 500 });
      const state = crypto.randomUUID();
      const redirectUri = `${url.origin}/api/auth/callback`;
      const githubUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read:user&state=${state}`;

      return new Response(null, {
        status: 302,
        headers: {
          "Location": githubUrl,
          "Set-Cookie": `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300`
        }
      });
    }

    // --- AUTH CALLBACK ---
    if (url.pathname === "/api/auth/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const cookieHeader = request.headers.get("Cookie") || "";
      const stateMatch = cookieHeader.match(/oauth_state=([a-zA-Z0-9_-]+)/);

      if (!stateMatch || stateMatch[1] !== state) {
        return new Response("CSRF Mismatch", { status: 403 });
      }

      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code
        })
      });
      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) return new Response("Błąd OAuth", { status: 400 });

      const userRes = await fetch("https://api.github.com/user", {
        headers: { "Authorization": `Bearer ${tokenData.access_token}`, "User-Agent": "Karuzela-Hajsu-App" }
      });
      const ghUser = await userRes.json();

      const dbUser = await env.DB.prepare(
        "SELECT id, github_login, display_name FROM users WHERE LOWER(github_login) = LOWER(?)"
      ).bind(ghUser.login).first();

      if (!dbUser) {
        await logAudit(null, "LOGIN_REJECTED", { login: ghUser.login }, "FORBIDDEN");
        return new Response(`Brak dostępu: Użytkownik "${ghUser.login}" nie znajduje się na liście uczestników gry.`, { status: 403 });
      }

      const sessionToken = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      await env.DB.prepare(`
        INSERT INTO sessions (token, user_id, ip_address, user_agent, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(sessionToken, dbUser.id, clientIp, userAgent, expiresAt).run();

      await logAudit(dbUser.id, "LOGIN_SUCCESS", { login: ghUser.login }, "SUCCESS");

      return new Response(null, {
        status: 302,
        headers: {
          "Location": "/",
          "Set-Cookie": `session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
        }
      });
    }

    // --- PROFIL ---
    if (url.pathname === "/api/me") {
      const user = await getAuthenticatedUser();
      if (!user) return new Response(JSON.stringify({ authenticated: false }), { headers: corsHeaders });
      return new Response(JSON.stringify({ authenticated: true, user }), { headers: corsHeaders });
    }

    // --- WYLOGOWANIE ---
    if (url.pathname === "/api/logout" && request.method === "POST") {
      const cookieHeader = request.headers.get("Cookie") || "";
      const match = cookieHeader.match(/session=([a-zA-Z0-9_-]+)/);
      if (match) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(match[1]).run();

      return new Response(JSON.stringify({ status: "success" }), {
        headers: { ...corsHeaders, "Set-Cookie": "session=; Path=/; Max-Age=0" }
      });
    }

    // --- INSTRUMENTY (Z CACHE BAZY) ---
    if (url.pathname === "/api/instruments") {
      const { results } = await env.DB.prepare(
        "SELECT ticker, name, price, currency, fx_to_pln, (price * fx_to_pln) AS price_pln FROM market_prices WHERE ticker NOT IN ('^GSPC', 'WIG20') ORDER BY ticker ASC"
      ).all();
      return new Response(JSON.stringify({ status: "success", data: results }), { headers: corsHeaders });
    }

    // --- PORTFEL ---
    if (url.pathname === "/api/portfolio") {
      const user = await getAuthenticatedUser();
      if (!user) return new Response(JSON.stringify({ status: "error", message: "Wymagane logowanie" }), { status: 401, headers: corsHeaders });

      const query = `
        SELECT 
          h.ticker,
          m.name,
          h.shares,
          h.avg_buy_price,
          m.price AS current_price,
          m.currency,
          (h.shares * m.price * m.fx_to_pln) AS current_value_pln,
          (((m.price - h.avg_buy_price) / h.avg_buy_price) * 100) AS return_pct
        FROM holdings h
        JOIN market_prices m ON h.ticker = m.ticker
        WHERE h.user_id = ? AND h.shares > 0
      `;
      const { results } = await env.DB.prepare(query).bind(user.id).all();
      return new Response(JSON.stringify({ status: "success", data: results, cash: user.current_cash }), { headers: corsHeaders });
    }

    // --- TRANSAKCJE Z LIMITAMI ---
    if (url.pathname === "/api/trade" && request.method === "POST") {
      const user = await getAuthenticatedUser();
      if (!user) return new Response(JSON.stringify({ status: "error", message: "Brak autoryzacji" }), { status: 401, headers: corsHeaders });

      try {
        const { ticker, type, shares, thesis } = await request.json();

        if (!ticker || typeof ticker !== "string") throw new Error("Nieprawidłowy ticker.");
        if (type !== "BUY" && type !== "SELL") throw new Error("Typ zlecenia: BUY lub SELL.");
        const parsedShares = Number(shares);
        if (!Number.isFinite(parsedShares) || parsedShares <= 0) throw new Error("Liczba akcji musi być > 0.");
        
        if (!thesis || typeof thesis !== "string" || thesis.trim().length < 15) {
          throw new Error("Regulamin: Uzasadnienie transakcji musi mieć co najmniej 15 znaków.");
        }

        const cleanTicker = ticker.toUpperCase();

        // Sprawdzenie obecności w zaufanym market_prices
        const market = await env.DB.prepare(
          "SELECT price, fx_to_pln FROM market_prices WHERE ticker = ?"
        ).bind(cleanTicker).first();

        if (!market) throw new Error(`Instrument ${cleanTicker} nie został jeszcze zweryfikowany. Wyszukaj go najpierw w wyszukiwarce zleceń.`);

        const tradeValuePLN = parsedShares * market.price * market.fx_to_pln;

        const portfolioValRes = await env.DB.prepare(`
          SELECT (u.current_cash + COALESCE(SUM(h.shares * p.price * p.fx_to_pln), 0)) as total_val
          FROM users u
          LEFT JOIN holdings h ON u.id = h.user_id AND h.shares > 0
          LEFT JOIN market_prices p ON h.ticker = p.ticker
          WHERE u.id = ? GROUP BY u.id
        `).bind(user.id).first();

        const totalPortfolioValue = portfolioValRes ? portfolioValRes.total_val : user.current_cash;

        if (type === "BUY") {
          const currentHolding = await env.DB.prepare(
            "SELECT shares FROM holdings WHERE user_id = ? AND ticker = ?"
          ).bind(user.id, cleanTicker).first();

          const existingShares = currentHolding ? currentHolding.shares : 0;
          const targetValuePLN = (existingShares + parsedShares) * market.price * market.fx_to_pln;

          const maxAllowedExposure = totalPortfolioValue * 0.35;
          if (targetValuePLN > maxAllowedExposure) {
            const limitPct = ((targetValuePLN / totalPortfolioValue) * 100).toFixed(1);
            throw new Error(`Limit dywersyfikacji: Pozycja wynosiłaby ${limitPct}% portfela (maksimum to 35.0%).`);
          }

          const cashUpdate = await env.DB.prepare(`
            UPDATE users SET current_cash = current_cash - ? WHERE id = ? AND current_cash >= ?
          `).bind(tradeValuePLN, user.id, tradeValuePLN).run();

          if (cashUpdate.meta.changes === 0) {
            throw new Error("Niewystarczające saldo gotówki.");
          }

          await env.DB.batch([
            env.DB.prepare(`
              INSERT INTO holdings (user_id, ticker, shares, avg_buy_price) 
              VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id, ticker) DO UPDATE SET
                avg_buy_price = ((holdings.shares * holdings.avg_buy_price) + (? * ?)) / (holdings.shares + ?),
                shares = holdings.shares + ?
            `).bind(user.id, cleanTicker, parsedShares, market.price, parsedShares, market.price, parsedShares, parsedShares),
            env.DB.prepare(`
              INSERT INTO transactions (user_id, ticker, type, shares, price, total_value_pln, thesis)
              VALUES (?, ?, 'BUY', ?, ?, ?, ?)
            `).bind(user.id, cleanTicker, parsedShares, market.price, tradeValuePLN, thesis.trim())
          ]);

        } else if (type === "SELL") {
          const holdingUpdate = await env.DB.prepare(`
            UPDATE holdings SET shares = shares - ? WHERE user_id = ? AND ticker = ? AND shares >= ?
          `).bind(parsedShares, user.id, cleanTicker, parsedShares).run();

          if (holdingUpdate.meta.changes === 0) {
            throw new Error("Brak wystarczającej liczby akcji do sprzedaży.");
          }

          await env.DB.batch([
            env.DB.prepare("UPDATE users SET current_cash = current_cash + ? WHERE id = ?").bind(tradeValuePLN, user.id),
            env.DB.prepare(`
              INSERT INTO transactions (user_id, ticker, type, shares, price, total_value_pln, thesis)
              VALUES (?, ?, 'SELL', ?, ?, ?, ?)
            `).bind(user.id, cleanTicker, parsedShares, market.price, tradeValuePLN, thesis.trim())
          ]);
        }

        await logAudit(user.id, `TRADE_${type}`, { ticker: cleanTicker, shares: parsedShares, value: tradeValuePLN, thesis }, "SUCCESS");
        return new Response(JSON.stringify({ status: "success", message: `Zlecenie ${type} na ${cleanTicker} wykonane!` }), { headers: corsHeaders });

      } catch (err) {
        await logAudit(user.id, "TRADE_ERROR", { error: err.message }, "FAILED");
        return new Response(JSON.stringify({ status: "error", message: err.message }), { status: 400, headers: corsHeaders });
      }
    }

    // --- RANKING ---
    if (url.pathname === "/api/leaderboard") {
      try {
        const query = `
          SELECT 
            u.display_name AS Uczestnik,
            u.current_cash AS Gotowka_PLN,
            COALESCE(SUM(h.shares * p.price * p.fx_to_pln), 0) AS Wartosc_Akcji_PLN,
            (u.current_cash + COALESCE(SUM(h.shares * p.price * p.fx_to_pln), 0)) AS Wycena_Calkowita_PLN,
            COUNT(CASE WHEN h.shares > 0 THEN 1 END) AS Liczba_Pozycji
          FROM users u
          LEFT JOIN holdings h ON u.id = h.user_id AND h.shares > 0
          LEFT JOIN market_prices p ON h.ticker = p.ticker
          GROUP BY u.id
        `;

        const { results } = await env.DB.prepare(query).all();

        const leaderboard = results.map(row => {
          const profit = row.Wycena_Calkowita_PLN - 100000;
          return {
            ...row,
            Zysk_Strata_PLN: profit,
            Stopa_Zwrotu: profit / 100000
          };
        }).sort((a, b) => b.Stopa_Zwrotu - a.Stopa_Zwrotu);

        return new Response(JSON.stringify({ status: "success", data: leaderboard }), { headers: corsHeaders });
      } catch (error) {
        return new Response(JSON.stringify({ status: "error", message: error.message }), { status: 500, headers: corsHeaders });
      }
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  }
};