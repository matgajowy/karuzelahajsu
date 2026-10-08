import { jsonResponse } from "../lib/http.js";
import { getSessionUser, logAudit } from "../lib/auth.js";
import { syncAllMarketPrices } from "../services/pricing.js";

export async function handleAdminUsers(context) {
  const { request, env, clientIp } = context;
  const user = await getSessionUser(request, env);
  if (!user || user.is_admin !== 1) {
    return jsonResponse({ status: "error", message: "Brak uprawnień administratora." }, 403);
  }

  if (request.method === "GET") {
    const { results } = await env.DB.prepare(`
      SELECT id, github_login, display_name, current_cash AS current_cash_ck, is_admin
      FROM users
      ORDER BY display_name COLLATE NOCASE
    `).all();
    return jsonResponse({ status: "success", data: results });
  }

  if (request.method !== "POST") {
    return jsonResponse({ status: "error", message: "Metoda niedozwolona." }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ status: "error", message: "Nieprawidłowe dane użytkownika." }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ status: "error", message: "Nieprawidłowe dane użytkownika." }, 400);
  }

  const githubLogin = typeof body.github_login === "string" ? body.github_login.trim() : "";
  const displayName = typeof body.display_name === "string" ? body.display_name.trim() : "";
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(githubLogin)) {
    return jsonResponse({ status: "error", message: "Nieprawidłowy login GitHub." }, 400);
  }
  if (displayName.length < 2 || displayName.length > 30) {
    return jsonResponse({ status: "error", message: "Nazwa wyświetlana musi mieć od 2 do 30 znaków." }, 400);
  }

  const existing = await env.DB.prepare(
    "SELECT id FROM users WHERE github_login = ?"
  ).bind(githubLogin).first();
  if (existing) {
    return jsonResponse({ status: "error", message: "Ten login GitHub jest już na liście." }, 409);
  }

  const isAdmin = body.is_admin === true ? 1 : 0;
  await env.DB.prepare(
    "INSERT INTO users (github_login, display_name, is_admin) VALUES (?, ?, ?)"
  ).bind(githubLogin, displayName, isAdmin).run();

  await logAudit(env, user.id, "ADMIN_USER_ADDED", { github_login: githubLogin, is_admin: isAdmin }, clientIp, "SUCCESS");
  return jsonResponse({ status: "success", message: "Użytkownik dodany do ligi." }, 201);
}

export async function handleAuditLogs(context) {
  const { request, env, url, clientIp } = context;
  const user = await getSessionUser(request, env);
  if (!user || user.is_admin !== 1) {
    return jsonResponse({ status: "error", message: "Brak uprawnień administratora." }, 403);
  }

  const query = `
    SELECT
      a.id,
      a.action,
      a.payload,
      a.ip_address,
      a.status,
      a.created_at,
      COALESCE(u.display_name, 'Niezalogowany / System') AS user_name
    FROM audit_log a
    LEFT JOIN users u ON a.user_id = u.id
    ORDER BY a.created_at DESC
    LIMIT 100
  `;
  const { results } = await env.DB.prepare(query).all();
  return jsonResponse({ status: "success", data: results });
}

export async function handlePriceSync(context) {
  const { request, env, url, clientIp } = context;
  const user = await getSessionUser(request, env);
  if (!user || user.is_admin !== 1) {
    return jsonResponse({ status: "error", message: "Brak uprawnień administratora." }, 403);
  }

  const result = await syncAllMarketPrices(env);
  const message = result.status === "success"
    ? "Wszystkie kursy zostały zaktualizowane."
    : result.status === "partial"
      ? `Częściowa synchronizacja: zaktualizowano ${result.summary.updated_count}, błędy dla ${result.summary.failed_count} tickerów.`
      : "Synchronizacja nie powiodła się; kursy nie zostały zaktualizowane.";
  return jsonResponse({
    status: "success",
    sync_status: result.status,
    summary: result.summary,
    message,
    logs: result.logs,
  });
}

export async function handleResetBenchmarks(context) {
  const { request, env, clientIp } = context;
  const user = await getSessionUser(request, env);
  if (!user || user.is_admin !== 1) {
    return jsonResponse({ status: "error", message: "Brak uprawnień administratora." }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ status: "error", message: "Nieprawidłowe dane potwierdzenia." }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      body.confirmPhrase !== "RESET-BENCHMARKS") {
    return jsonResponse({ status: "error", message: "Wymagane potwierdzenie RESET-BENCHMARKS." }, 400);
  }

  const { results: benchmarks } = await env.DB.prepare(`
    SELECT u.id, u.github_login, p.price, p.fx_to_pln
    FROM users u
    LEFT JOIN market_prices p ON p.ticker = CASE u.github_login
      WHEN 'benchmark_sp500' THEN '^GSPC'
      WHEN 'benchmark_wig20' THEN 'WIG20'
    END
    WHERE u.github_login IN ('benchmark_sp500', 'benchmark_wig20')
  `).all();
  const benchmarkByLogin = new Map(benchmarks.map(benchmark => [benchmark.github_login, benchmark]));
  const expectedBenchmarks = [
    ["benchmark_sp500", "^GSPC"],
    ["benchmark_wig20", "WIG20"],
  ];
  for (const [login, ticker] of expectedBenchmarks) {
    const benchmark = benchmarkByLogin.get(login);
    if (!benchmark || !Number.isFinite(Number(benchmark.price)) ||
        Number(benchmark.price) <= 0 || !Number.isFinite(Number(benchmark.fx_to_pln)) ||
        Number(benchmark.fx_to_pln) <= 0) {
      return jsonResponse({
        status: "error",
        message: `Brak prawidłowego kursu ${ticker} lub uczestnika ${login}. Odśwież kursy i spróbuj ponownie.`,
      }, 409);
    }
  }

  const statements = [
    env.DB.prepare(`
      UPDATE users SET current_cash = 0.0
      WHERE github_login IN ('benchmark_sp500', 'benchmark_wig20')
    `),
    env.DB.prepare(`
      DELETE FROM holdings
      WHERE user_id IN (
        SELECT id FROM users WHERE github_login IN ('benchmark_sp500', 'benchmark_wig20')
      )
    `),
    ...expectedBenchmarks.map(([login, ticker]) => env.DB.prepare(`
      INSERT INTO holdings (user_id, ticker, shares, avg_buy_price)
      SELECT u.id, ?, 100000.0 / (p.price * p.fx_to_pln), p.price
      FROM users u
      JOIN market_prices p ON p.ticker = ?
      WHERE u.github_login = ?
      ON CONFLICT(user_id, ticker) DO UPDATE SET
        shares = excluded.shares,
        avg_buy_price = excluded.avg_buy_price
    `).bind(ticker, ticker, login)),
  ];

  const { results: snapshotTables } = await env.DB.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'period_snapshots'
  `).all();
  if (snapshotTables.length > 0) {
    const { results: snapshotColumns } = await env.DB.prepare("PRAGMA table_info(period_snapshots)").all();
    const columns = new Set(snapshotColumns.map(column => column.name));
    if (!columns.has("start_valuation_pln") || !columns.has("user_id")) {
      return jsonResponse({
        status: "error",
        message: "Nieobsługiwany schemat tabeli period_snapshots; reset został przerwany.",
      }, 500);
    }

    let activeCycleFilter = "";
    const periodReference = columns.has("cycle_id")
      ? { column: "cycle_id", table: "cycles" }
      : columns.has("period_id")
        ? { column: "period_id", table: "periods" }
        : null;
    if (periodReference) {
      const { results: referenceTables } = await env.DB.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
      `).bind(periodReference.table).all();
      if (referenceTables.length > 0) {
        const { results: referenceColumns } = await env.DB.prepare(
          `PRAGMA table_info("${periodReference.table}")`
        ).all();
        const referenceColumnNames = new Set(referenceColumns.map(column => column.name));
        const activeColumn = ["is_active", "active"].find(column => referenceColumnNames.has(column));
        if (activeColumn) {
          activeCycleFilter = ` AND ${periodReference.column} IN (SELECT id FROM "${periodReference.table}" WHERE "${activeColumn}" = 1)`;
        } else if (referenceColumnNames.has("status")) {
          activeCycleFilter = ` AND ${periodReference.column} IN (SELECT id FROM "${periodReference.table}" WHERE UPPER(status) = 'ACTIVE')`;
        }
      }
    }
    if (!activeCycleFilter && columns.has("is_active")) {
      activeCycleFilter = " AND is_active = 1";
    } else if (!activeCycleFilter && columns.has("active")) {
      activeCycleFilter = " AND active = 1";
    } else if (!activeCycleFilter && columns.has("status")) {
      activeCycleFilter = " AND status = 'active'";
    }

    if (!activeCycleFilter) {
      return jsonResponse({
        status: "error",
        message: "Nie udało się ustalić aktywnych cykli w period_snapshots; reset został przerwany.",
      }, 500);
    }
    statements.push(env.DB.prepare(`
      UPDATE period_snapshots SET start_valuation_pln = 100000.0
      WHERE user_id IN (
        SELECT id FROM users WHERE github_login IN ('benchmark_sp500', 'benchmark_wig20')
      )${activeCycleFilter}
    `));
  }

  statements.push(env.DB.prepare(`
    INSERT INTO audit_log (user_id, action, payload, ip_address, status)
    VALUES (?, 'ADMIN_RESET_BENCHMARKS', ?, ?, 'SUCCESS')
  `).bind(user.id, JSON.stringify({
    benchmarks: expectedBenchmarks.map(([login, ticker]) => ({ login, ticker, starting_value_ck: 100000 })),
  }), clientIp));

  await env.DB.batch(statements);
  return jsonResponse({
    status: "success",
    message: "Benchmarki S&P 500 i WIG20 zresetowano do 100 000 CK według bieżących kursów.",
  });
}
