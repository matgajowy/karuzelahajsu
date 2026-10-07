export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Obsługa zapytania o ranking
    if (url.pathname === "/api/leaderboard") {
      try {
        const query = `
          SELECT 
            u.display_name AS Uczestnik,
            u.current_cash AS Gotowka_PLN,
            COALESCE(SUM(h.shares * p.price * p.fx_to_pln), 0) AS Wartosc_Akcji_PLN,
            (u.current_cash + COALESCE(SUM(h.shares * p.price * p.fx_to_pln), 0)) AS Wycena_Calkowita_PLN,
            COUNT(h.ticker) AS Liczba_Pozycji
          FROM users u
          LEFT JOIN holdings h ON u.id = h.user_id AND h.shares > 0
          LEFT JOIN market_prices p ON h.ticker = p.ticker
          GROUP BY u.id
        `;

        const { results } = await env.DB.prepare(query).all();

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
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
      } catch (error) {
        return new Response(JSON.stringify({ status: "error", message: error.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Pozostałe zapytania (jeśli nie obsłużyły ich pliki statyczne)
    return new Response("Not found", { status: 404 });
  }
};