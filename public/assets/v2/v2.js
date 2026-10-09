/*
 * Karuzela Hajsu — interfejs v2: rozszerzenia widoków Portfel i Zlecenie.
 * Ładowany po wspólnych skryptach (state/api/utils/leaderboard/portfolio/trading/app/events),
 * z których korzysta przez globalne funkcje i zmienne. Nic z tego pliku nie trafia do starego UI.
 */
(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const ck = value => formatCK(value, false);
  const pct = (value, digits = 1) => `${num(value).toFixed(digits).replace(".", ",")}%`;
  const signed = (value, digits = 2) => `${value > 0 ? "+" : ""}${num(value).toFixed(digits).replace(".", ",")}`;
  const MIN_THESIS = 15;
  const LIMIT_PCT = 35;
  const POLL_MS = 15000;

  const state = { board: [], transactions: [], filter: "all", sort: "value", rankFilter: "all", allocation: null, polling: false };

  const marketOf = ticker => (String(ticker).toUpperCase().endsWith(".WA") ? "GPW" : "USA");
  const initials = name => String(name || "?").replace(/[^A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż0-9 ]/g, "").trim().slice(0, 2).toUpperCase() || "?";

  function parseDate(value) {
    const text = String(value || "");
    const iso = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text.replace(" ", "T")}Z`;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function relativeDate(value) {
    const date = parseDate(value);
    if (!date) return "—";
    const time = date.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
    const startOf = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((startOf(new Date()) - startOf(date)) / 86400000);
    if (days <= 0) return `Dziś, ${time}`;
    if (days === 1) return `Wczoraj, ${time}`;
    if (days < 7) return `${days} dni temu`;
    return date.toLocaleDateString("pl-PL", { day: "numeric", month: "short" });
  }

  function agoLabel(value) {
    const date = parseDate(value);
    if (!date) return "—";
    const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
    if (minutes < 1) return "przed chwilą";
    if (minutes < 60) return `${minutes} min temu`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} godz. temu`;
    return relativeDate(value);
  }

  /* ---------------- Toasty (zamiast alert()) ---------------- */
  function toast(message, kind = "info") {
    const host = $("v2Toasts");
    if (!host) return;
    const item = document.createElement("div");
    item.className = "v2-toast";
    item.dataset.kind = kind;
    item.textContent = String(message);
    host.appendChild(item);
    requestAnimationFrame(() => item.classList.add("in"));
    setTimeout(() => {
      item.classList.remove("in");
      setTimeout(() => item.remove(), 250);
    }, kind === "error" ? 6000 : 3800);
  }
  window.alert = message => {
    const text = String(message);
    toast(text, /pomyślnie/i.test(text) ? "success" : "info");
  };

  /* ---------------- Dane portfela ---------------- */
  function portfolioSummary() {
    const cash = num(currentUser?.current_cash);
    const positions = (userHoldings || []).map(holding => {
      const value = num(holding.current_value_ck ?? holding.current_value_pln);
      const cost = num(holding.avg_buy_price) * num(holding.shares) * num(holding.fx_to_ck || 1);
      return { ...holding, market: marketOf(holding.ticker), value, cost, pnl: value - cost };
    });
    const stocks = positions.reduce((sum, p) => sum + p.value, 0);
    const total = cash + stocks;
    positions.forEach(p => { p.share = total > 0 ? (p.value / total) * 100 : 0; });
    return { cash, stocks, total, positions };
  }

  function myBoardRow() {
    return state.board.find(row => currentUser && Number(row.id) === Number(currentUser.id)) || null;
  }

  function benchmarkRow(login) {
    return state.board.find(row => row.github_login === login) || null;
  }

  /* ---------------- Render: Portfel ---------------- */
  function renderStats() {
    const { cash, stocks, total, positions } = portfolioSummary();
    const row = myBoardRow();
    const delta = $("v2TotalDelta");
    if (delta) {
      if (row) {
        const profit = num(row.Zysk_Strata_CK);
        const ret = num(row.Stopa_Zwrotu) * 100;
        const cls = Math.abs(ret) < 0.005 ? "flat" : ret > 0 ? "up" : "down";
        delta.innerHTML = `<span class="v2-delta ${cls}">${signed(ret)}%</span><span>${signed(profit)} CK od startu ligi</span>`;
      } else {
        delta.textContent = "—";
      }
    }

    const cashShare = total > 0 ? (cash / total) * 100 : 0;
    $("v2CashShare").textContent = `${pct(cashShare)} kapitału`;
    const liquidity = $("v2Liquidity");
    liquidity.textContent = cashShare >= 20 ? "Bufor bezpieczny" : cashShare >= 5 ? "Bufor umiarkowany" : "Niski bufor";
    liquidity.dataset.tone = cashShare >= 20 ? "good" : cashShare >= 5 ? "warn" : "bad";

    $("v2StocksValue").innerHTML = formatCK(stocks, true, true);
    const exposure = total > 0 ? (stocks / total) * 100 : 0;
    $("v2Exposure").textContent = pct(exposure);
    $("v2PositionCount").textContent = `(${positions.length} ${positions.length === 1 ? "walor" : "walory"})`;
    const risk = $("v2Risk");
    risk.textContent = exposure >= 80 ? "Ryzyko: wysokie" : exposure >= 50 ? "Ryzyko: umiarkowane" : "Ryzyko: niskie";
    risk.dataset.tone = exposure >= 80 ? "bad" : exposure >= 50 ? "warn" : "good";

    renderExposure(positions, cash, total);
    const badge = $("v2PositionsBadge");
    if (badge) badge.textContent = String(positions.length);
    const rankChip = $("v2RankChip");
    if (rankChip) {
      const rank = myRank();
      rankChip.classList.toggle("hidden", !rank);
      if (rank) rankChip.textContent = rank === 1 ? "👑 Lider Ringu #1" : `#${rank} w Ringu`;
    }

    const top = positions.slice().sort((a, b) => b.share - a.share)[0];
    const card = $("v2CodexCard");
    if (!top) {
      $("v2MaxPos").textContent = "0,0%";
      $("v2MaxPosBar").style.width = "0";
      $("v2CodexNote").textContent = "Brak otwartych pozycji.";
      card.dataset.state = "ok";
      return;
    }
    $("v2MaxPos").textContent = pct(top.share);
    $("v2MaxPosBar").style.width = `${Math.min(100, (top.share / LIMIT_PCT) * 100)}%`;
    card.dataset.state = top.share > LIMIT_PCT ? "bad" : top.share >= 30 ? "warn" : "ok";
    const verdict = top.share > LIMIT_PCT ? "Powyżej limitu" : top.share >= 30 ? "Blisko limitu" : "W normie";
    $("v2CodexNote").innerHTML = `<b>${verdict}.</b> Największa pozycja: ${escapeHtml(top.ticker)} (${pct(top.share)}).`;
  }

  const SEGMENT_TONES = ["#4edea3", "#ffb95f", "#7aa8ff", "#c79bff", "#ff8f87"];

  function renderExposure(positions, cash, total) {
    const bar = $("v2ExposureBar");
    const legend = $("v2ExposureLegend");
    if (!bar || !legend) return;
    if (!positions.length || total <= 0) {
      bar.innerHTML = "";
      legend.innerHTML = "";
      return;
    }
    const sorted = positions.slice().sort((a, b) => b.share - a.share);
    const segments = sorted.slice(0, 4).map((p, index) => ({ label: p.ticker.replace(/\.WA$/, ""), share: p.share, tone: SEGMENT_TONES[index] }));
    const restShare = sorted.slice(4).reduce((sum, p) => sum + p.share, 0);
    if (restShare > 0.05) segments.push({ label: "Pozostałe", share: restShare, tone: "#5d6b80" });
    segments.push({ label: "Gotówka", share: (cash / total) * 100, tone: "#86948a" });
    bar.innerHTML = segments.map(seg => `<span style="width:${seg.share.toFixed(2)}%;background:${seg.tone}" title="${escapeHtml(seg.label)} ${pct(seg.share)}"></span>`).join("");
    legend.innerHTML = segments.map(seg => `<span><i style="background:${seg.tone}"></i>${escapeHtml(seg.label)} <b>${pct(seg.share)}</b></span>`).join("");
  }

  function myRank() {
    if (!currentUser) return 0;
    const players = state.board.filter(row => !isBenchRow(row));
    const index = players.findIndex(row => Number(row.id) === Number(currentUser.id));
    return index === -1 ? 0 : index + 1;
  }

  function isBenchRow(item) {
    const name = String(item.Uczestnik || "").toLowerCase();
    return item.github_login === "benchmark_sp500" || item.github_login === "benchmark_wig20" ||
      name.includes("benchmark") || name.includes("index") || name.includes("s&p") || name.includes("wig");
  }

  function renderPositions() {
    const body = $("portfolioTableBody");
    if (!body) return;
    const { positions } = portfolioSummary();
    const rows = positions
      .filter(p => state.filter === "all" || p.market === state.filter)
      .sort((a, b) => (state.sort === "profit" ? b.pnl - a.pnl : b.value - a.value));

    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="8" class="v2-empty">${positions.length
        ? "Brak pozycji na wybranym rynku."
        : 'Brak otwartych pozycji. Kliknij „Nowe zlecenie”, aby zainwestować.'}</td></tr>`;
      return;
    }

    body.innerHTML = rows.map(p => {
      const ret = num(p.return_pct);
      const tone = Math.abs(ret) < 0.005 ? "flat" : ret > 0 ? "up" : "down";
      const open = p.market_status?.is_open !== false;
      const loss = ret < 0;
      const closedTitle = open ? "" : ` title="Rynek ${escapeHtml(p.market_status?.market || "")} jest zamknięty"`;
      return `
        <tr>
          <td data-label="Spółka" class="co">
            <div class="v2-co">
              <span class="v2-ini">${escapeHtml(initials(p.name))}</span>
              <div><b>${escapeHtml(p.name)}</b><small>${escapeHtml(p.ticker)} · ${p.market === "GPW" ? "🇵🇱 GPW" : "🇺🇸 USA"}</small></div>
            </div>
          </td>
          <td data-label="Liczba akcji" class="num">${escapeHtml(p.shares)} szt.</td>
          <td data-label="Śr. zakup" class="num">${escapeHtml(formatQuotePrice(p.avg_buy_price, p.currency))}</td>
          <td data-label="Kurs bieżący" class="num">${escapeHtml(formatQuotePrice(p.current_price, p.currency))}</td>
          <td data-label="Wycena (CK)" class="num strong">${formatCK(p.value)}</td>
          <td data-label="Udział" class="num">
            <span class="v2-share">${pct(p.share)}</span>
            <span class="v2-mini-meter"><i style="width:${Math.min(100, p.share).toFixed(1)}%"></i></span>
          </td>
          <td data-label="P&L" class="num pnl ${tone}"><b>${signed(p.pnl)} CK</b><small>${ret > 0 ? "▲" : ret < 0 ? "▼" : "•"} ${signed(ret)}%</small></td>
          <td data-label="Akcje" class="act">
            <button type="button" class="v2-act buy" data-v2-action="buy-more" data-ticker="${escapeHtml(p.ticker)}">${loss ? "Uśrednij (kup)" : "Dokup"}</button>
            <button type="button" class="v2-act sell" data-action="open-smart-sell" data-ticker="${escapeHtml(p.ticker)}" ${open ? "" : "disabled"}${closedTitle}>${open ? "" : '<span class="material-symbols-outlined" aria-hidden="true">lock</span>'}${loss ? "Tnij stratę" : "Zrealizuj zysk"}</button>
          </td>
        </tr>`;
    }).join("");
  }

  function renderJournal() {
    const host = $("v2JournalList");
    if (!host) return;
    if (!state.transactions.length) {
      host.innerHTML = '<p class="v2-empty">Nie masz jeszcze żadnych transakcji.</p>';
      return;
    }
    host.innerHTML = state.transactions.map(t => {
      const buy = t.type === "BUY";
      return `
        <article class="v2-tx">
          <div class="v2-tx-top">
            <span class="v2-badge ${buy ? "buy" : "sell"}">${buy ? "Kupno" : "Sprzedaż"}</span>
            <b>${escapeHtml(t.company_name)} <span class="v2-muted">(${escapeHtml(t.ticker)})</span></b>
            <span class="v2-tx-when">${escapeHtml(relativeDate(t.created_at))}</span>
          </div>
          <p class="v2-tx-meta">${escapeHtml(t.shares)} szt. @ ${escapeHtml(formatQuotePrice(t.price, t.currency))} · wartość ${ck(t.total_value_ck)}</p>
          <blockquote>${escapeHtml(t.thesis)}</blockquote>
          <button type="button" class="v2-link-btn" data-v2-action="show-on-ring"><span class="material-symbols-outlined" aria-hidden="true">share</span>Pokaż na Ringu</button>
        </article>`;
    }).join("");
  }

  function renderAlpha() {
    const host = $("v2Alpha");
    if (!host) return;
    const { cash, total, positions } = portfolioSummary();
    const row = myBoardRow();
    if (!row) {
      host.innerHTML = '<p class="v2-empty">Brak danych rankingowych.</p>';
      return;
    }
    const mine = num(row.Stopa_Zwrotu) * 100;
    const bench = (login, label) => {
      const r = benchmarkRow(login);
      if (!r) return "";
      const b = num(r.Stopa_Zwrotu) * 100;
      const alpha = mine - b;
      return `
        <div class="v2-alpha ${alpha >= 0 ? "up" : "down"}">
          <small>Alfa vs ${label}</small>
          <b>${signed(alpha)} p.p.</b>
          <span>${alpha >= 0 ? "przewaga" : "strata"} · ${label}: ${signed(b)}%</span>
        </div>`;
    };

    const usa = positions.filter(p => p.market === "USA").reduce((s, p) => s + p.value, 0);
    const gpw = positions.filter(p => p.market === "GPW").reduce((s, p) => s + p.value, 0);
    const usdShare = total > 0 ? (positions.filter(p => p.currency === "USD").reduce((s, p) => s + p.value, 0) / total) * 100 : 0;
    const bar = (label, value, tone) => {
      const share = total > 0 ? (value / total) * 100 : 0;
      return `
        <div class="v2-bar">
          <div><span>${label}</span><b>${pct(share)}</b></div>
          <span class="v2-bar-track"><i data-tone="${tone}" style="width:${share.toFixed(1)}%"></i></span>
        </div>`;
    };

    host.innerHTML = `
      <div class="v2-alphas">
        ${bench("benchmark_sp500", "S&amp;P 500")}
        ${bench("benchmark_wig20", "WIG20")}
      </div>
      <h4 class="v2-label" style="margin:1.1rem 0 .6rem">Ekspozycja rynkowa</h4>
      ${bar("Akcje USA (NASDAQ / NYSE)", usa, "usa")}
      ${bar("Akcje GPW", gpw, "gpw")}
      ${bar("Wolna gotówka (CK)", cash, "cash")}
      <p class="v2-tip"><span class="material-symbols-outlined" aria-hidden="true">tips_and_updates</span>Struktura walutowa: USD ${pct(usdShare, 0)} / PLN ${pct(100 - usdShare, 0)} (gotówka liczona jako PLN).</p>`;
  }

  function renderPortfolioV2() {
    renderUserChrome();
    if (!$("v2TotalDelta")) return;
    renderStats();
    renderPositions();
    renderAlpha();
    renderJournal();
  }

  async function loadTransactions() {
    if (!currentUser) return;
    try {
      const result = await apiRequest("/api/my-transactions");
      state.transactions = result.data || [];
    } catch (error) {
      console.error("Transactions error:", error);
    }
    renderJournal();
  }

  /* ---------------- Podpięcie pod wspólne funkcje ---------------- */
  const originalFetchPortfolio = fetchUserPortfolio;
  window.fetchUserPortfolio = async function fetchUserPortfolioV2(...args) {
    const result = await originalFetchPortfolio.apply(this, args);
    renderPortfolioV2();
    refreshTrade();
    return result;
  };

  const originalRenderDashboard = renderDashboard;
  window.renderDashboard = function renderDashboardV2(items, ...rest) {
    state.board = Array.isArray(items) ? items : [];
    const result = originalRenderDashboard.call(this, items, ...rest);
    renderRing();
    renderAlpha();
    renderStats();
    return result;
  };

  /* ---------------- Render: Ring ---------------- */
  const retPct = row => num(row?.Stopa_Zwrotu) * 100;
  const retClass = value => (Math.abs(value) < 0.005 ? "flat" : value > 0 ? "up" : "down");

  function renderRing() {
    if (!$("v2MarketAvg")) return;
    const players = state.board.filter(row => !isBenchRow(row));
    const sp = benchmarkRow("benchmark_sp500");
    const wig = benchmarkRow("benchmark_wig20");
    const benches = [sp, wig].filter(Boolean);
    const marketAvg = benches.length ? benches.reduce((sum, r) => sum + retPct(r), 0) / benches.length : 0;

    const leader = players[0];
    if (leader) {
      $("v2LeaderLogin").textContent = leader.github_login ? `@${leader.github_login}` : "";
      const profit = num(leader.Zysk_Strata_CK);
      $("v2LeaderProfit").textContent = `${signed(profit)} CK od startu`;
      $("v2LeaderCash").textContent = ck(leader.Gotowka_CK);
      $("leaderReturn").className = `v2-leader-return font-mono ${retClass(retPct(leader))}`;
    }

    $("v2BenchSpValue").textContent = sp ? `Wycena: ${ck(sp.Wycena_Calkowita_CK)}` : "—";
    $("v2BenchWigValue").textContent = wig ? `Wycena: ${ck(wig.Wycena_Calkowita_CK)}` : "—";
    $("v2MarketAvg").textContent = benches.length ? `${signed(marketAvg)}%` : "—";

    if (players.length) {
      const avg = players.reduce((sum, r) => sum + retPct(r), 0) / players.length;
      const alpha = avg - marketAvg;
      const alphaEl = $("v2Alpha2");
      alphaEl.textContent = `${signed(alpha)} p.p.`;
      alphaEl.className = retClass(alpha);
      const dominanceEl = $("v2Dominance");
      if (marketAvg > 0.005) {
        const dominance = (avg / marketAvg - 1) * 100;
        dominanceEl.textContent = `${signed(dominance, 1)}%`;
        dominanceEl.className = retClass(dominance);
      } else {
        dominanceEl.textContent = "—";
        dominanceEl.className = "";
      }
      $("v2TotalValuation").textContent = ck(players.reduce((sum, r) => sum + num(r.Wycena_Calkowita_CK), 0));
      $("avgReturn").classList.toggle("up", avg > 0);
      $("v2RankCount").textContent = `${players.length} aktywnych spekulantów • ${benches.length} ${benches.length === 1 ? "indeks" : "indeksy"}`;
    }

    decorateRanking(players, marketAvg);
    renderUserChrome(players);
  }

  const RANK_LABELS = ["#", "Uczestnik", "Wycena portfela", "Gotówka", "Wynik", "Stopa zwrotu"];

  function decorateRanking(players, marketAvg) {
    const body = $("leaderboardBody");
    if (!body) return;
    body.dataset.filter = state.rankFilter;
    let playerIndex = 0;
    body.querySelectorAll(":scope > tr").forEach(row => {
      const isPlayer = row.dataset.action === "toggle-opponent-accordion";
      row.dataset.kind = isPlayer ? "player" : "bench";
      row.querySelectorAll(":scope > td").forEach((cell, index) => { cell.dataset.label = RANK_LABELS[index] || ""; });
      if (!isPlayer) return;
      const player = players[playerIndex++];
      const nameLine = row.querySelector("td:nth-child(2) span");
      if (!player || !nameLine || nameLine.querySelector(".v2-chip")) return;
      if (playerIndex === 1) nameLine.insertAdjacentHTML("beforeend", '<span class="v2-chip gold">Lider</span>');
      else if (retPct(player) < marketAvg) nameLine.insertAdjacentHTML("beforeend", '<span class="v2-chip warn">Poniżej indeksu</span>');
    });
  }

  function renderUserChrome(players) {
    const card = $("v2UserCard");
    const pill = $("v2ValuePill");
    if (!card || !pill) return;
    const row = myBoardRow();
    const visible = Boolean(currentUser && row);
    card.classList.toggle("hidden", !visible);
    pill.classList.toggle("hidden", !visible);
    if (!visible) return;
    const rank = myRank();
    $("v2UserAvatar").src = currentUser.avatar_url || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(currentUser.display_name)}`;
    $("v2UserName").textContent = currentUser.display_name;
    $("v2UserRank").textContent = rank === 1 ? "Lider Ringu #1" : rank ? `#${rank} w Ringu` : "Gracz";
    $("v2UserCash").textContent = ck(currentUser.current_cash ?? row.Gotowka_CK);
    $("v2ValueCk").textContent = ck(row.Wycena_Calkowita_CK);
    const value = retPct(row);
    const change = $("v2ValuePct");
    change.textContent = `(${signed(value)}%)`;
    change.className = retClass(value);
  }

  /* ---------------- Alokacja ligi ---------------- */
  async function loadAllocation() {
    try {
      const result = await apiRequest("/api/league-allocation");
      state.allocation = result.data;
    } catch (error) {
      console.error("Allocation error:", error);
      return;
    }
    renderAllocation();
  }

  function renderAllocation() {
    const host = $("v2Allocation");
    const data = state.allocation;
    if (!host || !data) return;
    const total = num(data.gpw_ck) + num(data.usa_ck) + num(data.cash_ck);
    const share = value => (total > 0 ? (num(value) / total) * 100 : 0);
    const rows = [
      { label: "Akcje GPW", value: data.gpw_ck, tone: "gpw" },
      { label: "Akcje USA (NASDAQ / NYSE)", value: data.usa_ck, tone: "usa" },
      { label: "Gotówka", value: data.cash_ck, tone: "cash" },
    ];
    host.innerHTML = rows.map(r => `
      <div class="v2-bar">
        <div><span>${r.label}</span><b>${pct(share(r.value))} <span class="v2-muted">· ${ck(r.value)}</span></b></div>
        <span class="v2-bar-track"><i data-tone="${r.tone}" style="width:${share(r.value).toFixed(1)}%"></i></span>
      </div>`).join("");
    const [gpw, usa] = rows;
    const leading = num(usa.value) >= num(gpw.value) ? "amerykańskich" : "polskich";
    const leadingShare = Math.max(share(gpw.value), share(usa.value));
    $("v2AllocInsight").textContent = total > 0
      ? `Gracze trzymają najwięcej w akcjach ${leading} spółek (${pct(leadingShare)}); gotówka to ${pct(share(data.cash_ck))}.`
      : "Brak danych o alokacji.";
  }

  const originalFetchAllData = fetchAllData;
  window.fetchAllData = async function fetchAllDataV2(...args) {
    const result = await originalFetchAllData.apply(this, args);
    await loadAllocation();
    return result;
  };

  /* ---------------- Feed ---------------- */
  window.fetchFeed = async function fetchFeedV2() {
    const container = $("feedContainer");
    try {
      const json = await apiRequest("/api/feed");
      if (json.status !== "success" || !json.data.length) {
        container.innerHTML = '<div class="v2-empty">Brak ostatnich transakcji.</div>';
        return;
      }
      container.innerHTML = json.data.map(item => {
        const buy = item.type === "BUY";
        const ticker = String(item.ticker ?? "").toUpperCase();
        const benchTicker = ["^GSPC", "WIG20", "WIG20.WA"].includes(ticker);
        const canCopy = buy && !isBenchmark(item.user_name) && !benchTicker;
        const shares = num(item.shares);
        const totalCk = num(item.total_value_ck ?? item.total_value_pln);
        const perShare = shares > 0 ? totalCk / shares : 0;
        const avatar = item.avatar_url || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(item.user_name)}`;
        return `
          <article class="v2-post">
            <header>
              <img src="${escapeHtml(avatar)}" alt="">
              <div><b>${escapeHtml(item.user_name)}</b><small>${escapeHtml(agoLabel(item.created_at))}</small></div>
              <span class="v2-badge ${buy ? "buy" : "sell"}">${buy ? "Buy" : "Sell"}</span>
            </header>
            <div class="v2-post-deal">
              <div><b>${escapeHtml(item.shares)} szt. ${escapeHtml(item.company_name || item.ticker)}</b><small>${escapeHtml(ticker)} • ${marketOf(ticker) === "GPW" ? "GPW" : "USA"} · @ ${ck(perShare)}</small></div>
              <b class="v2-post-total font-mono">${ck(totalCk)}</b>
            </div>
            <blockquote>${escapeHtml(item.thesis)}</blockquote>
            ${canCopy ? `<button type="button" class="v2-copy" data-action="copy-feed-trade" data-ticker="${escapeHtml(item.ticker)}" data-user-name="${escapeHtml(item.user_name)}"><span class="material-symbols-outlined" aria-hidden="true">bolt</span>Kopiuj ruch</button>` : ""}
          </article>`;
      }).join("");
    } catch (error) {
      console.error("Feed error:", error);
    }
  };

  if (window.karuzela && typeof window.karuzela.copyTrade === "function") {
    const originalCopyTrade = window.karuzela.copyTrade;
    window.karuzela.copyTrade = async function copyTradeV2(...args) {
      const loggedIn = Boolean(currentUser);
      const result = await originalCopyTrade.apply(this, args);
      if (loggedIn) toast("Skopiowano zlecenie do formularza!", "success");
      return result;
    };
  }

  /* ---------------- Status giełd ---------------- */
  const WARSAW = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Warsaw", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  function renderMarkets() {
    const host = $("v2Markets");
    if (!host) return;
    const parts = Object.fromEntries(WARSAW.formatToParts(new Date()).map(part => [part.type, part.value]));
    const minutes = Number(parts.hour) * 60 + Number(parts.minute);
    const weekday = !["Sat", "Sun"].includes(parts.weekday);
    const gpw = weekday && minutes >= 9 * 60 && minutes < 17 * 60;
    const usa = weekday && minutes >= 15 * 60 + 30 && minutes < 22 * 60;
    const dot = open => `<i class="${open ? "on" : ""}"></i>`;
    host.innerHTML = `<span>${dot(gpw)}GPW: ${gpw ? "Otwarte" : "Zamknięte"}</span><span>${dot(usa)}NYSE: ${usa ? "Otwarte" : "Zamknięte"}</span>`;
  }
  renderMarkets();
  setInterval(renderMarkets, 30000);

  const originalSwitchTab = switchTab;
  window.switchTab = function switchTabV2(tabId) {
    const result = originalSwitchTab.call(this, tabId);
    if (tabId === "portfolio" && currentUser) loadTransactions();
    return result;
  };

  /* ---------------- Zlecenie ---------------- */
  function tradeContext() {
    const { cash, total, positions } = portfolioSummary();
    const shares = num($("tradeShares")?.value);
    const price = num(verifiedInstrument?.price_ck);
    const value = Number.isInteger(shares) && shares > 0 ? shares * price : 0;
    return { cash, total, positions, shares, price, value };
  }

  function refreshTrade() {
    if (!$("v2CashAfter")) return;
    const { cash, total, positions, shares, price, value } = tradeContext();
    const buy = currentTradeType === "BUY";

    $("v2TradeTotal").innerHTML = currentUser ? formatCK(total, true) : "—";

    document.querySelectorAll("[data-quick-amount]").forEach(el => {
      el.textContent = ck(Math.floor(cash * num(el.dataset.quickAmount)));
    });

    if (verifiedInstrument && verifiedInstrument.currency && verifiedInstrument.currency !== "PLN" && price > 0) {
      $("instPriceDisplay").textContent = ck(price);
      $("instFxDisplay").textContent = `(${formatQuotePrice(verifiedInstrument.price, verifiedInstrument.currency)})`;
    }

    const initial = $("v2InstInitial");
    if (initial) initial.textContent = initials(verifiedInstrument?.name || verifiedInstrument?.ticker);

    const after = buy ? cash - value : cash + value;
    $("v2CashAfterLabel").textContent = buy ? "Gotówka po transakcji" : "Gotówka po sprzedaży";
    const afterEl = $("v2CashAfter");
    afterEl.textContent = ck(after);
    afterEl.dataset.tone = after < 0 ? "bad" : "";

    // Kodeks: limit koncentracji liczony tak jak w backendzie (pozycja po transakcji / wartość portfela).
    const box = $("v2Codex");
    const text = $("v2CodexText");
    let codexState = "idle";
    if (!verifiedInstrument || shares <= 0 || price <= 0) {
      text.textContent = buy
        ? "Wybierz walor i liczbę akcji, aby sprawdzić koncentrację portfela."
        : "Wybierz walor i liczbę akcji do sprzedaży.";
    } else if (buy) {
      const held = positions.find(p => p.ticker === verifiedInstrument.ticker);
      const postValue = num(held?.shares) * price + value;
      const share = total > 0 ? (postValue / total) * 100 : 0;
      if (value > cash) {
        codexState = "bad";
        text.innerHTML = `Niewystarczające środki: zlecenie wymaga <b>${ck(value)}</b>, masz <b>${ck(cash)}</b>.`;
      } else if (share > LIMIT_PCT + 0.01) {
        codexState = "bad";
        text.innerHTML = `Po zleceniu udział waloru wyniesie <b>${pct(share)}</b> portfela — przekracza limit ${LIMIT_PCT}%. Zlecenie zostanie odrzucone.`;
      } else {
        codexState = share >= 30 ? "warn" : "ok";
        text.innerHTML = `Po zleceniu udział waloru wyniesie <b>${pct(share)}</b> portfela (limit max. ${LIMIT_PCT}%). ${share >= 30 ? "Pozycja blisko limitu." : "Pozycja mieści się w normie."}`;
      }
    } else {
      const held = positions.find(p => p.ticker === verifiedInstrument.ticker);
      const rest = Math.max(0, (held ? held.value : 0) - value);
      const share = total > 0 ? (rest / total) * 100 : 0;
      codexState = "ok";
      text.innerHTML = `Po sprzedaży udział waloru spadnie do <b>${pct(share)}</b> portfela.`;
    }
    box.dataset.state = codexState;

    const thesis = $("tradeThesis").value.trim().length;
    const thesisCount = $("v2ThesisCount");
    thesisCount.textContent = `${thesis} / min. ${MIN_THESIS} znaków`;
    const thesisState = $("v2ThesisState");
    if (thesis === 0) {
      thesisState.dataset.state = "idle";
      thesisState.textContent = "Teza jest publiczna i widoczna dla całej ligi.";
    } else if (thesis < MIN_THESIS) {
      thesisState.dataset.state = "warn";
      thesisState.textContent = `Dopisz jeszcze ${MIN_THESIS - thesis} zn.`;
    } else {
      thesisState.dataset.state = "ok";
      thesisState.textContent = "Poprawna teza — gotowa do publikacji.";
    }

    const label = $("v2SubmitLabel");
    const verb = buy ? "Kupno" : "Sprzedaż";
    label.textContent = shares > 0 && Number.isInteger(shares)
      ? `Złóż zlecenie (${verb} ${shares} szt.)`
      : "Złóż zlecenie";
    $("submitTradeBtn").dataset.side = buy ? "buy" : "sell";
  }

  const originalAvailability = updateTradeAvailability;
  window.updateTradeAvailability = function updateTradeAvailabilityV2(...args) {
    const result = originalAvailability.apply(this, args);
    const submit = $("submitTradeBtn");
    const thesis = $("tradeThesis").value.trim().length;
    const { cash, total, positions, shares, price, value } = tradeContext();
    let blocked = thesis < MIN_THESIS;
    if (currentTradeType === "BUY" && value > cash) blocked = true;
    if (currentTradeType === "BUY" && verifiedInstrument && value > 0) {
      const held = positions.find(p => p.ticker === verifiedInstrument.ticker);
      const share = total > 0 ? ((num(held?.shares) * price + value) / total) * 100 : 0;
      if (share > LIMIT_PCT + 0.01) blocked = true;
    }
    if (blocked) submit.disabled = true;
    refreshTrade();
    return result;
  };

  const originalOpenTrade = openTradeModal;
  window.openTradeModal = function openTradeModalV2(type) {
    const result = originalOpenTrade.call(this, type);
    if (currentUser) {
      renderChips();
      refreshTrade();
      document.body.classList.add("v2-lock");
    }
    return result;
  };
  const originalCloseTrade = closeTradeModal;
  window.closeTradeModal = function closeTradeModalV2() {
    originalCloseTrade();
    document.body.classList.remove("v2-lock");
  };

  const originalSetTradeType = setTradeType;
  window.setTradeType = function setTradeTypeV2(type) {
    const result = originalSetTradeType.call(this, type);
    $("v2BuyQuick")?.classList.toggle("hidden", type !== "BUY");
    refreshTrade();
    return result;
  };

  function renderChips() {
    const host = $("v2Chips");
    if (!host) return;
    const seen = new Set();
    const tickers = [];
    const add = ticker => {
      const value = String(ticker || "").toUpperCase();
      if (!value || seen.has(value) || /^\^|^WIG20/.test(value)) return;
      seen.add(value);
      tickers.push(value);
    };
    (userHoldings || []).forEach(h => add(h.ticker));
    state.transactions.forEach(t => add(t.ticker));
    ["NVDA", "MSFT", "AAPL", "PKN.WA", "CDR.WA"].forEach(add);
    host.innerHTML = tickers.slice(0, 7).map(t =>
      `<button type="button" data-v2-action="pick-ticker" data-ticker="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join("");
  }

  async function startTrade(ticker) {
    openTradeModal("BUY");
    if (!currentUser) return;
    $("tradeTickerInput").value = ticker;
    await verifyTicker();
    $("tradeShares").focus();
  }

  function setShares(value) {
    const input = $("tradeShares");
    input.value = value > 0 ? String(value) : "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function exportCsv() {
    const { positions } = portfolioSummary();
    if (!positions.length) {
      toast("Brak pozycji do wyeksportowania.");
      return;
    }
    const header = ["ticker", "nazwa", "rynek", "akcje", "srednia_cena", "kurs", "waluta", "wycena_ck", "udzial_proc", "pnl_ck", "pnl_proc"];
    const lines = positions.map(p => [
      p.ticker, `"${String(p.name).replace(/"/g, '""')}"`, p.market, p.shares,
      num(p.avg_buy_price).toFixed(2), num(p.current_price).toFixed(2), p.currency,
      p.value.toFixed(2), p.share.toFixed(2), p.pnl.toFixed(2), num(p.return_pct).toFixed(2),
    ].join(","));
    const blob = new Blob([`﻿${[header.join(","), ...lines].join("\n")}`], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `portfel-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  const v2Actions = {
    "buy-more": element => startTrade(element.dataset.ticker),
    "pick-ticker": async element => {
      $("tradeTickerInput").value = element.dataset.ticker;
      await verifyTicker();
      $("tradeShares").focus();
    },
    "buy-percent": element => {
      if (!verifiedInstrument) {
        const error = $("tradeError");
        error.innerText = "Najpierw wybierz i zweryfikuj walor.";
        error.classList.remove("hidden");
        return;
      }
      $("tradeError").classList.add("hidden");
      const amount = Math.floor(num(currentUser?.current_cash) * num(element.dataset.percent) * 100) / 100;
      const input = $("tradeAmount");
      input.value = amount.toFixed(2);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    "step-up": () => {
      const next = Math.floor(num($("tradeShares").value)) + 1;
      setShares(currentTradeType === "SELL" ? Math.min(next, num(selectedHoldingMaxShares)) : next);
    },
    "step-down": () => setShares(Math.max(0, Math.floor(num($("tradeShares").value)) - 1)),
    "export-csv": exportCsv,
    "rank-filter": element => {
      state.rankFilter = element.dataset.filter;
      document.querySelectorAll('[data-v2-action="rank-filter"]').forEach(button =>
        button.toggleAttribute("data-active", button === element));
      const body = $("leaderboardBody");
      if (body) body.dataset.filter = state.rankFilter;
    },
    "sort-positions": element => {
      state.sort = element.dataset.sort;
      document.querySelectorAll('[data-v2-action="sort-positions"]').forEach(button =>
        button.toggleAttribute("data-active", button === element));
      renderPositions();
    },
    "analyze-portfolios": () => {
      $("rankingTitle")?.scrollIntoView({ behavior: "smooth", block: "start" });
      const first = document.querySelector('#leaderboardBody tr[data-action="toggle-opponent-accordion"]');
      if (first && first.getAttribute("aria-expanded") !== "true") first.click();
    },
    "open-audit": () => {
      if (currentUser?.is_admin === 1) switchTab("admin");
      else toast("Pełny rejestr audytu jest dostępny dla administratora ligi.");
    },
    "goto-journal": () => {
      loadTransactions();
      $("v2Journal")?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    "show-on-ring": () => {
      switchTab("arena");
      $("feedContainer")?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
  };

  document.addEventListener("click", event => {
    if (!(event.target instanceof Element)) return;
    const modal = $("tradeModal");
    if (event.target === modal) {
      closeTradeModal();
      return;
    }
    const element = event.target.closest("[data-v2-action]");
    if (!element) return;
    const action = v2Actions[element.dataset.v2Action];
    if (action) action(element);
  });

  document.addEventListener("input", event => {
    if (event.target instanceof HTMLElement && event.target.id === "tradeThesis") {
      updateTradeAvailability();
    }
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !$("tradeModal").classList.contains("hidden")) closeTradeModal();
  });

  document.addEventListener("change", event => {
    if (event.target instanceof HTMLSelectElement && event.target.id === "v2MarketFilter") {
      state.filter = event.target.value;
      renderPositions();
    }
  });

  /* ---------------- Auto-odświeżanie (Live · 15 s) ---------------- */
  async function poll() {
    if (state.polling || document.hidden) return;
    if (!$("tradeModal").classList.contains("hidden")) return;
    if (typeof expandedPortfolioUserId !== "undefined" && expandedPortfolioUserId !== null && currentTab === "arena") return;
    state.polling = true;
    try {
      await fetchAllData();
      if (currentUser) {
        await fetchUserPortfolio();
        if (currentTab === "portfolio") await loadTransactions();
      }
    } finally {
      state.polling = false;
    }
  }
  setInterval(poll, POLL_MS);

  document.addEventListener("DOMContentLoaded", () => {
    $("v2BuyQuick")?.classList.remove("hidden");
    refreshTrade();
  });
})();
