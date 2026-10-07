export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const clientIp = request.headers.get("cf-connecting-ip") || "unknown";
    const userAgent = request.headers.get("user-agent") || "unknown";

    const corsHeaders = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": url.origin,
      "Access-Control-Allow-Credentials": "true"
    };

    // Helper: pobranie zalogowanego usera z ciasteczka sesyjnego
    async function getAuthenticatedUser() {
      const cookieHeader = request.headers.get("Cookie") || "";
      const match = cookieHeader.match(/session=([a-zA-Z0-9_-]+)/);
      if (!match) return null;

      const token = match[1];
      const session = await env.DB.prepare(`
        SELECT u.id, u.github_login, u.display_name, u.current_cash, u.is_admin 
        FROM sessions s 
        JOIN users u ON s.user_id = u.id 
        WHERE s.token = ? AND s.expires_at > datetime('now')
      `).bind(token).first();

      return session || null;
    }

    // Helper: Audyt operacji
    async function logAudit(userId, action, payload, status) {
      try {
        await env.DB.prepare(`
          INSERT INTO audit_log (user_id, action, payload, ip_address, status) 
          VALUES (?, ?, ?, ?, ?)
        `).bind(userId, action, JSON.stringify(payload), clientIp, status).run();
      } catch (e) {
        console.error("Audit log error:", e);
      }
    }

    // -------------------------------------------------------------
    // 1. GITHUB OAUTH: Start logowania (/api/auth/github)
    // -------------------------------------------------------------
    if (url.pathname === "/api/auth/github") {
      if (!env.GITHUB_CLIENT_ID) {
        return new Response("Błąd: brak zmiennej GITHUB_CLIENT_ID w Cloudflare.", { status: 500 });
      }

      const state = crypto.randomUUID();
      const redirectUri = `${url.origin}/api/auth/callback`;
      const githubUrl = `https://github.com/login/oauth/authorize?client_id=${env.GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read:user&state=${state}`;

      return new Response(null, {
        status: 302,
        headers: {
          "Location": githubUrl,
          "Set-Cookie": `oauth_state_${state}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`
        }
      });
    }

    // -------------------------------------------------------------
    // 2. GITHUB OAUTH: Powrót z GitHuba (/api/auth/callback)
    // -------------------------------------------------------------
    if (url.pathname === "/api/auth/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const redirectUri = `${url.origin}/api/auth/callback`;

      if (!state || !/^[a-f0-9-]{36}$/i.test(state)) {
        return new Response("Błąd bezpieczeństwa (brak lub nieprawidłowy parametr state)", { status: 403 });
      }

      const cookieHeader = request.headers.get("Cookie") || "";
      const stateCookieName = `oauth_state_${state}`;
      const stateCookie = cookieHeader
        .split(";")
        .map(cookie => cookie.trim())
        .find(cookie => cookie.startsWith(`${stateCookieName}=`));
      const storedState = stateCookie?.slice(stateCookieName.length + 1);

      if (storedState !== state) {
        return new Response("Błąd bezpieczeństwa (CSRF State Mismatch)", { status: 403 });
      }

      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
        const missing = [
          !env.GITHUB_CLIENT_ID && "GITHUB_CLIENT_ID",
          !env.GITHUB_CLIENT_SECRET && "GITHUB_CLIENT_SECRET"
        ].filter(Boolean).join(", ");
        return new Response(`Błąd konfiguracji OAuth w Workerze: brak ${missing}.`, { status: 500 });
      }

      // Wymiana kodu autoryzacyjnego na access token
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: redirectUri
        })
      });

      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) {
        console.error("GitHub OAuth token exchange failed", {
          error: tokenData.error || "unknown",
          status: tokenRes.status,
          hasClientId: Boolean(env.GITHUB_CLIENT_ID),
          hasClientSecret: Boolean(env.GITHUB_CLIENT_SECRET)
        });
        return new Response(
          `Błąd autoryzacji z GitHubem (${tokenData.error || "unknown"}): ${tokenData.error_description || "Brak tokena"}`,
          { status: 400 }
        );
      }

      // Pobranie loginu z API GitHuba
      const userRes = await fetch("https://api.github.com/user", {
        headers: {
          "Authorization": `Bearer ${tokenData.access_token}`,
          "User-Agent": "Karuzela-Hajsu-App"
        }
      });
      const ghUser = await userRes.json();

      // Weryfikacja czy login jest na białej liście w tabeli users
      const dbUser = await env.DB.prepare(
        "SELECT id, github_login, display_name FROM users WHERE LOWER(github_login) = LOWER(?)"
      ).bind(ghUser.login).first();

      if (!dbUser) {
        await logAudit(null, "LOGIN_REJECTED", { login: ghUser.login }, "FORBIDDEN");
        return new Response(`Brak dostępu: Użytkownik "${ghUser.login}" nie znajduje się na liście uczestników gry. Poproś o dodanie w bazie.`, { status: 403 });
      }

      // Utworzenie sesji (ważna 30 dni)
      const sessionToken = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      await env.DB.prepare(`
        INSERT INTO sessions (token, user_id, ip_address, user_agent, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(sessionToken, dbUser.id, clientIp, userAgent, expiresAt).run();

      await logAudit(dbUser.id, "LOGIN_SUCCESS", { login: ghUser.login }, "SUCCESS");

      const cookie = `session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;

      return new Response(null, {
        status: 302,
        headers: {
          "Location": "/",
          "Set-Cookie": cookie
        }
      });
    }

    // -------------------------------------------------------------
    // 3. Stan zalogowanego użytkownika (/api/me)
    // -------------------------------------------------------------
    if (url.pathname === "/api/me") {
      const user = await getAuthenticatedUser();
      if (!user) {
        return new Response(JSON.stringify({ authenticated: false }), { headers: corsHeaders });
      }
      return new Response(JSON.stringify({ authenticated: true, user }), { headers: corsHeaders });
    }

    // -------------------------------------------------------------
    // 4. Wylogowanie (/api/logout)
    // -------------------------------------------------------------
    if (url.pathname === "/api/logout" && request.method === "POST") {
      const cookieHeader = request.headers.get("Cookie") || "";
      const match = cookieHeader.match(/session=([a-zA-Z0-9_-]+)/);
      if (match) {
        await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(match[1]).run();
      }
      return new Response(JSON.stringify({ status: "success" }), {
        headers: {
          ...corsHeaders,
          "Set-Cookie": "session=; Path=/; Max-Age=0"
        }
      });
    }

    // -------------------------------------------------------------
    // 5. Ranking ligi (/api/leaderboard)
    // -------------------------------------------------------------
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

    // -------------------------------------------------------------
    // 6. Pliki statyczne (index.html)
    // -------------------------------------------------------------
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  }
};