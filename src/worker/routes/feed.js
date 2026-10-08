import { jsonResponse } from "../lib/http.js";

export async function handleFeed(context) {
  const { request, env, url, clientIp } = context;
  const query = `
    SELECT
      t.*,
      t.total_value_pln AS total_value_ck,
      u.display_name AS user_name,
      u.avatar_url,
      COALESCE(p.name, t.ticker) AS company_name
    FROM transactions t
    JOIN users u ON t.user_id = u.id
    LEFT JOIN market_prices p ON t.ticker = p.ticker
    ORDER BY t.created_at DESC
    LIMIT 20
  `;
  const { results } = await env.DB.prepare(query).all();
  return jsonResponse({ status: "success", data: results });
}
