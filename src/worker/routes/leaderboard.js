import { jsonResponse } from "../lib/http.js";

export async function handleLeaderboard(context) {
  const { request, env, url, clientIp } = context;
  const query = `
    SELECT
      u.id,
      u.github_login,
      u.display_name AS Uczestnik,
      u.avatar_url,
      u.current_cash AS Gotowka_CK,
      COALESCE(SUM(h.shares * p.price * p.fx_to_pln), 0) AS Wartosc_Akcji_CK,
      (u.current_cash + COALESCE(SUM(h.shares * p.price * p.fx_to_pln), 0)) AS Wycena_Calkowita_CK,
      COUNT(h.ticker) AS Liczba_Pozycji
    FROM users u
    LEFT JOIN holdings h ON u.id = h.user_id AND h.shares > 0
    LEFT JOIN market_prices p ON h.ticker = p.ticker
    GROUP BY u.id
  `;

  const { results } = await env.DB.prepare(query).all();

  // Odczytanie czasu ostatniej aktualizacji crona
  const syncMeta = await env.DB.prepare("SELECT value, updated_at FROM app_metadata WHERE key = 'last_price_sync'").first();

  const leaderboard = results.map(row => {
    const profit = row.Wycena_Calkowita_CK - 100000.0;
    const returnPct = profit / 100000.0;
    return {
      ...row,
      Zysk_Strata_CK: profit,
      Stopa_Zwrotu: returnPct,
    };
  }).sort((a, b) => b.Stopa_Zwrotu - a.Stopa_Zwrotu);

  return jsonResponse({
    status: "success",
    data: leaderboard,
    last_sync: syncMeta ? syncMeta.value : null,
  });
}
