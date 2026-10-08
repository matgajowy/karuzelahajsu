import { getSessionUser } from "../lib/auth.js";
import { jsonResponse } from "../lib/http.js";

export async function handleCurrentSession({ request, env }) {
  const user = await getSessionUser(request, env);
  if (!user) return jsonResponse({ authenticated: false });

  return jsonResponse({
    authenticated: true,
    auth_mode: user.auth_mode || "github",
    user: {
      id: user.id,
      github_login: user.github_login,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      is_admin: user.is_admin,
    },
  });
}
