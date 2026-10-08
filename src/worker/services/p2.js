import { jsonResponse } from "../lib/http.js";

export async function handleOpponentPortfolio({ env, url }) {
  const userId = Number(url.searchParams.get("user_id"));
  if (!Number.isSafeInteger(userId) || userId < 1) {
    return jsonResponse({ status: "error", message: "Nieprawidłowy identyfikator gracza." }, 400);
  }

  const user = await env.DB.prepare(`
    SELECT id, github_login, display_name, avatar_url, current_cash
    FROM users
    WHERE id = ? AND github_login NOT IN ('benchmark_sp500', 'benchmark_wig20')
  `).bind(userId).first();
  if (!user) return jsonResponse({ status: "error", message: "Nie znaleziono gracza." }, 404);

  const [{ results: holdings }, lastThesis] = await Promise.all([
    env.DB.prepare(`
      SELECT
        h.ticker,
        m.name,
        h.shares,
        h.avg_buy_price,
        m.price AS current_price,
        m.currency,
        h.shares * m.price * m.fx_to_pln AS current_value_ck,
        ((m.price - h.avg_buy_price) / NULLIF(h.avg_buy_price, 0)) * 100.0 AS return_pct
      FROM holdings h
      JOIN market_prices m ON m.ticker = h.ticker
      WHERE h.user_id = ? AND h.shares > 0
      ORDER BY current_value_ck DESC
    `).bind(userId).all(),
    env.DB.prepare(`
      SELECT ticker, type, thesis, created_at
      FROM transactions
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).bind(userId).first(),
  ]);
  const stockValue = holdings.reduce((total, holding) => total + Number(holding.current_value_ck || 0), 0);

  return jsonResponse({
    status: "success",
    data: {
      id: user.id,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      cash_ck: user.current_cash,
      stocks_value_ck: stockValue,
      valuation_ck: Number(user.current_cash || 0) + stockValue,
      holdings,
      last_thesis: lastThesis || null,
    },
  });
}
