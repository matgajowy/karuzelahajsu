const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export async function generateText(env, systemInstruction, userPrompt, fallbackText = "Generator AI jest chwilowo niedostępny.") {
  try {
    if (!env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY secret is not configured.");
    }

    const endpoint = new URL(GEMINI_API_URL);
    endpoint.searchParams.set("key", env.GEMINI_API_KEY);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.9,
          maxOutputTokens: 300,
        },
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`Gemini API returned HTTP ${response.status}.`);
    }

    const result = await response.json();
    const text = result.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();
    if (!text) {
      throw new Error("Gemini API returned no text.");
    }
    return text;
  } catch (error) {
    console.error("Gemini text generation failed; using fallback.", error);
    return fallbackText;
  }
}

const STANDUP_SYSTEM_PROMPT = `Jesteś bezwzględnym, cynicznym, wulgarnym i brutalnie szczerym stand-uperem korporacyjnym oraz starym maklerem giełdowym w jednym.
Zero korporacyjnej poprawności politycznej, zero uprzejmości i litości.
Twoim celem jest bezlitosne zgrillowanie graczy biurowej ligi inwestycyjnej 'Karuzela Hajsu' oraz cięta, bezkompromisowa ocena sytuacji makroekonomicznej.

Format wyjściowy (zwróć WYŁĄCZNIE JSON z polami 'title' i 'content'):
- 'title': chwytliwy, prowokacyjny tytuł stand-upu (max 70 znaków, bez emoji)
- 'content': tekst w ściśle określonym formacie (mini-markdown), sekcje w tej kolejności:
  ## 🏆 Podium        — 1-2 zdania o liderach (czy to fart?). Imiona graczy pogrubiaj: **Imię**
  ## 📉 Dno tabeli    — 1-2 zdania o maruderach, imiona pogrubione
  ## 💤 Kisiciele gotówki — 1-2 zdania; pomiń sekcję, jeśli nikt nie kisi gotówki
  ## 🗣️ Teza dnia     — zacytuj i wyśmiej jedną konkretną tezę z listy ostatnich transakcji (pomiń, jeśli brak)
  ## 🌍 Makro         — dokładnie 3 punkty zaczynające się od "- ": **Stopy:**, **USD/PLN:**, **Nastroje:** (po jednym zdaniu)
Zasady formatu: każda sekcja zaczyna się od nagłówka "## " w osobnej linii, między sekcjami pusta linia,
bez wstępów i pożegnań, bez linii zaczynających się od ">" (pasek faktów dodaje system), łącznie max 1100 znaków.
Styl: żywy język, ironia, korpo-żargon pomieszany z ulicznym parkietem giełdowym.`;

// Wywołanie Gemini dla stand-upów z ponowieniami (429/5xx, błąd sieci, timeout).
// Zwraca null dopiero po wyczerpaniu prób albo przy błędzie nietymczasowym (np. 400/401/404).
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function callGemini(apiKey, prompt, systemInstruction, { attempts = 3, baseDelayMs = 1500 } = {}) {
  if (!apiKey) return null;
  const endpoint = new URL(GEMINI_API_URL);
  endpoint.searchParams.set("key", apiKey);
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ parts: [{ text: prompt }] }],
    // 2.5-flash domyślnie "myśli"; dla krótkiego tekstu wyłączamy to (szybciej, mieści się w limicie).
    generationConfig: {
      temperature: 0.9,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let retryable = true;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(20000),
      });
      if (response.ok) {
        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
        if (text) return text;
        console.warn(`Gemini returned no text (attempt ${attempt}/${attempts}).`, data?.candidates?.[0]?.finishReason);
      } else {
        retryable = RETRYABLE_STATUS.has(response.status);
        console.warn(`Gemini API error (attempt ${attempt}/${attempts}):`, response.status, await response.text().catch(() => ""));
      }
    } catch (error) {
      console.warn(`Gemini API call failed (attempt ${attempt}/${attempts}):`, error.message);
    }
    if (!retryable || attempt === attempts) break;
    await sleep(baseDelayMs * attempt);
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
  if (context.recentTrades?.length) {
    const trades = context.recentTrades.slice(0, 5).map(trade => {
      const verb = trade.type === "SELL" ? "sprzedaje" : "kupuje";
      const thesis = String(trade.thesis || "").replace(/\s+/g, " ").trim().slice(0, 110);
      return `- **${shortName(trade.display_name)}** ${verb} ${trade.ticker}${thesis ? ` — „${thesis}”` : ""}`;
    });
    sections.push(`## 🔁 Ostatnie ruchy\n${trades.join("\n")}`);
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

export async function generateStandup(env, type = "STANDUP_MORNING") {
  const isMorning = type === "STANDUP_MORNING";
  const defaultTitle = isMorning
    ? "Poranny Stand-up z Parkietu"
    : "Popołudniowy Stand-up z Parkietu";

  // Pobierz dane ligowe z D1 do kontekstu roastu
  let contextData = {};
  try {
    const settled = await Promise.allSettled([
      env.DB.prepare(`
        SELECT u.display_name, u.current_cash,
          (u.current_cash + COALESCE(SUM(h.shares * p.price * p.fx_to_pln), 0)) AS total_val
        FROM users u
        LEFT JOIN holdings h ON u.id = h.user_id AND h.shares > 0
        LEFT JOIN market_prices p ON h.ticker = p.ticker
        WHERE u.github_login NOT IN ('benchmark_sp500', 'benchmark_wig20')
        GROUP BY u.id
        ORDER BY total_val DESC
        LIMIT 3
      `).all(),
      env.DB.prepare(`
        SELECT u.display_name, u.current_cash,
          (u.current_cash + COALESCE(SUM(h.shares * p.price * p.fx_to_pln), 0)) AS total_val
        FROM users u
        LEFT JOIN holdings h ON u.id = h.user_id AND h.shares > 0
        LEFT JOIN market_prices p ON h.ticker = p.ticker
        WHERE u.github_login NOT IN ('benchmark_sp500', 'benchmark_wig20')
        GROUP BY u.id
        ORDER BY total_val ASC
        LIMIT 3
      `).all(),
      env.DB.prepare(`
        SELECT u.display_name, u.current_cash
        FROM users u
        LEFT JOIN holdings h ON u.id = h.user_id AND h.shares > 0
        WHERE u.github_login NOT IN ('benchmark_sp500', 'benchmark_wig20')
        GROUP BY u.id
        HAVING COUNT(h.ticker) = 0 AND u.current_cash >= 99000
        LIMIT 5
      `).all(),
      env.DB.prepare(`
        SELECT t.ticker, t.type, t.thesis, u.display_name
        FROM transactions t
        JOIN users u ON t.user_id = u.id
        ORDER BY t.created_at DESC
        LIMIT 5
      `).all(),
    ]);
    const [topUsers, bottomUsers, cashSitters, recentTrades] = settled.map(result => {
      if (result.status === "fulfilled") return result.value;
      console.warn("Stand-up context query failed:", result.reason?.message);
      return { results: [] };
    });

    contextData = {
      isMorning,
      top: topUsers.results || [],
      bottom: bottomUsers.results || [],
      cashSitters: cashSitters.results || [],
      recentTrades: recentTrades.results || [],
    };
  } catch (err) {
    console.warn("Could not fetch D1 data for standup:", err.message);
  }

  const prompt = `Aktualne dane ligi Karuzela Hajsu:
Poranna sesja czy popołudniowa?: ${isMorning ? "Poranna przed GPW" : "Popołudniowa przed zamknięciem GPW i po otwarciu Wall Street"}
Liderzy: ${JSON.stringify(contextData.top)}
Dno tabeli: ${JSON.stringify(contextData.bottom)}
Kisiciele gotówki (100k bez akcji): ${JSON.stringify(contextData.cashSitters)}
Ostatnie transakcje i tezy: ${JSON.stringify(contextData.recentTrades)}

Napisz stand-up i zwróć JSON: {"title": "...", "content": "..."}`;

  let title = defaultTitle;
  let content = "";

  const responseText = await callGemini(env.GEMINI_API_KEY, prompt, STANDUP_SYSTEM_PROMPT, {
    baseDelayMs: Number(env.GEMINI_RETRY_DELAY_MS ?? 1500),
  });
  if (responseText) {
    const parsed = parseStandupResponse(responseText);
    if (parsed.title) title = parsed.title;
    if (parsed.content) {
      content = parsed.content;
    } else if (!/^\s*[{`]/.test(responseText)) {
      content = responseText; // zwykły tekst bez JSON-a
    }
  }

  if (!content) {
    // AI niedostępne po ponowieniach: sekcje z realnych danych zamiast generycznego tekstu
    content = buildDataFallback(contextData, isMorning);
  }
  content = composeStandupContent(contextData, content);

  try {
    await env.DB.prepare(`
      INSERT INTO market_news (type, title, content)
      VALUES (?, ?, ?)
    `).bind(type, title, content).run();
  } catch (err) {
    console.error("Failed to insert market_news:", err);
  }

  return { type, title, content };
}
