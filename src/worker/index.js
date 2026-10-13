import { jsonResponse } from "./lib/http.js";
import { allowedMethods, findRoute } from "./routes/index.js";
import { syncAllMarketPrices } from "./services/pricing.js";
import { generateStandup } from "./services/ai.js";
import { warsawClock } from "./lib/localTime.js";


const STANDUP_SLOTS = {
  "0 6,7 * * MON-FRI": { type: "STANDUP_MORNING", localHour: 8 },
  "0 14,15 * * MON-FRI": { type: "STANDUP_EVENING", localHour: 16 },
};

// Ochrona przed duplikatem (np. ponowione wywołanie crona): pomija, jeśli wpis tego typu już powstał.
async function runStandupOnce(env, type) {
  try {
    const existing = await env.DB.prepare(
      "SELECT id FROM market_news WHERE type = ? AND created_at >= datetime('now', '-3 hours') LIMIT 1"
    ).bind(type).first();
    if (existing) return;
  } catch (error) {
    console.warn("Stand-up duplicate check failed; continuing.", error);
  }
  try {
    await generateStandup(env, type);
  } catch (error) {
    console.error(`${type} stand-up failed.`, error);
  }
}

export default {
  async scheduled(event, env, ctx) {
    const cron = event?.cron || "";

    // Stand-upy o stałej porze lokalnej: cron odpala się o 6 i 7 UTC (poranny) oraz 14 i 15 UTC
    // (popołudniowy), a wykonuje się tylko ten, który wypada o 8:00 / 16:00 w Warszawie.
    const slot = STANDUP_SLOTS[cron];
    if (slot) {
      const scheduledAt = event?.scheduledTime ? new Date(event.scheduledTime) : new Date();
      if (warsawClock(scheduledAt).hour !== slot.localHour) return;
      ctx.waitUntil(runStandupOnce(env, slot.type));
      return;
    }

    // Ręczne uruchomienie (wrangler --test-scheduled) i zgodność wsteczna: bez bramki godzinowej.
    if (cron === "0 6 * * MON-FRI" || cron === "0 6 * * *") {
      ctx.waitUntil(generateStandup(env, "STANDUP_MORNING").catch(error => {
        console.error("Morning stand-up failed.", error);
      }));
    } else if (cron === "0 14 * * MON-FRI" || cron === "0 14 * * *") {
      ctx.waitUntil(generateStandup(env, "STANDUP_EVENING").catch(error => {
        console.error("Evening stand-up failed.", error);
      }));
    } else {
      ctx.waitUntil(syncAllMarketPrices(env));
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const handler = findRoute(request.method, url.pathname);
    if (handler) {
      try {
        return await handler({ request, env, ctx, url, clientIp });
      } catch (error) {
        console.error("Worker route failed", {
          method: request.method,
          path: url.pathname,
          error,
        });
        return jsonResponse({ status: "error", message: "Wewnętrzny błąd serwera." }, 500);
      }
    }

    const methods = allowedMethods(url.pathname);
    if (methods.length > 0) {
      return jsonResponse(
        { status: "error", message: "Metoda niedozwolona." },
        405,
        { Allow: methods.join(", ") }
      );
    }

    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ status: "error", message: "Nie znaleziono endpointu." }, 404);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
