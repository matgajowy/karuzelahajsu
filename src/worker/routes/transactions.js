import { jsonResponse } from "../lib/http.js";
import { getSessionUser } from "../lib/auth.js";

export async function handleMyTransactions({ request, env }) {
  const user = await getSessionUser(request, env);
  if (!user) return jsonResponse({ status: "error", message: "Wymagane logowanie" }, 401);

  const { results } = await env.DB.prepare(`
    SELECT
      t.id,
      t.ticker,
      t.type,
      t.shares,
      t.price,
      t.total_value_pln AS total_value_ck,
      t.thesis,
      t.ai_roast,
      t.created_at,
      COALESCE(p.name, t.ticker) AS company_name,
      COALESCE(p.currency, 'PLN') AS currency
    FROM transactions t
    LEFT JOIN market_prices p ON t.ticker = p.ticker
    WHERE t.user_id = ?
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT 20
  `).bind(user.id).all();

  return jsonResponse({ status: "success", data: results });
}
