import { jsonResponse } from "../lib/http.js";
import { getSessionUser, logAudit } from "../lib/auth.js";
import { syncAllMarketPrices } from "../services/pricing.js";

export async function handleAdminUsers(context) {
  const { request, env, clientIp } = context;
  const user = await getSessionUser(request, env);
  if (!user || user.is_admin !== 1) {
    return jsonResponse({ status: "error", message: "Brak uprawnień administratora." }, 403);
  }

  if (request.method === "GET") {
    const { results } = await env.DB.prepare(`
      SELECT id, github_login, display_name, current_cash, is_admin
      FROM users
      ORDER BY display_name COLLATE NOCASE
    `).all();
    return jsonResponse({ status: "success", data: results });
  }

  if (request.method !== "POST") {
    return jsonResponse({ status: "error", message: "Metoda niedozwolona." }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ status: "error", message: "Nieprawidłowe dane użytkownika." }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ status: "error", message: "Nieprawidłowe dane użytkownika." }, 400);
  }

  const githubLogin = typeof body.github_login === "string" ? body.github_login.trim() : "";
  const displayName = typeof body.display_name === "string" ? body.display_name.trim() : "";
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(githubLogin)) {
    return jsonResponse({ status: "error", message: "Nieprawidłowy login GitHub." }, 400);
  }
  if (displayName.length < 2 || displayName.length > 30) {
    return jsonResponse({ status: "error", message: "Nazwa wyświetlana musi mieć od 2 do 30 znaków." }, 400);
  }

  const existing = await env.DB.prepare(
    "SELECT id FROM users WHERE github_login = ?"
  ).bind(githubLogin).first();
  if (existing) {
    return jsonResponse({ status: "error", message: "Ten login GitHub jest już na liście." }, 409);
  }

  const isAdmin = body.is_admin === true ? 1 : 0;
  await env.DB.prepare(
    "INSERT INTO users (github_login, display_name, is_admin) VALUES (?, ?, ?)"
  ).bind(githubLogin, displayName, isAdmin).run();

  await logAudit(env, user.id, "ADMIN_USER_ADDED", { github_login: githubLogin, is_admin: isAdmin }, clientIp, "SUCCESS");
  return jsonResponse({ status: "success", message: "Użytkownik dodany do ligi." }, 201);
}

export async function handleAuditLogs(context) {
  const { request, env, url, clientIp } = context;
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

export async function handlePriceSync(context) {
  const { request, env, url, clientIp } = context;
  const user = await getSessionUser(request, env);
  if (!user || user.is_admin !== 1) {
    return jsonResponse({ status: "error", message: "Brak uprawnień administratora." }, 403);
  }

  const syncLogs = await syncAllMarketPrices(env);
  return jsonResponse({ status: "success", message: "Synchronizacja zakończona", logs: syncLogs });
}
