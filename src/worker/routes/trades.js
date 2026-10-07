import { jsonResponse } from "../lib/http.js";
import { getSessionUser, logAudit } from "../lib/auth.js";

export async function handleTrade(context) {
  const { request, env, url, clientIp } = context;
  const user = await getSessionUser(request, env);
  if (!user) return jsonResponse({ status: "error", message: "Wymagane logowanie" }, 401);

  const body = await request.json();
  const { ticker, type, shares, thesis } = body;

  // Walidacja podstawowa
  if (!ticker || !["BUY", "SELL"].includes(type) || !shares || shares <= 0) {
    return jsonResponse({ status: "error", message: "Nieprawidłowe dane zlecenia." }, 400);
  }

  if (!thesis || thesis.trim().length < 15) {
    return jsonResponse({ status: "error", message: "Uzasadnienie (Teza inwestycyjna) musi mieć co najmniej 15 znaków!" }, 400);
  }

  // Pobranie bieżącego kursu z bazy
  const inst = await env.DB.prepare("SELECT * FROM market_prices WHERE ticker = ?").bind(ticker).first();
  if (!inst) {
    return jsonResponse({ status: "error", message: "Walor nie został zweryfikowany w bazie." }, 400);
  }

  const pricePln = inst.price * inst.fx_to_pln;
  const totalTradePln = shares * pricePln;

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

  const totalPortfolioValue = (portSummary.current_cash || 0) + (portSummary.stocks_value || 0);

  if (type === "BUY") {
    // 1. Sprawdzenie salda gotówki
    if (user.current_cash < totalTradePln) {
      return jsonResponse({ status: "error", message: `Niewystarczające saldo gotówki. Posiadasz: ${user.current_cash.toFixed(2)} zł, potrzebujesz: ${totalTradePln.toFixed(2)} zł.` }, 400);
    }

    // 2. Walidacja limitu 35% na walor
    const existingHolding = await env.DB.prepare("SELECT shares FROM holdings WHERE user_id = ? AND ticker = ?").bind(user.id, ticker).first();
    const existingShares = existingHolding ? existingHolding.shares : 0;
    const postTradeTickerValue = (existingShares + shares) * pricePln;
    const exposurePct = (postTradeTickerValue / totalPortfolioValue) * 100;

    if (exposurePct > 35.01) {
      return jsonResponse({
        status: "error",
        message: `Naruszenie limitu koncentracji (Max 35%). Po transakcji walor stanowiłby ${exposurePct.toFixed(1)}% Twojego portfela!`
      }, 400);
    }

    // Wykonanie zakupu w atomowej paczce batch()
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET current_cash = current_cash - ? WHERE id = ? AND current_cash >= ?").bind(totalTradePln, user.id, totalTradePln),
      env.DB.prepare(`
        INSERT INTO holdings (user_id, ticker, shares, avg_buy_price)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, ticker) DO UPDATE SET
          avg_buy_price = ((holdings.shares * holdings.avg_buy_price) + (excluded.shares * excluded.avg_buy_price)) / (holdings.shares + excluded.shares),
          shares = holdings.shares + excluded.shares
      `).bind(user.id, ticker, shares, inst.price),
      env.DB.prepare(`
        INSERT INTO transactions (user_id, ticker, type, shares, price, total_value_pln, thesis)
        VALUES (?, ?, 'BUY', ?, ?, ?, ?)
      `).bind(user.id, ticker, shares, inst.price, totalTradePln, thesis.trim())
    ]);

    await logAudit(env, user.id, "TRADE_BUY", { ticker, shares, totalTradePln }, clientIp, "SUCCESS");
    return jsonResponse({ status: "success", message: "Zlecenie kupna zrealizowane pomyślnie!" });

  } else if (type === "SELL") {
    // Walidacja posiadanych akcji
    const existingHolding = await env.DB.prepare("SELECT shares FROM holdings WHERE user_id = ? AND ticker = ?").bind(user.id, ticker).first();
    if (!existingHolding || existingHolding.shares < shares) {
      const available = existingHolding ? existingHolding.shares : 0;
      return jsonResponse({ status: "error", message: `Nie posiadasz tylu akcji do sprzedaży. Dostępne: ${available} szt.` }, 400);
    }

    const remainingShares = existingHolding.shares - shares;

    const batchQueries = [
      env.DB.prepare("UPDATE users SET current_cash = current_cash + ? WHERE id = ?").bind(totalTradePln, user.id),
      env.DB.prepare(`
        INSERT INTO transactions (user_id, ticker, type, shares, price, total_value_pln, thesis)
        VALUES (?, ?, 'SELL', ?, ?, ?, ?)
      `).bind(user.id, ticker, shares, inst.price, totalTradePln, thesis.trim())
    ];

    if (remainingShares <= 0.0001) {
      batchQueries.push(env.DB.prepare("DELETE FROM holdings WHERE user_id = ? AND ticker = ?").bind(user.id, ticker));
    } else {
      batchQueries.push(env.DB.prepare("UPDATE holdings SET shares = ? WHERE user_id = ? AND ticker = ?").bind(remainingShares, user.id, ticker));
    }

    await env.DB.batch(batchQueries);
    await logAudit(env, user.id, "TRADE_SELL", { ticker, shares, totalTradePln }, clientIp, "SUCCESS");
    return jsonResponse({ status: "success", message: "Zlecenie sprzedaży zrealizowane pomyślnie!" });
  }
}
