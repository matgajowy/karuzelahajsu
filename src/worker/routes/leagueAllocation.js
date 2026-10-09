import { jsonResponse } from "../lib/http.js";

// Zbiorcza alokacja graczy ligi (bez benchmarków): akcje GPW, akcje USA i gotówka, w CK.
export async function handleLeagueAllocation({ env }) {
  const holdings = await env.DB.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN h.ticker LIKE '%.WA' THEN h.shares * p.price * p.fx_to_pln ELSE 0 END), 0) AS gpw_ck,
      COALESCE(SUM(CASE WHEN h.ticker LIKE '%.WA' THEN 0 ELSE h.shares * p.price * p.fx_to_pln END), 0) AS usa_ck
    FROM holdings h
    JOIN users u ON u.id = h.user_id
    JOIN market_prices p ON p.ticker = h.ticker
    WHERE h.shares > 0 AND u.github_login NOT IN ('benchmark_sp500', 'benchmark_wig20')
  `).first();
  const cash = await env.DB.prepare(`
    SELECT COALESCE(SUM(current_cash), 0) AS cash_ck
    FROM users
    WHERE github_login NOT IN ('benchmark_sp500', 'benchmark_wig20')
  `).first();

  return jsonResponse({
    status: "success",
    data: {
      gpw_ck: Number(holdings?.gpw_ck) || 0,
      usa_ck: Number(holdings?.usa_ck) || 0,
      cash_ck: Number(cash?.cash_ck) || 0,
    },
  });
}
