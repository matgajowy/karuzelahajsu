import { jsonResponse } from "../lib/http.js";
import { getSessionUser, logAudit } from "../lib/auth.js";
import { getMarketInfo, marketClosedMessage, toMarketStatus } from "../lib/marketHours.js";
import { isBelowMinPrice, priceTooLowMessage } from "../lib/tradingRules.js";

const CASH_EPSILON_CK = 1e-9;

// Kwoty poniżej 1 CK (np. akcje groszkowe) pokazujemy z 4 miejscami, żeby różnica była widoczna.
function formatCk(value) {
  const amount = Number(value) || 0;
  return amount.toFixed(Math.abs(amount) >= 1 ? 2 : 4);
}

export async function handleTrade(context) {
  const { request, env, url, clientIp } = context;
  const user = await getSessionUser(request, env);
  if (!user) return jsonResponse({ status: "error", message: "Wymagane logowanie" }, 401);

  const body = await request.json();
  const { ticker, type, thesis } = body;
  const shares = Number(body.shares);

  // Walidacja podstawowa
  if (!ticker || !["BUY", "SELL"].includes(type) || !Number.isFinite(shares) || shares <= 0) {
    return jsonResponse({ status: "error", message: "Nieprawidłowe dane zlecenia." }, 400);
  }
  if (!Number.isSafeInteger(shares)) {
    return jsonResponse({
      status: "error",
      message: `${type === "BUY" ? "Kupować" : "Sprzedawać"} można wyłącznie pełne akcje.`,
    }, 400);
  }

  if (!thesis || thesis.trim().length < 15) {
    return jsonResponse({ status: "error", message: "Uzasadnienie (Teza inwestycyjna) musi mieć co najmniej 15 znaków!" }, 400);
  }

  // Market Hours Guard: zlecenia tylko w sesji regularnej (czas Europe/Warsaw)
  const marketInfo = getMarketInfo(ticker);
  if (!marketInfo.isOpen) {
    await logAudit(env, user.id, `TRADE_${type}`, { ticker, shares, market: marketInfo.market, reason: marketInfo.reason }, clientIp, "REJECTED_MARKET_CLOSED");
    return jsonResponse({
      status: "error",
      code: "MARKET_CLOSED",
      message: marketClosedMessage(marketInfo),
      market_status: toMarketStatus(marketInfo),
    }, 400);
  }

  // Pobranie bieżącego kursu z bazy
  const inst = await env.DB.prepare("SELECT * FROM market_prices WHERE ticker = ?").bind(ticker).first();
  if (!inst) {
    return jsonResponse({ status: "error", message: "Walor nie został zweryfikowany w bazie." }, 400);
  }

  // Akcje groszkowe: zakup zablokowany (sprzedaż istniejącej pozycji nadal możliwa).
  if (type === "BUY" && isBelowMinPrice(inst.price)) {
    await logAudit(env, user.id, "TRADE_BUY", { ticker, shares, price: inst.price }, clientIp, "REJECTED_PRICE_TOO_LOW");
    return jsonResponse({
      status: "error",
      code: "PRICE_TOO_LOW",
      message: priceTooLowMessage(ticker, inst.price, inst.currency),
    }, 400);
  }

  // The database's legacy PLN conversion factor is also the CK conversion factor:
  // 1 CK = 1 PLN.
  const priceCk = inst.price * inst.fx_to_pln;
  const totalTradeCk = shares * priceCk;
  // Keep storing the same numeric amount in the legacy *_pln transaction column.

  // Wycena całkowita portfela użytkownika
  const portSummary = await env.DB.prepare(`
    SELECT
      u.current_cash,
      COALESCE(SUM(h.shares * p.price * p.fx_to_pln), 0) AS stocks_value
    FROM users u
    LEFT JOIN holdings h ON u.id = h.user_id AND h.shares > 0
    LEFT JOIN market_prices p ON h.ticker = p.ticker
    WHERE u.id = ?
    GROUP BY u.id
  `).bind(user.id).first();

  const totalPortfolioValueCk = (portSummary.current_cash || 0) + (portSummary.stocks_value || 0);

  if (type === "BUY") {
    // Tolerancja 1e-9 CK: błąd zmiennoprzecinkowy nie może odrzucić zlecenia na całe saldo.
    if (totalTradeCk - user.current_cash > CASH_EPSILON_CK) {
      return jsonResponse({
        status: "error",
        message: `Niewystarczające saldo Cyrk Koinów. Posiadasz: ${formatCk(user.current_cash)} CK, a zlecenie wymaga: ${formatCk(totalTradeCk)} CK (brakuje ${formatCk(totalTradeCk - user.current_cash)} CK).`,
      }, 400);
    }

    // 2. Walidacja limitu 35% na walor
    const existingHolding = await env.DB.prepare("SELECT shares FROM holdings WHERE user_id = ? AND ticker = ?").bind(user.id, ticker).first();
    const existingShares = existingHolding ? existingHolding.shares : 0;
    const postTradeTickerValueCk = (existingShares + shares) * priceCk;
    const exposurePct = (postTradeTickerValueCk / totalPortfolioValueCk) * 100;

    if (exposurePct > 35.01) {
      return jsonResponse({
        status: "error",
        message: `Naruszenie limitu koncentracji (Max 35%). Po zakupie pozycja byłaby warta ${postTradeTickerValueCk.toFixed(2)} CK, czyli ${exposurePct.toFixed(1)}% Twojego portfela.`
      }, 400);
    }

    // Wykonanie zakupu w atomowej paczce batch(). Pozycja i transakcja powstają tylko wtedy, gdy
    // obciążenie salda faktycznie zadziałało (changes() > 0) — chroni przed równoległymi zleceniami.
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE users SET current_cash = MAX(current_cash - ?, 0) WHERE id = ? AND current_cash >= ?").bind(totalTradeCk, user.id, totalTradeCk - CASH_EPSILON_CK),
      env.DB.prepare(`
        INSERT INTO holdings (user_id, ticker, shares, avg_buy_price)
        SELECT ?, ?, ?, ? WHERE changes() > 0
        ON CONFLICT(user_id, ticker) DO UPDATE SET
          avg_buy_price = ((holdings.shares * holdings.avg_buy_price) + (excluded.shares * excluded.avg_buy_price)) / (holdings.shares + excluded.shares),
          shares = holdings.shares + excluded.shares
      `).bind(user.id, ticker, shares, inst.price),
      env.DB.prepare(`
        INSERT INTO transactions (user_id, ticker, type, shares, price, total_value_pln, thesis)
        SELECT ?, ?, 'BUY', ?, ?, ?, ? WHERE changes() > 0
      `).bind(user.id, ticker, shares, inst.price, totalTradeCk, thesis.trim())
    ]);

    if (results?.[0]?.meta?.changes === 0) {
      await logAudit(env, user.id, "TRADE_BUY", { ticker, shares, totalTradeCk }, clientIp, "REJECTED_BALANCE_CHANGED");
      return jsonResponse({
        status: "error",
        code: "BALANCE_CHANGED",
        message: "Saldo zmieniło się w trakcie składania zlecenia (inne zlecenie zostało zrealizowane wcześniej). Odśwież dane i spróbuj ponownie.",
      }, 409);
    }

    await logAudit(env, user.id, "TRADE_BUY", { ticker, shares, totalTradeCk }, clientIp, "SUCCESS");
    return jsonResponse({ status: "success", message: "Zlecenie kupna zrealizowane pomyślnie!" });

  } else if (type === "SELL") {
    // Walidacja posiadanych akcji
    const existingHolding = await env.DB.prepare("SELECT shares FROM holdings WHERE user_id = ? AND ticker = ?").bind(user.id, ticker).first();
    if (!existingHolding || existingHolding.shares < shares) {
      const available = existingHolding ? existingHolding.shares : 0;
      return jsonResponse({ status: "error", message: `Nie posiadasz tylu akcji do sprzedaży. Dostępne: ${available} szt.` }, 400);
    }

    // Pozycja jest zmniejszana warunkowo (shares >= ?), a gotówka i transakcja zależą od tego kroku:
    // dwa równoległe zlecenia sprzedaży tej samej pozycji nie zapłacą dwa razy.
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE holdings SET shares = shares - ? WHERE user_id = ? AND ticker = ? AND shares >= ?").bind(shares, user.id, ticker, shares),
      env.DB.prepare("UPDATE users SET current_cash = current_cash + ? WHERE id = ? AND changes() > 0").bind(totalTradeCk, user.id),
      env.DB.prepare(`
        INSERT INTO transactions (user_id, ticker, type, shares, price, total_value_pln, thesis)
        SELECT ?, ?, 'SELL', ?, ?, ?, ? WHERE changes() > 0
      `).bind(user.id, ticker, shares, inst.price, totalTradeCk, thesis.trim()),
      env.DB.prepare("DELETE FROM holdings WHERE user_id = ? AND ticker = ? AND shares <= 0.0001").bind(user.id, ticker),
    ]);

    if (results?.[0]?.meta?.changes === 0) {
      await logAudit(env, user.id, "TRADE_SELL", { ticker, shares, totalTradeCk }, clientIp, "REJECTED_POSITION_CHANGED");
      return jsonResponse({
        status: "error",
        code: "POSITION_CHANGED",
        message: "Pozycja zmieniła się w trakcie składania zlecenia (inne zlecenie zostało zrealizowane wcześniej). Odśwież dane i spróbuj ponownie.",
      }, 409);
    }

    await logAudit(env, user.id, "TRADE_SELL", { ticker, shares, totalTradeCk }, clientIp, "SUCCESS");
    return jsonResponse({ status: "success", message: "Zlecenie sprzedaży zrealizowane pomyślnie!" });
  }
}
