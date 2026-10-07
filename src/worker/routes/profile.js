import { jsonResponse } from "../lib/http.js";
import { getSessionUser, logAudit } from "../lib/auth.js";

export async function handleProfileUpdate(context) {
  const { request, env, url, clientIp } = context;
  const user = await getSessionUser(request, env);
  if (!user) {
    return jsonResponse({ status: "error", message: "Wymagane logowanie" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ status: "error", message: "Nieprawidłowe dane profilu." }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ status: "error", message: "Nieprawidłowe dane profilu." }, 400);
  }

  const displayName = typeof body.display_name === "string" ? body.display_name.trim() : "";
  const avatarUrl = typeof body.avatar_url === "string" ? body.avatar_url.trim() : "";
  if (displayName.length < 2 || displayName.length > 30) {
    return jsonResponse({ status: "error", message: "Nazwa musi mieć od 2 do 30 znaków." }, 400);
  }

  let parsedAvatarUrl;
  try {
    parsedAvatarUrl = new URL(avatarUrl);
  } catch {
    return jsonResponse({ status: "error", message: "Nieprawidłowy adres awatara." }, 400);
  }
  if (parsedAvatarUrl.protocol !== "https:") {
    return jsonResponse({ status: "error", message: "Adres awatara musi używać HTTPS." }, 400);
  }

  await env.DB.prepare(
    "UPDATE users SET display_name = ?, avatar_url = ? WHERE id = ?"
  ).bind(displayName, avatarUrl, user.id).run();

  await logAudit(env, user.id, "PROFILE_UPDATED", { display_name: displayName }, clientIp, "SUCCESS");
  return jsonResponse({ status: "success", message: "Profil zaktualizowany." });
}
