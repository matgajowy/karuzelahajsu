export async function fetchYahooQuote(symbol) {
  try {
    const cleanSym = symbol.trim().toUpperCase();
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cleanSym)}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
    });

    if (!res.ok) return null;
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta || !meta.regularMarketPrice) return null;

    let currency = meta.currency || "USD";
    if (cleanSym.endsWith(".WA")) currency = "PLN";

    return {
      ticker: cleanSym,
      name: meta.shortName || meta.longName || cleanSym,
      price: Number(meta.regularMarketPrice),
      currency: currency.toUpperCase(),
    };
  } catch (e) {
    console.error(`Błąd Yahoo Finance dla ${symbol}:`, e);
    return null;
  }
}

export async function syncAllMarketPrices(env) {
  const logs = [];

  // 1. Kurs USD/PLN
  let usdPln = 4.0;
  const usdQuote = await fetchYahooQuote("PLN=X");
  if (usdQuote) {
    usdPln = usdQuote.price;
    logs.push(`Kurs USD/PLN: ${usdPln.toFixed(4)}`);
  }

  // 2. Pobranie unikalnych tickerów z bazy
  const { results: tickers } = await env.DB.prepare("SELECT ticker, currency FROM market_prices").all();

  for (const item of tickers) {
    const q = await fetchYahooQuote(item.ticker);
    if (q) {
      const fx = q.currency === "USD" ? usdPln : 1.0;
      await env.DB.prepare(`
        UPDATE market_prices
        SET price = ?, fx_to_pln = ?, updated_at = CURRENT_TIMESTAMP
        WHERE ticker = ?
      `).bind(q.price, fx, item.ticker).run();
      logs.push(`Zaktualizowano ${item.ticker}: ${q.price} ${q.currency}`);
    }
  }

  // 3. Zapis znacznika czasu do app_metadata
  await env.DB.prepare(`
    INSERT INTO app_metadata (key, value, updated_at)
    VALUES ('last_price_sync', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
  `).run();

  logs.push("Zapisano timestamp synchronizacji w app_metadata.");
  return logs;
}
