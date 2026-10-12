// Stand-upy AI (Google Gemini) dla feedu rynkowego ligi.
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

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
