import { jsonResponse } from "../lib/http.js";

export async function handleFeed(context) {
  const { request, env, url, clientIp } = context;
  const query = `
    SELECT
      t.id,
      t.ticker,
      t.type,
      t.shares,
      t.price,
      t.total_value_pln,
      t.thesis,
      t.created_at,
      u.display_name AS user_name,
      u.avatar_url
    FROM transactions t
    JOIN users u ON t.user_id = u.id
    ORDER BY t.created_at DESC
    LIMIT 25
  `;
  const { results } = await env.DB.prepare(query).all();
  return jsonResponse({ status: "success", data: results });
}
