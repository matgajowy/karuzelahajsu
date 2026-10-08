export async function fetchYahooQuote(symbol) {
  try {
    const cleanSym = symbol.trim().toUpperCase();
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cleanSym)}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
    });

    if (!res.ok) {
      console.error(`Yahoo Finance returned HTTP ${res.status} for ${cleanSym}`);
      return null;
    }
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    const price = Number(meta?.regularMarketPrice);
    if (!meta || !Number.isFinite(price) || price <= 0) {
      console.error(`Yahoo Finance returned no valid price for ${cleanSym}`);
      return null;
    }

    let currency = meta.currency || "USD";
    if (cleanSym.endsWith(".WA")) currency = "PLN";

    return {
      ticker: cleanSym,
      name: meta.shortName || meta.longName || cleanSym,
      price,
      currency: currency.toUpperCase(),
    };
  } catch (e) {
    console.error(`Błąd Yahoo Finance dla ${symbol}:`, e);
    return null;
  }
}

export async function syncAllMarketPrices(env) {
  const logs = [];
  const { results: tickers } = await env.DB.prepare("SELECT ticker, currency FROM market_prices").all();
  const failedTickers = [];
  let updatedCount = 0;

  // WIG20 is the legacy benchmark ticker; Yahoo publishes this index as WIG20.WA.
  const quoteSymbols = [...new Set(tickers.map(({ ticker }) =>
    ticker === "WIG20" ? "WIG20.WA" : ticker
  ))];
  const quoteCache = new Map();
  const quoteFor = symbol => {
    if (!quoteCache.has(symbol)) quoteCache.set(symbol, fetchYahooQuote(symbol));
    return quoteCache.get(symbol);
  };

  // The USD/PLN quote is the USD/CK rate because 1 CK = 1 PLN.
  const usdQuote = await quoteFor("PLN=X");
  const usdCkRate = usdQuote?.price;
  if (usdCkRate) logs.push(`Kurs USD/CK: ${usdCkRate.toFixed(4)}`);
  else {
    failedTickers.push("PLN=X (kurs USD/CK)");
    logs.push("Nie udało się pobrać kursu USD/CK; notowania USD pozostawiono bez zmian.");
  }

  const quotes = new Map();
  const batchSize = 5;
  for (let index = 0; index < quoteSymbols.length; index += batchSize) {
    const batch = quoteSymbols.slice(index, index + batchSize);
    const quoteResults = await Promise.all(batch.map(async symbol => [symbol, await quoteFor(symbol)]));
    for (const [symbol, quote] of quoteResults) quotes.set(symbol, quote);
  }

  for (const item of tickers) {
    const sourceSymbol = item.ticker === "WIG20" ? "WIG20.WA" : item.ticker;
    const quote = quotes.get(sourceSymbol);
    if (!quote) {
      failedTickers.push(item.ticker);
      logs.push(`Nie udało się zaktualizować ${item.ticker}: brak aktualnego notowania.`);
      continue;
    }
    if (quote.currency === "USD" && !usdCkRate) {
      failedTickers.push(item.ticker);
      logs.push(`Nie udało się zaktualizować ${item.ticker}: brak kursu USD/CK.`);
      continue;
    }

    const fx = quote.currency === "USD" ? usdCkRate : 1.0;
    await env.DB.prepare(`
      UPDATE market_prices
      SET price = ?, fx_to_pln = ?, updated_at = CURRENT_TIMESTAMP
      WHERE ticker = ?
    `).bind(quote.price, fx, item.ticker).run();
    updatedCount += 1;
    logs.push(`Zaktualizowano ${item.ticker} na podstawie ${sourceSymbol}: ${quote.price} ${quote.currency}`);
  }

  const status = updatedCount === 0 ? "failed" : failedTickers.length > 0 ? "partial" : "success";
  const summary = {
    updated_count: updatedCount,
    failed_count: failedTickers.length,
    failed_tickers: failedTickers,
  };
  const metadata = [
    ["last_price_sync", new Date().toISOString()],
    ["last_price_sync_status", status],
    ["last_price_sync_summary", JSON.stringify(summary)],
  ];
  for (const [key, value] of metadata) {
    await env.DB.prepare(`
      INSERT INTO app_metadata (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).bind(key, value).run();
  }

  logs.push(`Synchronizacja ${status}: ${updatedCount} zaktualizowanych, ${failedTickers.length} niepowodzeń.`);
  console.log("Price sync completed", { status, ...summary });
  return { status, summary, logs };
}
