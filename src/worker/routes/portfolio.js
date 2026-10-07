import { jsonResponse } from "../lib/http.js";
import { getSessionUser } from "../lib/auth.js";

export async function handlePortfolio(context) {
  const { request, env, url, clientIp } = context;
  const user = await getSessionUser(request, env);
  if (!user) return jsonResponse({ status: "error", message: "Wymagane logowanie" }, 401);

  const query = `
    SELECT
      h.ticker,
      m.name,
      h.shares,
      h.avg_buy_price,
      m.price AS current_price,
      m.currency,
      m.fx_to_pln,
      (h.shares * m.price * m.fx_to_pln) AS current_value_pln,
      (((m.price - h.avg_buy_price) / h.avg_buy_price) * 100) AS return_pct
    FROM holdings h
    JOIN market_prices m ON h.ticker = m.ticker
    WHERE h.user_id = ? AND h.shares > 0
    ORDER BY current_value_pln DESC
  `;
  const { results } = await env.DB.prepare(query).bind(user.id).all();

  return jsonResponse({
    status: "success",
    cash: user.current_cash,
    data: results,
  });
}
