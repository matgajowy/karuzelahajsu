// Serwis integracji Google Gemini Flash dla stand-upów i roastów inwestycyjnych

// gemini-1.5-flash został wycofany (API zwraca 404), więc model jest nadpisywalny zmienną GEMINI_MODEL.
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const geminiUrl = model =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || DEFAULT_GEMINI_MODEL)}:generateContent`;

const STANDUP_SYSTEM_PROMPT = `Jesteś bezwzględnym, cynicznym, wulgarnym i brutalnie szczerym stand-uperem korporacyjnym oraz starym maklerem giełdowym w jednym.
Zero korporacyjnej poprawności politycznej, zero uprzejmości i litości.
Twoim celem jest bezlitosne zgrillowanie graczy biurowej ligi inwestycyjnej 'Karuzela Hajsu' oraz cięta, bezkompromisowa ocena sytuacji makroekonomicznej.

Format wyjściowy (zwróć JSON z polami 'title' i 'content'):
- 'title': chwytliwy, prowokacyjny tytuł stand-upu (np. "Poranny łomot przed dzwonkiem GPW", "Koniec rumakowania na Wall Street")
- 'content': treść stand-upu (3-4 zwięzłe, mięsiste akapity):
  1. Bezlitosne wyśmianie liderów (czy to tylko ślepy fart?) i kompletnych maruderów na dnie tabeli.
  2. Wyśmianie 'kisicieli gotówki' (ludzi trzymających 100k CK w gotówce) i najgłupszych tez inwestycyjnych.
  3. Twardy, cyniczny komentarz makroekonomiczny (stopy, inflacja, USD/PLN, rentowności obligacji, nastroje w USA i Polsce).
Styl: żywy język, ironia, korpo-żargon pomieszany z ulicznym parkietem giełdowym.`;

const TRADE_ROAST_SYSTEM_PROMPT = `Jesteś bezwzględnym, złośliwym i ciętym maklerem giełdowym.
Skomentuj poniższe zlecenie i tezę gracza w JEDNYM krótkim, uszczypliwym zdaniu (MAKSYMALNIE 120 ZNAKÓW).
Nie używaj cudzysłowów. Zero uprzejmości.`;

async function callGemini(apiKey, prompt, systemInstruction = null, model = null, timeoutMs = 6000) {
  if (!apiKey) return null;

  const body = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ]
  };

  // Modele 2.5 domyślnie "myślą" przed odpowiedzią; dla krótkich tekstów wyłączamy to (szybciej, taniej).
  if (String(model || DEFAULT_GEMINI_MODEL).includes("2.5")) {
    body.generationConfig = { ...(body.generationConfig || {}), thinkingConfig: { thinkingBudget: 0 } };
  }

  if (systemInstruction) {
    body.systemInstruction = {
      parts: [{ text: systemInstruction }]
    };
  }

  const url = `${geminiUrl(model)}?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn("Gemini API error:", res.status, await res.text().catch(() => ""));
      return null;
    }

    const data = await res.json();
    const candidate = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return candidate ? candidate.trim() : null;
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn("Gemini API call failed:", err.message);
    return null;
  }
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
    const [topUsers, bottomUsers, cashSitters, recentTrades] = await Promise.all([
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
        HAVING COUNT(h.id) = 0 AND u.current_cash >= 99000
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

  const responseText = await callGemini(env.GEMINI_API_KEY, prompt, STANDUP_SYSTEM_PROMPT, env.GEMINI_MODEL, 25000);
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
    // Solidny fallback, gdyby brakowało klucza Gemini w dev lub nastąpił timeout
    content = isMorning
      ? `Kawa stygnie, a wy nadal kisicie kapitał na 0%. Liderzy znowu myślą, że przypadkowy wzrost to ich geniusz inwestycyjny, a dół tabeli udaje, że 'inwestuje długoterminowo'. GPW rusza lada moment, a Wall Street czeka, by zweryfikować wasze rzekome strategie. Czas na zakupy albo powrót do Excela.`
      : `GPW zbliża się do dzwonka, a Wall Street właśnie zaczyna jazdę bez trzymanki. Połowa z was kisi gotówkę, jakby inflacja nie istniała, a druga połowa weszła na samej górce. Przypominamy: teza 'będzie rosło' nie ochroni was przed spadkiem. Zobaczymy, kto do jutra utrzyma się na powierzchni.`;
  }

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

export async function generateTradeRoast(env, { ticker, type, shares, thesis, userName }) {
  if (!thesis) return null;

  const prompt = `Gracz: ${userName || "Anonim"}
Akcja: ${type === "BUY" ? "KUPNO" : "SPRZEDAŻ"} ${shares} szt. ${ticker}
Teza gracza: "${thesis}"`;

  try {
    const roast = await callGemini(env.GEMINI_API_KEY, prompt, TRADE_ROAST_SYSTEM_PROMPT, env.GEMINI_MODEL);
    if (!roast) return null;
    const cleanRoast = roast.replace(/^["'“”]+|["'“”]+$/g, "").trim();
    return cleanRoast.length > 120 ? `${cleanRoast.slice(0, 117)}...` : cleanRoast;
  } catch (err) {
    console.warn("generateTradeRoast error:", err.message);
    return null;
  }
}
