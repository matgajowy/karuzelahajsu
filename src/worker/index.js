import { jsonResponse } from "./lib/http.js";
import { allowedMethods, findRoute } from "./routes/index.js";
import { syncAllMarketPrices } from "./services/pricing.js";
import { generateStandup } from "./services/ai.js";

export default {
  async scheduled(event, env, ctx) {
    const cron = event?.cron || "";
    if (cron === "0 6 * * *" || cron === "0 6 * * MON-FRI") {
      ctx.waitUntil(generateStandup(env, "STANDUP_MORNING"));
    } else if (cron === "0 14 * * *" || cron === "0 14 * * MON-FRI") {
      ctx.waitUntil(generateStandup(env, "STANDUP_EVENING"));
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
