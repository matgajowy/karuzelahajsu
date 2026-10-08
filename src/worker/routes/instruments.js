import { jsonResponse } from "../lib/http.js";
import { fetchYahooQuote } from "../services/pricing.js";

export async function handleInstrumentSearch(context) {
  const { request, env, url, clientIp } = context;
  const q = (url.searchParams.get("q") || "").trim().toUpperCase();
  if (!q) return jsonResponse({ status: "error", message: "Brak symbolu waloru" }, 400);

  const quote = await fetchYahooQuote(q);
  if (!quote) {
    return jsonResponse({ status: "error", message: `Walor "${q}" nie został znaleziony lub nie jest dozwolony.` }, 404);
  }

  // The Yahoo USD/PLN quote is also USD/CK because 1 CK = 1 PLN.
  let fxRate = 1.0;
  if (quote.currency === "USD") {
    const usdQuote = await fetchYahooQuote("PLN=X");
    fxRate = usdQuote ? usdQuote.price : 4.0;
  }

  // Zapis/odświeżenie w tabeli market_prices
  await env.DB.prepare(`
    INSERT INTO market_prices (ticker, name, price, currency, fx_to_pln, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(ticker) DO UPDATE SET price = excluded.price, fx_to_pln = excluded.fx_to_pln, updated_at = CURRENT_TIMESTAMP
  `).bind(quote.ticker, quote.name, quote.price, quote.currency, fxRate).run();

  return jsonResponse({
    status: "success",
    data: {
      ...quote,
      fx_to_ck: fxRate,
      price_ck: quote.price * fxRate,
    },
  });
}
