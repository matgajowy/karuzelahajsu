import { jsonResponse } from "../lib/http.js";

export async function handleLogout(context) {
  const { request, env, url, clientIp } = context;
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
