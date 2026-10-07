export async function onRequestGet(context) {
  const db = context.env.DB; // Powiązanie z Cloudflare D1

  // Pobranie użytkowników wraz z wyceną ich pozycji
  const query = `
    SELECT 
      u.name AS Uczestnik,
      u.current_cash AS Gotowka_PLN,
      COALESCE(SUM(h.shares * p.price * p.fx_to_pln), 0) AS Wartosc_Akcji_PLN,
      (u.current_cash + COALESCE(SUM(h.shares * p.price * p.fx_to_pln), 0)) AS Wycena_Calkowita_PLN,
      COUNT(h.ticker) AS Liczba_Pozycji
    FROM users u
    LEFT JOIN holdings h ON u.id = h.user_id AND h.shares > 0
    LEFT JOIN market_prices p ON h.ticker = p.ticker
    GROUP BY u.id
  `;

  try {
    const { results } = await db.prepare(query).all();

    const leaderboard = results.map(row => {
      const profit = row.Wycena_Calkowita_PLN - 100000;
      const returnPct = profit / 100000;
      return {
        ...row,
        Zysk_Strata_PLN: profit,
        Stopa_Zwrotu: returnPct
      };
    }).sort((a, b) => b.Stopa_Zwrotu - a.Stopa_Zwrotu);

    return new Response(JSON.stringify({ status: "success", data: leaderboard }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    return new Response(JSON.stringify({ status: "error", message: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}