import { handleGitHubCallback, handleGitHubLogin } from "./auth.js";
import { handleAdminUsers, handleAuditLogs, handlePriceSync, handleResetBenchmarks } from "./admin.js";
import { handleFeed } from "./feed.js";
import { handleInstrumentSearch } from "./instruments.js";
import { handleLeaderboard } from "./leaderboard.js";
import { handleLogout } from "./logout.js";
import { handlePortfolio } from "./portfolio.js";
import { handleMarketRace, handleMarketRecap, handleOpponentPortfolio } from "../services/p2.js";
import { handleGenerateNickname, handleProfileUpdate } from "./profile.js";
import { handleCurrentSession } from "./session.js";
import { handleTrade } from "./trades.js";

const routes = new Map([
  ["GET /api/auth/github", handleGitHubLogin],
  ["GET /api/auth/callback", handleGitHubCallback],
  ["GET /api/me", handleCurrentSession],
  ["POST /api/profile", handleProfileUpdate],
  ["POST /api/profile/generate-nickname", handleGenerateNickname],
  ["POST /api/logout", handleLogout],
  ["GET /api/leaderboard", handleLeaderboard],
  ["GET /api/portfolio", handlePortfolio],
  ["GET /api/opponent-portfolio", handleOpponentPortfolio],
  ["GET /api/market-race", handleMarketRace],
  ["GET /api/market-recap", handleMarketRecap],
  ["GET /api/instruments/search", handleInstrumentSearch],
  ["POST /api/trade", handleTrade],
  ["GET /api/feed", handleFeed],
  ["GET /api/admin/users", handleAdminUsers],
  ["POST /api/admin/users", handleAdminUsers],
  ["GET /api/admin/audit", handleAuditLogs],
  ["GET /api/admin/sync-prices", handlePriceSync],
  ["POST /api/admin/reset-benchmarks", handleResetBenchmarks],
]);

export function findRoute(method, pathname) {
  return routes.get(`${method} ${pathname}`) || null;
}

export function allowedMethods(pathname) {
  return [...routes.keys()]
    .filter(route => route.endsWith(` ${pathname}`))
    .map(route => route.slice(0, route.indexOf(" ")));
}
