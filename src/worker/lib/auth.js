export async function getSessionUser(request, env) {
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

export async function logAudit(env, userId, action, payload, ip, status) {
  try {
    await env.DB.prepare(`
      INSERT INTO audit_log (user_id, action, payload, ip_address, status)
      VALUES (?, ?, ?, ?, ?)
    `).bind(userId, action, typeof payload === "string" ? payload : JSON.stringify(payload), ip, status).run();
  } catch (e) {
    console.error("Audit log error:", e);
  }
}
