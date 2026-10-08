import { jsonResponse } from "../lib/http.js";
import { getSessionUser, logAudit } from "../lib/auth.js";

const fallbackNicknames = [
  "Wilk z Mordoru",
  "Królowa Dywidendy",
  "Łowca Dołków",
  "Doktor Short",
  "Spekulant Biurowy",
  "Rekin z Parkietu",
  "Książę GPW",
];

const nicknamePrompt = `Rola: Generator prześmiewczych ksywek giełdowych.
Zadanie: Wygeneruj dokładnie JEDNĄ unikalną, 2-3 wyrazową polską ksywkę dla biurowego gracza inwestycyjnego (styl: Wilk z Mordoru, Królowa Dywidendy, Łowca Dołków, Doktor Short, Spekulant z Open Space'a). Zwróć wyłącznie sam tekst ksywki, bez cudzysłowów, kropek i zbędnych słów.`;

function validateGeneratedNickname(value) {
  if (typeof value !== "string") return null;
  const nickname = value
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
  const words = nickname.split(" ");
  if (nickname.length < 2 || nickname.length > 30 || words.length < 2 || words.length > 3) return null;
  if (!/^[\p{L}\p{M}\p{N}'’-]+(?: [\p{L}\p{M}\p{N}'’-]+){1,2}$/u.test(nickname)) return null;
  return nickname;
}

export async function handleGenerateNickname({ request, env }) {
  const user = await getSessionUser(request, env);
  if (!user) {
    return jsonResponse({ status: "error", message: "Wymagane logowanie." }, 401);
  }

  if (!env.AI || typeof env.AI.run !== "function") {
    console.error("Workers AI binding is unavailable; using nickname fallback.");
    return jsonResponse({
      status: "success",
      data: { nickname: fallbackNicknames[Math.floor(Math.random() * fallbackNicknames.length)], fallback: true },
    });
  }

  let timeoutId;
  try {
    const result = await Promise.race([
      env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [{ role: "user", content: nicknamePrompt }],
        max_tokens: 40,
      }),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Workers AI nickname request timed out.")), 5000);
      }),
    ]);
    const response = typeof result === "string" ? result : result?.response;
    const nickname = validateGeneratedNickname(response);
    if (!nickname) throw new Error("Workers AI returned an invalid nickname.");
    return jsonResponse({ status: "success", data: { nickname, fallback: false } });
  } catch (error) {
    console.error("Workers AI nickname generation failed; using fallback.", error);
    return jsonResponse({
      status: "success",
      data: { nickname: fallbackNicknames[Math.floor(Math.random() * fallbackNicknames.length)], fallback: true },
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

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
