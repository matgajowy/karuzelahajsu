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

// Pojedyncze wywołanie Gemini dla stand-upów. Zwraca null przy braku klucza, błędzie lub timeoucie.
async function callGemini(apiKey, prompt, systemInstruction) {
  if (!apiKey) return null;
  const endpoint = new URL(GEMINI_API_URL);
  endpoint.searchParams.set("key", apiKey);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ parts: [{ text: prompt }] }],
        // 2.5-flash domyślnie "myśli"; dla krótkiego tekstu wyłączamy to (szybciej, mieści się w limicie).
        generationConfig: { temperature: 0.9, thinkingConfig: { thinkingBudget: 0 } },
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) {
      console.warn("Gemini API error:", response.status, await response.text().catch(() => ""));
      return null;
    }
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
    return text || null;
  } catch (error) {
    console.warn("Gemini API call failed:", error.message);
    return null;
  }
}


const pl = (value, digits = 1) => Number(value).toFixed(digits).replace(".", ",");
const shortName = name => String(name || "?").trim();
const returnPct = totalVal => ((Number(totalVal) - 100000) / 100000) * 100;

// Pasek faktów budowany z danych (nie przez AI): lider, dno, liczba kisicieli gotówki.
export function buildStandupFacts(context = {}) {
  const parts = [];
  const top = context.top?.[0];
  const bottom = context.bottom?.[context.bottom.length - 1] ?? context.bottom?.[0];
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

export async function generateStandup(env, type = "STANDUP_MORNING") {
  const isMorning = type === "STANDUP_MORNING";
  const tagTime = isMorning ? "08:00" : "16:00";
  const defaultTitle = isMorning
    ? `Poranny Stand-up z Parkietu [${tagTime}]`
    : `Popołudniowy Stand-up z Parkietu [${tagTime}]`;

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

  const responseText = await callGemini(env.GEMINI_API_KEY, prompt, STANDUP_SYSTEM_PROMPT);
  if (responseText) {
    try {
      const cleanJson = responseText.replace(/^```json\s*|\s*```$/g, "").trim();
      const parsed = JSON.parse(cleanJson);
      if (parsed.title) title = parsed.title;
      if (parsed.content) content = parsed.content;
    } catch {
      content = responseText;
    }
  }

  if (!content) {
    // Solidny fallback (ten sam format), gdyby brakowało klucza Gemini lub nastąpił timeout
    content = isMorning
      ? `## 🌅 Na dzień dobry\nKawa stygnie, a wy nadal kisicie kapitał na 0%. Liderzy znowu myślą, że przypadkowy wzrost to ich geniusz inwestycyjny, a dół tabeli udaje, że „inwestuje długoterminowo”.\n\n## 🌍 Makro\n- **GPW:** rusza lada moment.\n- **Wall Street:** czeka, by zweryfikować wasze rzekome strategie.\n- **Plan dnia:** zakupy albo powrót do Excela.`
      : `## 🌇 Przed dzwonkiem\nGPW zbliża się do dzwonka, a Wall Street właśnie zaczyna jazdę bez trzymanki. Połowa z was kisi gotówkę, jakby inflacja nie istniała, a druga połowa weszła na samej górce.\n\n## 🗣️ Teza dnia\nTeza „będzie rosło” nie ochroni was przed spadkiem. Zobaczymy, kto do jutra utrzyma się na powierzchni.`;
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
