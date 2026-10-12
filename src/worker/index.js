import { jsonResponse } from "./lib/http.js";
import { allowedMethods, findRoute } from "./routes/index.js";
import { syncAllMarketPrices } from "./services/pricing.js";
import { generateStandup } from "./services/ai.js";
import { sendEveningRecap, sendMorningBriefing } from "./services/slackBriefing.js";

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === "30 6 * * 1-5") {
      ctx.waitUntil(sendMorningBriefing(env).catch(error => {
        console.error("Morning Slack briefing failed.", error);
      }));
      return;
    }
    if (event.cron === "30 15 * * 1-5") {
      ctx.waitUntil(sendEveningRecap(env).catch(error => {
        console.error("Evening Slack recap failed.", error);
      }));
      return;
    }
    if (event.cron === "0 6 * * MON-FRI" || event.cron === "0 6 * * *") {
      ctx.waitUntil(generateStandup(env, "STANDUP_MORNING").catch(error => {
        console.error("Morning stand-up failed.", error);
      }));
      return;
    }
    if (event.cron === "0 14 * * MON-FRI" || event.cron === "0 14 * * *") {
      ctx.waitUntil(generateStandup(env, "STANDUP_EVENING").catch(error => {
        console.error("Evening stand-up failed.", error);
      }));
      return;
    }
    ctx.waitUntil(syncAllMarketPrices(env).catch(error => {
      console.error("Scheduled market price sync failed.", error);
    }));
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

    if (env.ASSETS && (url.pathname === "/v2" || url.pathname === "/v2/") &&
        (request.method === "GET" || request.method === "HEAD")) {
      // Nowy interfejs wybiera wyłącznie adres /v2 (bez ciasteczek i parametrów).
      // Ścieżka bez rozszerzenia: Workers Assets zamieniłby "/index-v2.html" na przekierowanie.
      return env.ASSETS.fetch(new Request(new URL("/index-v2", url), request));
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
