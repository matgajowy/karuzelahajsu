import { buildStandupPrompt, countOverused, loadStandupContext, overusedTerms, pickLens } from "./standupContext.js";

// Stand-upy AI (Google Gemini) dla feedu rynkowego ligi.
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const STANDUP_SYSTEM_PROMPT = `Jesteś bezwzględnym, cynicznym, wulgarnym i brutalnie szczerym stand-uperem korporacyjnym oraz starym maklerem giełdowym w jednym.
Zero korporacyjnej poprawności politycznej, zero uprzejmości i litości.
Twoim celem jest bezlitosne zgrillowanie graczy biurowej ligi inwestycyjnej 'Karuzela Hajsu' oraz cięta ocena sytuacji rynkowej.

Format wyjściowy (zwróć WYŁĄCZNIE JSON z polami 'title' i 'content'):
- 'title': chwytliwy tytuł (max 70 znaków, bez emoji), inny niż w poprzednich wydaniach
- 'content': tekst w mini-markdown, sekcje w tej kolejności (pomijaj sekcje, do których nie ma materiału):
  ## 🏆 Podium            — 1-2 zdania, konkretne liczby z danych, imiona pogrubione: **Imię**
  ## 📉 Dno tabeli        — 1-2 zdania, imiona pogrubione
  ## 🎯 Motyw dnia        — 2-3 zdania rozwijające MOTYW PRZEWODNI z danych (obowiązkowa, gdy motyw podano)
  ## 💤 Kisiciele gotówki — tylko jeśli są w danych
  ## 🔁 Nowe ruchy        — tylko jeśli podano NOWE TRANSAKCJE: skomentuj 1-3 konkretne ruchy wraz z tezą
  ## 🌍 Makro             — 3 punkty zaczynające się od "- ": gdy podano RYNEK DZIŚ, każdy punkt dotyczy konkretnego
                             instrumentu z jego liczbą (S&P 500, WIG20, USD/PLN); bez notowań — jedna krótka uwaga
Zasady:
- Wydanie PORANNE to zapowiedź dnia, POPOŁUDNIOWE to rozliczenie dnia — dopasuj ton i treść.
- Opieraj się na liczbach z danych; niczego nie zmyślaj (ruchów, kwot, nazwisk).
- Liczby zapisuj z przecinkiem dziesiętnym i znakiem (np. +45,9%, -6,6%, 12 386 CK).
- Każdy fakt padnie tylko raz: Podium i Dno to krótkie ujęcie, a "Motyw dnia" musi wnosić NOWĄ informację
  (nie powtarzaj w nim liczby graczy bijących indeksy ani wyników z Podium/Dno).
- W "Makro" zacznij każdy punkt od pogrubionej etykiety, np. "- **S&P 500 (-0,06%):** ...".
- Nie powtarzaj żartów, porównań, puent ani tytułów z POPRZEDNICH WYDAŃ; nie używaj WYCZERPANYCH SŁÓW.
- Każda sekcja zaczyna się od nagłówka "## " w osobnej linii, między sekcjami pusta linia.
- Bez wstępów i pożegnań, bez linii zaczynających się od ">" (pasek faktów dodaje system), łącznie max 1500 znaków.
Styl: żywy język, ironia, korpo-żargon pomieszany z ulicznym parkietem giełdowym.`;

// Wywołanie Gemini dla stand-upów. Gemini potrafi zwracać 503 "high demand" przez dłuższą chwilę,
// więc: do 5 prób z rosnącym odstępem (2/4/8/16 s) i łańcuch modeli — po dwie próby na model;
// 404 (model niedostępny) przechodzi od razu do następnego, inne błędy 4xx kończą wywołanie.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const GEMINI_MODEL_CHAIN = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-latest"];
const ATTEMPTS_PER_MODEL = 2;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const endpointFor = model =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

async function callGemini(apiKey, prompt, systemInstruction, {
  attempts = 5,
  baseDelayMs = 2000,
  temperature = 0.9,
  models = GEMINI_MODEL_CHAIN,
} = {}) {
  if (!apiKey) return null;
  let modelIndex = 0;
  let triesOnModel = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const model = models[Math.min(modelIndex, models.length - 1)];
    triesOnModel += 1;
    const endpoint = new URL(endpointFor(model));
    endpoint.searchParams.set("key", apiKey);
    const generationConfig = { temperature, responseMimeType: "application/json" };
    // thinkingBudget istnieje tylko w rodzinie 2.5; dla krótkiego tekstu wyłączamy "myślenie".
    if (model.includes("2.5")) generationConfig.thinkingConfig = { thinkingBudget: 0 };

    let retryable = true;
    let nextModelNow = false;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig,
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (response.ok) {
        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
        if (text) return text;
        console.warn(`Gemini ${model} returned no text (attempt ${attempt}/${attempts}).`, data?.candidates?.[0]?.finishReason);
      } else {
        nextModelNow = response.status === 404;
        retryable = RETRYABLE_STATUS.has(response.status) || nextModelNow;
        console.warn(`Gemini ${model} error (attempt ${attempt}/${attempts}):`, response.status, await response.text().catch(() => ""));
      }
    } catch (error) {
      console.warn(`Gemini ${model} call failed (attempt ${attempt}/${attempts}):`, error.message);
    }
    if (!retryable || attempt === attempts) break;
    if (nextModelNow || triesOnModel >= ATTEMPTS_PER_MODEL) {
      modelIndex += 1;
      triesOnModel = 0;
    }
    if (!nextModelNow) await sleep(baseDelayMs * 2 ** (attempt - 1));
  }
  return null;
}

const pl = (value, digits = 1) => Number(value).toFixed(digits).replace(".", ",");
const shortName = name => String(name || "?").trim();
const returnPct = totalVal => ((Number(totalVal) - 100000) / 100000) * 100;

// Pasek faktów budowany z danych (nie przez AI): lider, dno, liczba kisicieli gotówki.
export function buildStandupFacts(context = {}) {
  const parts = [];
  const top = context.top?.[0];
  // Zapytanie "bottom" sortuje rosnąco po wycenie, więc najsłabszy jest pierwszy.
  const bottom = context.bottom?.[0];
  if (top && Number.isFinite(Number(top.total_val))) {
    const r = returnPct(top.total_val);
    parts.push(`🏆 Lider: ${shortName(top.display_name)} (${r >= 0 ? "+" : ""}${pl(r)}%)`);
  }
  if (bottom && bottom !== top && Number.isFinite(Number(bottom.total_val))) {
    const r = returnPct(bottom.total_val);
    parts.push(`📉 Dno: ${shortName(bottom.display_name)} (${r >= 0 ? "+" : ""}${pl(r)}%)`);
  }
  const sitters = context.cashSitters?.length || 0;
  if (sitters > 0) parts.push(`💤 Kisiciele gotówki: ${sitters}`);
  const fresh = context.newTrades?.length || 0;
  if (fresh > 0) parts.push(`🔁 Nowych ruchów: ${fresh}`);
  return parts.length ? `> ${parts.join(" • ")}` : "";
}


const fmtCk = value => `${Math.round(Number(value) || 0).toLocaleString("pl-PL")} CK`;
const signedPct = value => `${value >= 0 ? "+" : ""}${pl(value)}%`;

// Fallback używany, gdy AI jest niedostępne: te same sekcje, ale wypełnione danymi z bazy.
export function buildDataFallback(context = {}, isMorning = true) {
  const sections = [];
  sections.push(isMorning
    ? "Komentarz AI jest chwilowo niedostępny, więc zamiast niego sama tabela ligi."
    : "Komentarz AI jest chwilowo niedostępny, więc zamiast niego sama tabela ligi i ostatnie ruchy.");

  const row = user =>
    `- **${shortName(user.display_name)}** — ${fmtCk(user.total_val)} (${signedPct(returnPct(user.total_val))})`;
  if (context.top?.length) {
    sections.push(`## 🏆 Podium\n${context.top.map(row).join("\n")}`);
  }
  if (context.bottom?.length) {
    sections.push(`## 📉 Dno tabeli\n${context.bottom.map(row).join("\n")}`);
  }
  if (context.cashSitters?.length) {
    const names = context.cashSitters.map(user => `**${shortName(user.display_name)}**`).join(", ");
    sections.push(`## 💤 Kisiciele gotówki\n${names} — nadal siedzą na gotówce bez żadnej pozycji.`);
  }
  const tradeSource = context.newTrades?.length ? context.newTrades : context.recentTrades;
  if (tradeSource?.length) {
    const trades = tradeSource.slice(0, 5).map(trade => {
      const verb = trade.type === "SELL" ? "sprzedaje" : "kupuje";
      const thesis = String(trade.thesis || "").replace(/\s+/g, " ").trim().slice(0, 110);
      return `- **${shortName(trade.display_name)}** ${verb} ${trade.ticker}${thesis ? ` — „${thesis}”` : ""}`;
    });
    sections.push(`## 🔁 ${context.newTrades?.length ? "Nowe ruchy" : "Ostatnie ruchy"}\n${trades.join("\n")}`);
  }
  return sections.join("\n\n");
}

// Składa finalną treść: pasek faktów + sekcje od AI (bez własnych linii ">").
export function composeStandupContent(context, body) {
  const cleaned = String(body || "")
    .split(/\r?\n/)
    .filter(line => !/^\s*>/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const facts = buildStandupFacts(context);
  return [facts, cleaned].filter(Boolean).join("\n\n");
}


// Odpowiedź modelu bywa: owinięta w ```json, z surowymi nowymi liniami w stringach (niepoprawny JSON)
// albo urwana. Zwraca { title?, content? } — nigdy nie rzuca.
export function parseStandupResponse(raw) {
  const text = String(raw || "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  if (!text) return {};

  const pick = parsed => ({
    title: typeof parsed?.title === "string" ? parsed.title.trim() : undefined,
    content: typeof parsed?.content === "string" ? parsed.content.trim() : undefined,
  });

  try {
    return pick(JSON.parse(text));
  } catch {
    // próba naprawy: surowe znaki sterujące wewnątrz stringów -> sekwencje escape
    let repaired = "";
    let inString = false;
    let escaped = false;
    for (const char of text) {
      if (inString) {
        if (escaped) { repaired += char; escaped = false; continue; }
        if (char === "\\") { repaired += char; escaped = true; continue; }
        if (char === '"') { repaired += char; inString = false; continue; }
        if (char === "\n") { repaired += "\\n"; continue; }
        if (char === "\r") { continue; }
        if (char === "\t") { repaired += "\\t"; continue; }
        repaired += char;
      } else {
        if (char === '"') inString = true;
        repaired += char;
      }
    }
    try {
      return pick(JSON.parse(repaired));
    } catch {
      // ostatnia deska ratunku: wyciągnij pola regexem (np. urwany JSON)
      const unescape = value => value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      const title = text.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      const content = text.match(/"content"\s*:\s*"([\s\S]*?)"\s*}?\s*$/);
      const result = {};
      if (title) result.title = unescape(title[1]).trim();
      if (content) result.content = unescape(content[1]).trim();
      return result;
    }
  }
}

const MAX_OVERUSED_IN_RESULT = 3;

async function requestStandup(env, prompt, temperature) {
  const responseText = await callGemini(env.GEMINI_API_KEY, prompt, STANDUP_SYSTEM_PROMPT, {
    baseDelayMs: Number(env.GEMINI_RETRY_DELAY_MS ?? 2000),
    temperature,
  });
  if (!responseText) return null;
  const parsed = parseStandupResponse(responseText);
  if (parsed.content) return { title: parsed.title, content: parsed.content };
  if (!/^\s*[{`]/.test(responseText)) return { title: undefined, content: responseText };
  return null;
}

// Znacznik wpisu awaryjnego (AI niedostępne) — po nim kolejne odpalenie crona próbuje go naprawić.
export const STANDUP_FALLBACK_MARKER = "Komentarz AI jest chwilowo niedostępny";

export async function generateStandup(env, type = "STANDUP_MORNING", { replaceId = null } = {}) {
  const isMorning = type === "STANDUP_MORNING";
  let title = isMorning ? "Poranny Stand-up z Parkietu" : "Popołudniowy Stand-up z Parkietu";
  let content = "";

  let contextData = { isMorning };
  try {
    contextData = await loadStandupContext(env, type, {
      excludeId: replaceId,
      // STANDUP_MARKET_OVERRIDE: tablica notowań wstrzykiwana w testach (bez zapytań do Yahoo)
      ...(Array.isArray(env.STANDUP_MARKET_OVERRIDE) ? { fetchMarket: async () => env.STANDUP_MARKET_OVERRIDE } : {}),
    });
  } catch (err) {
    console.warn("Could not build stand-up context:", err.message);
  }

  const lens = pickLens(contextData, type);
  const avoid = overusedTerms(contextData);
  const prompt = buildStandupPrompt(contextData, lens, { avoid });

  let result = await requestStandup(env, prompt, 1.0);
  if (result) {
    // Bramka świeżości: za dużo wyeksploatowanych słów -> jedna poprawka z ostrzejszą instrukcją.
    const used = countOverused(result.content, avoid);
    if (used > MAX_OVERUSED_IN_RESULT) {
      const retryPrompt = buildStandupPrompt(contextData, lens, {
        avoid,
        extra: "UWAGA: poprzednia wersja powtarzała stare żarty i słownictwo. Napisz całość od nowa innym językiem, z innymi porównaniami i puentami.",
      });
      const second = await requestStandup(env, retryPrompt, 1.1);
      if (second && countOverused(second.content, avoid) < used) result = second;
    }
    if (result.title) title = result.title;
    content = result.content;
  }

  let usedFallback = false;
  if (!content) {
    // AI niedostępne po ponowieniach: sekcje z realnych danych zamiast generycznego tekstu
    content = buildDataFallback(contextData, isMorning);
    usedFallback = true;
  }
  content = composeStandupContent(contextData, content);

  if (replaceId !== null) {
    // Naprawa wpisu awaryjnego: zastępujemy go tylko pełnowartościową wersją od AI.
    if (usedFallback) return { type, title, content, repaired: false };
    await env.DB.prepare("UPDATE market_news SET title = ?, content = ? WHERE id = ?").bind(title, content, replaceId).run();
    return { type, title, content, lens: lens?.id || null, repaired: true };
  }

  if (env.STANDUP_DRY_RUN) {
    // Podgląd na danych środowiska bez zapisu do bazy (wrangler dev --var STANDUP_DRY_RUN:1).
    console.log("STANDUP_DRY_RUN", JSON.stringify({ type, title, lens: lens?.id || null, content }));
    return { type, title, content, lens: lens?.id || null, prompt };
  }

  try {
    await env.DB.prepare(`
      INSERT INTO market_news (type, title, content)
      VALUES (?, ?, ?)
    `).bind(type, title, content).run();
  } catch (err) {
    console.error("Failed to insert market_news:", err);
  }

  return { type, title, content, lens: lens?.id || null, prompt };
}

// Wpis awaryjny z ostatnich godzin (np. Gemini 503 o 8:00) jest podmieniany na wersję AI przy najbliższym
// odpaleniu crona synchronizacji (co 15 min). Zwraca null, gdy nie ma czego naprawiać.
export async function repairFallbackStandup(env, { windowHours = 6 } = {}) {
  const row = await env.DB.prepare(`
    SELECT id, type FROM market_news
    WHERE content LIKE ? AND created_at >= datetime('now', ?)
    ORDER BY id DESC LIMIT 1
  `).bind(`%${STANDUP_FALLBACK_MARKER}%`, `-${windowHours} hours`).first();
  if (!row) return null;
  return generateStandup(env, row.type, { replaceId: row.id });
}
