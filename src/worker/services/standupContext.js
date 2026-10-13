// Kontekst stand-upu: co się zmieniło od ostatniego wydania, ruchy na rynku, motyw dnia i pamięć
// poprzednich wydań (żeby model nie powtarzał żartów). Wszystkie zapytania są niezależne —
// awaria jednego nie odbiera reszty kontekstu.

const BENCHMARKS = ["benchmark_sp500", "benchmark_wig20"];
const NOT_BENCH = "u.github_login NOT IN ('benchmark_sp500', 'benchmark_wig20')";
const START_CAPITAL = 100000;

const retPct = total => ((Number(total) - START_CAPITAL) / START_CAPITAL) * 100;
const round1 = value => Math.round(value * 10) / 10;

async function safe(label, task, fallback) {
  try {
    return await task();
  } catch (error) {
    console.warn(`Stand-up context (${label}) failed:`, error?.message || error);
    return fallback;
  }
}

// Notowania z dziennym % (Yahoo chart: regularMarketPrice vs chartPreviousClose). Zwraca tylko udane.
export async function fetchMarketMoves(fetchImpl = fetch) {
  const symbols = [
    { label: "S&P 500", symbol: "^GSPC" },
    { label: "WIG20", symbol: "WIG20.WA" },
    { label: "USD/PLN", symbol: "PLN=X" },
  ];
  const results = await Promise.allSettled(symbols.map(async ({ label, symbol }) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const response = await fetchImpl(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const meta = (await response.json())?.chart?.result?.[0]?.meta;
    const price = Number(meta?.regularMarketPrice);
    const previous = Number(meta?.chartPreviousClose ?? meta?.previousClose);
    if (!Number.isFinite(price) || price <= 0) throw new Error("no price");
    const changePct = Number.isFinite(previous) && previous > 0 ? (price / previous - 1) * 100 : null;
    return { label, price, changePct: changePct === null ? null : Math.round(changePct * 100) / 100 };
  }));
  return results.filter(result => result.status === "fulfilled").map(result => result.value);
}

// Najbliższa para sąsiadów w rankingu graczy (pojedynek o miejsce).
export function findDuel(allPlayers) {
  // Tylko gracze z otwartymi pozycjami: kisiciele gotówki (0,0%) nie toczą żadnego pojedynku.
  const players = allPlayers.filter(player => Number(player.positions) > 0);
  let best = null;
  for (let index = 0; index < players.length - 1; index += 1) {
    const upper = players[index];
    const lower = players[index + 1];
    const gap = retPct(upper.total_val) - retPct(lower.total_val);
    if (gap < 0.1) continue; // remis w zaokrągleniu — nie ma o co walczyć
    if (best === null || gap < best.gapPp) {
      best = { rank: allPlayers.indexOf(upper) + 1, upper: upper.display_name, lower: lower.display_name, gapPp: round1(gap) };
    }
  }
  return best;
}

export async function loadStandupContext(env, type, { fetchMarket = fetchMarketMoves } = {}) {
  const isMorning = type === "STANDUP_MORNING";
  const db = env.DB;

  const [boardRes, previousRes, positionsRes, activeRes, market] = await Promise.all([
    safe("board", () => db.prepare(`
      SELECT u.id, u.github_login, u.display_name, u.current_cash,
        COUNT(h.ticker) AS positions,
        (u.current_cash + COALESCE(SUM(h.shares * p.price * p.fx_to_pln), 0)) AS total_val
      FROM users u
      LEFT JOIN holdings h ON u.id = h.user_id AND h.shares > 0
      LEFT JOIN market_prices p ON h.ticker = p.ticker
      GROUP BY u.id
      ORDER BY total_val DESC
    `).all(), { results: [] }),
    safe("previous", () => db.prepare(`
      SELECT id, type, created_at, title, content FROM market_news ORDER BY id DESC LIMIT 3
    `).all(), { results: [] }),
    safe("positions", () => db.prepare(`
      SELECT u.display_name, h.ticker, h.shares, p.name,
        ((p.price - h.avg_buy_price) / h.avg_buy_price * 100) AS return_pct,
        (h.shares * p.price * p.fx_to_pln) AS value_ck
      FROM holdings h
      JOIN users u ON u.id = h.user_id
      JOIN market_prices p ON p.ticker = h.ticker
      WHERE h.shares > 0 AND h.avg_buy_price > 0 AND ${NOT_BENCH}
    `).all(), { results: [] }),
    safe("active", () => db.prepare(`
      SELECT u.display_name, COUNT(*) AS n
      FROM transactions t JOIN users u ON u.id = t.user_id
      WHERE t.created_at >= datetime('now', '-24 hours') AND ${NOT_BENCH}
      GROUP BY u.id ORDER BY n DESC LIMIT 3
    `).all(), { results: [] }),
    safe("market", () => fetchMarket(), []),
  ]);

  const everyone = boardRes.results || [];
  const players = everyone.filter(row => !BENCHMARKS.includes(row.github_login));
  const benches = everyone.filter(row => BENCHMARKS.includes(row.github_login));
  const previous = previousRes.results || [];

  // Transakcje od poprzedniego wydania (albo z ostatnich 24 h przy pierwszym uruchomieniu).
  const since = previous[0]?.created_at || null;
  const tradeSql = `
    SELECT t.created_at, t.ticker, t.type, t.shares, t.total_value_pln AS value_ck, t.thesis, u.display_name
    FROM transactions t JOIN users u ON t.user_id = u.id
    WHERE ${NOT_BENCH} AND t.created_at > ${since ? "?" : "datetime('now', '-24 hours')"}
    ORDER BY t.created_at DESC LIMIT 12`;
  const newTradesRes = await safe("new-trades",
    () => (since ? db.prepare(tradeSql).bind(since) : db.prepare(tradeSql)).all(), { results: [] });
  const recentRes = await safe("recent", () => db.prepare(`
    SELECT t.ticker, t.type, t.thesis, u.display_name
    FROM transactions t JOIN users u ON t.user_id = u.id
    WHERE ${NOT_BENCH}
    ORDER BY t.created_at DESC LIMIT 5
  `).all(), { results: [] });

  const positions = (positionsRes.results || []).filter(row => Number.isFinite(Number(row.return_pct)));
  const byReturn = positions.slice().sort((a, b) => Number(b.return_pct) - Number(a.return_pct));
  const benchReturns = benches.map(row => ({ name: row.display_name, returnPct: round1(retPct(row.total_val)) }));
  const marketAvg = benchReturns.length
    ? benchReturns.reduce((sum, row) => sum + row.returnPct, 0) / benchReturns.length
    : null;

  return {
    isMorning,
    top: players.slice(0, 3),
    bottom: players.slice(-3).reverse(), // najsłabszy pierwszy (jak w poprzednim zapytaniu ASC)
    cashSitters: players.filter(row => Number(row.positions) === 0 && Number(row.current_cash) >= 99000).slice(0, 5),
    recentTrades: recentRes.results || [],
    newTrades: newTradesRes.results || [],
    sinceLastAt: since,
    previous,
    positionsBest: byReturn.slice(0, 3),
    positionsWorst: byReturn.slice(-3).reverse(),
    biggestPosition: positions.slice().sort((a, b) => Number(b.value_ck) - Number(a.value_ck))[0] || null,
    mostActive: activeRes.results || [],
    duel: findDuel(players),
    benchmarks: benchReturns,
    beatingMarket: marketAvg === null ? null : players.filter(row => retPct(row.total_val) > marketAvg).length,
    playerCount: players.length,
    market,
  };
}

// ---------- motyw dnia (rotacja) ----------
function hash(text) {
  let value = 0;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value;
}

export function pickLens(context, type, now = new Date()) {
  const pct = value => `${Number(value) >= 0 ? "+" : ""}${round1(Number(value)).toFixed(1).replace(".", ",")}%`;
  const lenses = [];
  if (context.duel && context.duel.gapPp <= 8) {
    lenses.push({
      id: "duel",
      instruction: `Pojedynek o ${context.duel.rank}. miejsce: ${context.duel.upper} vs ${context.duel.lower}, dzieli ich tylko ${String(context.duel.gapPp).replace(".", ",")} p.p. Rozegraj to jak walkę o miejsce.`,
    });
  }
  const worst = context.positionsWorst?.[0];
  if (worst && Number(worst.return_pct) < 0) {
    lenses.push({
      id: "worst-position",
      instruction: `Hala wstydu pozycji: ${worst.display_name} siedzi na ${pct(worst.return_pct)} w ${worst.ticker} (${worst.name || worst.ticker}). Skomentuj tę pozycję i ewentualnie pozostałe najgorsze.`,
    });
  }
  const best = context.positionsBest?.[0];
  if (best && Number(best.return_pct) > 0) {
    lenses.push({
      id: "best-position",
      instruction: `Najlepsza pozycja w lidze: ${best.display_name} na ${pct(best.return_pct)} w ${best.ticker}. Czy to rozum, czy fart?`,
    });
  }
  if ((context.newTrades?.length || 0) >= 2) {
    lenses.push({
      id: "new-moves",
      instruction: `Główny temat: ${context.newTrades.length} nowych transakcji od ostatniego wydania — skomentuj konkretne ruchy i ich tezy.`,
    });
  }
  const active = context.mostActive?.[0];
  if (active && Number(active.n) >= 2) {
    lenses.push({
      id: "most-active",
      instruction: `Najaktywniejszy gracz doby: ${active.display_name} (${active.n} transakcji). Handluje z rozsądkiem czy z nudów?`,
    });
  }
  if (context.cashSitters?.length) {
    lenses.push({
      id: "cash-sitters",
      instruction: `Kisiciele gotówki (${context.cashSitters.map(row => row.display_name).join(", ")}) — strach czy strategia? Policz im, ile tracą na bezczynności względem indeksów.`,
    });
  }
  if (context.beatingMarket !== null && context.playerCount > 0 && context.benchmarks?.length) {
    lenses.push({
      id: "vs-benchmark",
      instruction: `Rynek kontra gracze: indeksy bije ${context.beatingMarket} z ${context.playerCount} graczy. Kto naprawdę robi alfę, a kto tylko jedzie na rynku?`,
    });
  }
  if (!lenses.length) return null;
  // Licznik wydań (id ostatniego wpisu) przesuwa motyw o 1 przy każdym wydaniu, więc kolejne
  // stand-upy nigdy nie mają tego samego motywu; bez historii wybór jest deterministyczny wg daty.
  const lastId = Number(context.previous?.[0]?.id);
  const index = Number.isFinite(lastId) ? lastId + 1 : hash(`${now.toISOString().slice(0, 10)}:${type}`);
  return lenses[index % lenses.length];
}

// ---------- pamięć poprzednich wydań ----------
const STRUCTURAL = new Set([
  "podium", "kisici", "gotówk", "nastro", "procen", "stopy", "inwest", "kapita", "parkie", "będzie",
  "pewnie", "panowi", "strata", "trzyma", "tysięc", "złotów", "szybci", "przejm", "dzisia", "wynik",
  "tabeli", "rynek", "rynku", "gracze", "graczy", "motyw", "ostatn", "teraz", "zawsze",
]);

function words(text) {
  const body = String(text || "")
    .split("\n")
    .filter(line => !line.startsWith(">") && !line.startsWith("##"))
    .join(" ")
    .replace(/\*\*/g, "");
  return body.toLowerCase().match(/[a-ząćęłńóśźż]{6,}/g) || [];
}

const stem = word => word.slice(0, 6);

function nameStems(context) {
  const names = [
    ...(context.top || []), ...(context.bottom || []), ...(context.cashSitters || []),
    ...(context.newTrades || []), ...(context.recentTrades || []), ...(context.mostActive || []),
    ...(context.positionsBest || []), ...(context.positionsWorst || []),
  ].flatMap(row => [row.display_name, row.ticker, row.name]);
  const stems = new Set();
  for (const value of names) for (const word of words(value)) stems.add(stem(word));
  for (const value of names) for (const word of String(value || "").toLowerCase().match(/[a-ząćęłńóśźż]{4,}/g) || []) stems.add(stem(word));
  return stems;
}

// Rdzenie słów powtarzających się w >=2 z ostatnich wydań (poza imionami graczy i słowami strukturalnymi).
export function overusedTerms(context) {
  const counts = new Map();
  const display = new Map();
  for (const entry of context.previous || []) {
    const seen = new Set();
    for (const word of words(entry.content)) {
      const key = stem(word);
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!display.has(key)) display.set(key, word);
    }
  }
  const names = nameStems(context);
  return [...counts.entries()]
    .filter(([key, count]) => count >= 2 && !STRUCTURAL.has(key) && !names.has(key))
    .map(([key]) => display.get(key))
    .slice(0, 25);
}

export function countOverused(text, terms) {
  const used = new Set(words(text).map(stem));
  return terms.filter(term => used.has(stem(term))).length;
}

// ---------- prompt ----------
const clip = (text, max) => {
  const value = String(text || "").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
};
const fmtRow = row => ({
  gracz: row.display_name,
  wycena_ck: Math.round(Number(row.total_val)),
  zwrot_proc: round1(retPct(row.total_val)),
});

export function buildStandupPrompt(context, lens, { avoid = [], extra = "" } = {}) {
  const isMorning = context.isMorning;
  const lines = [];
  lines.push(`WYDANIE: ${isMorning
    ? "PORANNE (zapowiedź dnia): o co będzie walka przed otwarciem GPW o 9:00 i USA o 15:30, kto wchodzi pod presją, na co patrzeć"
    : "POPOŁUDNIOWE (rozliczenie dnia): co się wydarzyło, kto zyskał, kto stracił, co zmieniło się w rankingu"}`);
  if (lens) lines.push(`MOTYW PRZEWODNI (rozwiń w sekcji "🎯 Motyw dnia"): ${lens.instruction}`);

  lines.push(`\nRANKING (graczy: ${context.playerCount}):`);
  lines.push(`Liderzy: ${JSON.stringify((context.top || []).map(fmtRow))}`);
  lines.push(`Dno: ${JSON.stringify((context.bottom || []).map(fmtRow))}`);
  if (context.benchmarks?.length) lines.push(`Indeksy (zwrot od startu, %): ${JSON.stringify(context.benchmarks)}`);
  if (context.beatingMarket !== null) lines.push(`Graczy bijących średnią indeksów: ${context.beatingMarket} z ${context.playerCount}`);
  if (context.cashSitters?.length) {
    lines.push(`Kisiciele gotówki (100k, zero pozycji): ${JSON.stringify(context.cashSitters.map(row => row.display_name))}`);
  }

  if (context.newTrades?.length) {
    lines.push(`\nNOWE TRANSAKCJE od ostatniego wydania (${context.sinceLastAt || "ostatnie 24 h"} UTC):`);
    lines.push(JSON.stringify(context.newTrades.map(trade => ({
      gracz: trade.display_name, typ: trade.type, ticker: trade.ticker, sztuk: trade.shares,
      wartosc_ck: Math.round(Number(trade.value_ck) || 0), teza: clip(trade.thesis, 140),
    }))));
  } else {
    lines.push("\nNOWE TRANSAKCJE od ostatniego wydania: brak (cisza na parkiecie — nie wymyślaj ruchów).");
  }
  if (context.positionsBest?.length || context.positionsWorst?.length) {
    const pos = row => ({ gracz: row.display_name, ticker: row.ticker, zwrot_proc: round1(Number(row.return_pct)) });
    lines.push(`Najlepsze pozycje: ${JSON.stringify((context.positionsBest || []).map(pos))}`);
    lines.push(`Najgorsze pozycje: ${JSON.stringify((context.positionsWorst || []).map(pos))}`);
  }
  if (context.mostActive?.length) {
    lines.push(`Najaktywniejsi (24 h): ${JSON.stringify(context.mostActive.map(row => ({ gracz: row.display_name, transakcji: row.n })))}`);
  }

  if (context.market?.length) {
    lines.push(`\nRYNEK DZIŚ (zmiana dzienna): ${JSON.stringify(context.market.map(m => ({
      instrument: m.label, kurs: Math.round(m.price * 100) / 100, zmiana_proc: m.changePct,
    })))}`);
  } else {
    lines.push("\nRYNEK DZIŚ: brak notowań — w sekcji Makro napisz tylko jedną krótką, ogólną uwagę.");
  }

  if (context.previous?.length) {
    lines.push("\nPOPRZEDNIE WYDANIA (NIE POWTARZAJ żartów, porównań, puent ani tytułów):");
    for (const entry of context.previous) {
      lines.push(`- [${entry.type}] ${entry.title}: ${clip(String(entry.content).split("\n").filter(l => !l.startsWith(">")).join(" "), 420)}`);
    }
  }
  if (avoid.length) lines.push(`\nWYCZERPANE SŁOWA I OBRAZY (nie używaj ich w ogóle): ${avoid.join(", ")}`);
  if (extra) lines.push(`\n${extra}`);

  lines.push('\nNapisz stand-up i zwróć JSON: {"title": "...", "content": "..."}');
  return lines.join("\n");
}
