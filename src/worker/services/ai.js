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
