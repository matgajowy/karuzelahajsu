import { jsonResponse } from "../lib/http.js";
import { getSessionUser, logAudit } from "../lib/auth.js";
import { generateTransactionRoast } from "../services/p2.js";

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

  // Pobranie bieżącego kursu z bazy
  const inst = await env.DB.prepare("SELECT * FROM market_prices WHERE ticker = ?").bind(ticker).first();
  if (!inst) {
    return jsonResponse({ status: "error", message: "Walor nie został zweryfikowany w bazie." }, 400);
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
    if (user.current_cash < totalTradeCk) {
      return jsonResponse({
        status: "error",
        message: `Niewystarczające saldo Cyrk Koinów. Posiadasz: ${user.current_cash.toFixed(2)} CK, a zlecenie wymaga: ${totalTradeCk.toFixed(2)} CK.`,
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

    const aiRoast = await generateTransactionRoast(env, {
      ticker,
      companyName: inst.name,
      type,
      shares,
      thesis: thesis.trim(),
    });

    // Wykonanie zakupu w atomowej paczce batch()
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET current_cash = current_cash - ? WHERE id = ? AND current_cash >= ?").bind(totalTradeCk, user.id, totalTradeCk),
      env.DB.prepare(`
        INSERT INTO holdings (user_id, ticker, shares, avg_buy_price)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, ticker) DO UPDATE SET
          avg_buy_price = ((holdings.shares * holdings.avg_buy_price) + (excluded.shares * excluded.avg_buy_price)) / (holdings.shares + excluded.shares),
          shares = holdings.shares + excluded.shares
      `).bind(user.id, ticker, shares, inst.price),
      env.DB.prepare(`
        INSERT INTO transactions (user_id, ticker, type, shares, price, total_value_pln, thesis, ai_roast)
        VALUES (?, ?, 'BUY', ?, ?, ?, ?, ?)
      `).bind(user.id, ticker, shares, inst.price, totalTradeCk, thesis.trim(), aiRoast)
    ]);

    await logAudit(env, user.id, "TRADE_BUY", { ticker, shares, totalTradeCk }, clientIp, "SUCCESS");
    return jsonResponse({ status: "success", message: "Zlecenie kupna zrealizowane pomyślnie!" });

  } else if (type === "SELL") {
    // Walidacja posiadanych akcji
    const existingHolding = await env.DB.prepare("SELECT shares FROM holdings WHERE user_id = ? AND ticker = ?").bind(user.id, ticker).first();
    if (!existingHolding || existingHolding.shares < shares) {
      const available = existingHolding ? existingHolding.shares : 0;
      return jsonResponse({ status: "error", message: `Nie posiadasz tylu akcji do sprzedaży. Dostępne: ${available} szt.` }, 400);
    }

    const remainingShares = existingHolding.shares - shares;
    const aiRoast = await generateTransactionRoast(env, {
      ticker,
      companyName: inst.name,
      type,
      shares,
      thesis: thesis.trim(),
    });

    const batchQueries = [
      env.DB.prepare("UPDATE users SET current_cash = current_cash + ? WHERE id = ?").bind(totalTradeCk, user.id),
      env.DB.prepare(`
        INSERT INTO transactions (user_id, ticker, type, shares, price, total_value_pln, thesis, ai_roast)
        VALUES (?, ?, 'SELL', ?, ?, ?, ?, ?)
      `).bind(user.id, ticker, shares, inst.price, totalTradeCk, thesis.trim(), aiRoast)
    ];

    if (remainingShares <= 0.0001) {
      batchQueries.push(env.DB.prepare("DELETE FROM holdings WHERE user_id = ? AND ticker = ?").bind(user.id, ticker));
    } else {
      batchQueries.push(env.DB.prepare("UPDATE holdings SET shares = ? WHERE user_id = ? AND ticker = ?").bind(remainingShares, user.id, ticker));
    }

    await env.DB.batch(batchQueries);
    await logAudit(env, user.id, "TRADE_SELL", { ticker, shares, totalTradeCk }, clientIp, "SUCCESS");
    return jsonResponse({ status: "success", message: "Zlecenie sprzedaży zrealizowane pomyślnie!" });
  }
}
