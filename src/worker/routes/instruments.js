import { jsonResponse } from "../lib/http.js";
import { fetchYahooQuote } from "../services/pricing.js";
import { getMarketInfo, toMarketStatus } from "../lib/marketHours.js";
import { isBelowMinPrice, priceTooLowMessage } from "../lib/tradingRules.js";

export async function handleInstrumentSearch(context) {
  const { request, env, url, clientIp } = context;
  const q = (url.searchParams.get("q") || "").trim().toUpperCase();
  if (!q) return jsonResponse({ status: "error", message: "Brak symbolu waloru" }, 400);

  const isAutocomplete = url.searchParams.get("autocomplete") === "true" || url.searchParams.get("autocomplete") === "1";

  if (isAutocomplete) {
    const term = `%${q}%`;
    let results = [];

    // 1. Przeszukaj lokalny cache D1 (market_prices)
    try {
      const { results: localResults } = await env.DB.prepare(`
        SELECT ticker, name, price, currency, fx_to_pln
        FROM market_prices
        WHERE ticker LIKE ? OR name LIKE ?
        ORDER BY
          CASE WHEN ticker = ? THEN 0
               WHEN ticker LIKE ? THEN 1
               ELSE 2 END,
          ticker ASC
        LIMIT 5
      `).bind(term, term, q, `${q}%`).all();

      if (Array.isArray(localResults)) {
        // Akcje groszkowe nie są dostępne w lidze — nie podpowiadamy ich.
        results = localResults.filter(item => !isBelowMinPrice(item.price)).map(item => {
          const info = getMarketInfo(item.ticker);
          return {
            ticker: item.ticker,
            name: item.name,
            market: item.ticker.endsWith(".WA") ? "GPW" : "USA",
            market_status: toMarketStatus(info),
            price: item.price,
            currency: item.currency,
          };
        });
      }
    } catch (err) {
      console.warn("D1 autocomplete search error:", err.message);
    }

    // 2. Jeśli znaleziono mniej niż 5 pozycji, odpytaj Yahoo Finance Search API
    if (results.length < 5) {
      try {
        const yahooSearchUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=5&newsCount=0`;
        const res = await fetch(yahooSearchUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        });
        if (res.ok) {
          const data = await res.json();
          const quotes = data?.quotes || [];
          for (const quote of quotes) {
            if (results.length >= 5) break;
            const ticker = (quote.symbol || "").toUpperCase();
            if (!ticker || results.some(r => r.ticker === ticker)) continue;
            // Filtrujemy tylko rynki akcji / dozwolone (GPW .WA lub USA)
            const isWA = ticker.endsWith(".WA");
            const isUS = !ticker.includes(".");
            if (!isWA && !isUS) continue;

            const info = getMarketInfo(ticker);
            results.push({
              ticker,
              name: quote.shortname || quote.longname || ticker,
              market: isWA ? "GPW" : "USA",
              market_status: toMarketStatus(info),
            });
          }
        }
      } catch (err) {
        console.warn("Yahoo search API failed:", err.message);
      }
    }

    return jsonResponse({ status: "success", data: results });
  }

  // Standardowy tryb pojedynczego waloru (weryfikacja kursu)
  const quote = await fetchYahooQuote(q);
  if (!quote) {
    return jsonResponse({ status: "error", message: `Walor "${q}" nie został znaleziony lub nie jest dozwolony.` }, 404);
  }

  if (isBelowMinPrice(quote.price)) {
    return jsonResponse({
      status: "error",
      code: "PRICE_TOO_LOW",
      message: priceTooLowMessage(quote.ticker, quote.price, quote.currency),
    }, 400);
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
      market_status: toMarketStatus(getMarketInfo(quote.ticker)),
    },
  });
}
