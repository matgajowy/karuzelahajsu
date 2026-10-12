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
  const { results: transactions } = await env.DB.prepare(query).all();

  let news = [];
  try {
    const newsRes = await env.DB.prepare(`
      SELECT id, type, title, content, created_at
      FROM market_news
      ORDER BY created_at DESC, id DESC
      LIMIT 10
    `).all();
    news = newsRes?.results || [];
  } catch (err) {
    // Tabela market_news może jeszcze nie istnieć w testach
    news = [];
  }

  return jsonResponse({
    status: "success",
    data: transactions || [],
    news: news || [],
  });
}
