import { logAudit } from "../lib/auth.js";

export async function handleGitHubLogin(context) {
  const { request, env, url, clientIp } = context;
  const clientId = env.GITHUB_CLIENT_ID;
  if (!clientId || clientId === "DEV_OAUTH_CLIENT_ID") {
    return new Response("GitHub OAuth nie jest skonfigurowany dla tego środowiska.", { status: 503 });
  }

  const redirectUri = `${url.origin}/api/auth/callback`;
  const state = crypto.randomUUID();

  const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=read:user`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: githubAuthUrl,
      "Set-Cookie": `oauth_state_${state}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`,
    },
  });
}

export async function handleGitHubCallback(context) {
  const { request, env, url, clientIp } = context;
  const state = url.searchParams.get("state");
  if (!state || !/^[a-f0-9-]{36}$/i.test(state)) {
    return new Response("Błąd bezpieczeństwa (brak lub nieprawidłowy parametr state)", { status: 403 });
  }

  const cookieHeader = request.headers.get("Cookie") || "";
  const stateCookieName = `oauth_state_${state}`;
  const stateCookie = cookieHeader
    .split(";")
    .map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith(`${stateCookieName}=`));
  if (stateCookie?.slice(stateCookieName.length + 1) !== state) {
    return new Response("Błąd bezpieczeństwa (CSRF State Mismatch)", { status: 403 });
  }

  const code = url.searchParams.get("code");
  if (!code) return new Response("Brak kodu autoryzacji z GitHuba", { status: 400 });
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return new Response("GitHub OAuth nie jest skonfigurowany dla tego środowiska.", { status: 503 });
  }

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
      redirect_uri: `${url.origin}/api/auth/callback`,
    }),
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    return new Response(
      `Błąd autoryzacji z GitHubem (${tokenData.error || "unknown"}): ${tokenData.error_description || "Brak tokena"}`,
      { status: 401 }
    );
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

  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", `session_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600; Secure`);
  headers.append("Set-Cookie", `oauth_state_${state}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  return new Response(null, { status: 302, headers });
}
