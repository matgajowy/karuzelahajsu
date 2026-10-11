    let activeFeedFilter = "all";
    let cachedFeedData = { transactions: [], news: [] };

    function setFeedFilter(filter) {
      activeFeedFilter = filter;
      document.querySelectorAll("[data-action='filter-feed']").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.filter === filter);
      });
      renderHybridFeed();
    }

    function renderHybridFeed() {
      const container = document.getElementById("feedContainer");
      if (!container) return;

      const { transactions = [], news = [] } = cachedFeedData;

      // Budowanie połączonej listy
      let items = [];
      if (activeFeedFilter === "all" || activeFeedFilter === "trades") {
        transactions.forEach(t => items.push({ ...t, feedItemType: "TRADE" }));
      }
      if (activeFeedFilter === "all" || activeFeedFilter === "news") {
        news.forEach(n => items.push({ ...n, feedItemType: "NEWS" }));
      }

      items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      if (items.length === 0) {
        container.innerHTML = '<div class="text-center text-slate-400 text-xs py-6">Brak wpisów dla wybranego filtra.</div>';
        return;
      }

      container.innerHTML = "";
      items.forEach(item => {
        if (item.feedItemType === "NEWS") {
          const isMorning = item.type === "STANDUP_MORNING";
          const tagTime = isMorning ? "08:00" : "16:00";
          const dateStr = new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });

          container.innerHTML += `
            <div class="standup-feed-entry my-2">
              <div class="flex items-center justify-between flex-wrap gap-2 mb-2">
                <span class="standup-tag">
                  <span>🎤</span>
                  <span>STAND-UP Z PARKIETU [${tagTime}]</span>
                </span>
                <span class="text-[10px] text-slate-400 font-mono">${escapeHtml(dateStr)}</span>
              </div>
              <h4 class="font-bold text-white text-sm mb-1.5">${escapeHtml(item.title)}</h4>
              <p class="text-xs text-slate-200 leading-relaxed whitespace-pre-line">${escapeHtml(item.content)}</p>
            </div>
          `;
        } else {
          // Standardowy wpis transakcji gracza
          const isBuy = item.type === "BUY";
          const ticker = String(item.ticker ?? "").toUpperCase();
          const isBenchmarkTicker = ["^GSPC", "WIG20", "WIG20.WA"].includes(ticker);
          const canCopy = isBuy && !isBenchmark(item.user_name) && !isBenchmarkTicker;
          const badgeColor = isBuy ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" : "bg-rose-500/10 text-rose-400 border-rose-500/30";
          const dateStr = new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
          const avatar = item.avatar_url || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(item.user_name)}`;

          container.innerHTML += `
            <div class="group relative p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 hover:border-slate-700 hover:bg-slate-900/60 transition flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div class="flex items-start gap-3">
                <img src="${escapeHtml(avatar)}" alt="${escapeHtml(item.user_name)}" class="w-8 h-8 rounded-full bg-slate-800 object-cover border border-slate-700 mt-0.5">
                <div class="space-y-1">
                  <div class="flex items-center flex-wrap gap-2">
                    <span class="font-bold text-white text-xs">${escapeHtml(item.user_name)}</span>
                    <span class="text-[10px] font-bold px-2 py-0.5 rounded-md border ${badgeColor}">${escapeHtml(item.type)}</span>
                    <span class="font-semibold text-slate-200 text-xs font-mono">${escapeHtml(item.shares)} szt. ${escapeHtml(item.company_name || item.ticker)} (${escapeHtml(item.ticker)})</span>
                    <span class="text-[11px] text-slate-500 font-mono">(${formatCK(item.total_value_ck ?? item.total_value_pln)})</span>
                  </div>
                  <p class="text-xs text-slate-300 italic pl-3 border-l-2 border-indigo-500/40">
                    "${escapeHtml(item.thesis)}"
                  </p>
                  ${item.ai_roast ? `
                    <p class="text-[11px] text-pink-400/90 font-mono pl-3 pt-0.5">
                      🤖 <span class="font-bold">Roast AI:</span> ${escapeHtml(item.ai_roast)}
                    </p>
                  ` : ""}
                </div>
              </div>
              <div class="flex items-center gap-3 shrink-0 self-end md:self-center">
                ${canCopy ? `
                  <button type="button" data-action="copy-feed-trade" data-ticker="${escapeHtml(item.ticker)}" data-user-name="${escapeHtml(item.user_name)}" class="opacity-100 md:opacity-0 md:pointer-events-none md:group-hover:opacity-100 md:group-hover:pointer-events-auto transition-opacity duration-200 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 cursor-pointer shadow-sm shrink-0" title="Kopiuj ruch gracza ${escapeHtml(item.user_name)}">
                    <span>⚡</span>
                    <span>Kopiuj</span>
                  </button>
                ` : ""}
                <span class="text-[10px] text-slate-400 font-mono whitespace-nowrap">
                  ${escapeHtml(dateStr)}
                </span>
              </div>
            </div>
          `;
        }
      });
    }

    async function fetchFeed() {
      try {
        const json = await apiRequest('/api/feed');
        if (json.status === "success") {
          cachedFeedData = {
            transactions: Array.isArray(json.data) ? json.data : [],
            news: Array.isArray(json.news) ? json.news : [],
          };
          renderHybridFeed();
        }
      } catch (e) {
        console.error("Feed error:", e);
      }
    }

    async function fetchUserPortfolio() {
      try {
        const [portfolioRes, allocationRes, transactionsRes] = await Promise.allSettled([
          apiRequest('/api/portfolio'),
          apiRequest('/api/league-allocation'),
          apiRequest('/api/my-transactions'),
        ]);

        if (portfolioRes.status === "fulfilled" && portfolioRes.value.status === "success") {
          const json = portfolioRes.value;
          userHoldings = json.data || [];
          if (currentUser) currentUser.current_cash = json.cash_ck;
          document.getElementById("userCashDisplay").innerHTML = formatCK(json.cash_ck, true, true);
          const stockValue = userHoldings.reduce((total, holding) =>
            total + Number(holding.current_value_pln ?? holding.current_value_ck ?? 0), 0);
          document.getElementById("portfolioTotalValue").innerHTML =
            formatCK(Number(json.cash_ck || 0) + stockValue, true, true);
          const tbody = document.getElementById("portfolioTableBody");

          if (userHoldings.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="py-6 text-center text-slate-400 font-sans">Brak otwartych pozycji. Kliknij "+ Nowe Zlecenie", aby zainwestować.</td></tr>';
          } else {
            tbody.innerHTML = "";
            userHoldings.forEach(p => {
              const retCol = p.return_pct >= 0 ? 'text-emerald-400' : 'text-rose-400';
              tbody.innerHTML += `
                <tr class="border-b border-slate-800/40 hover:bg-slate-900/40 transition">
                  <td class="py-3 font-semibold text-white font-sans">${escapeHtml(p.ticker)} <span class="text-slate-400 font-normal">(${escapeHtml(p.name)})</span></td>
                  <td class="py-3 text-right font-mono text-slate-200">${escapeHtml(p.shares)}</td>
                  <td class="py-3 text-right text-slate-400">${escapeHtml(formatQuotePrice(p.avg_buy_price, p.currency))}</td>
                  <td class="py-3 text-right text-slate-200">${escapeHtml(formatQuotePrice(p.current_price, p.currency))}</td>
                  <td class="py-3 text-right text-slate-200 font-bold">${formatCK(p.current_value_ck)}</td>
                  <td class="py-3 text-right font-semibold ${retCol}">${p.return_pct >= 0 ? '+' : ''}${p.return_pct.toFixed(2)}%</td>
                  <td class="py-3 text-center font-sans">
                    <button data-action="open-smart-sell" data-ticker="${escapeHtml(p.ticker)}" class="text-[11px] bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 border border-rose-800/40 px-2.5 py-1 rounded-md transition font-semibold">
                      Sprzedaj
                    </button>
                  </td>
                </tr>
              `;
            });
          }
        }

        // Renderowanie alokacji ligi (.feature-allocation)
        if (allocationRes.status === "fulfilled" && allocationRes.value.status === "success") {
          const alloc = allocationRes.value.data;
          renderLeagueAllocation(alloc);
        }

        // Renderowanie dziennika tez (.feature-journal)
        if (transactionsRes.status === "fulfilled" && transactionsRes.value.status === "success") {
          renderUserJournal(transactionsRes.value.data || []);
        }
      } catch (e) {
        console.error("Portfolio error:", e);
      }
    }

    function renderLeagueAllocation(alloc) {
      const gpw = Number(alloc.gpw_ck || 0);
      const usa = Number(alloc.usa_ck || 0);
      const cash = Number(alloc.cash_ck || 0);
      const total = gpw + usa + cash;
      if (total <= 0) return;

      const gpwPct = ((gpw / total) * 100).toFixed(1);
      const usaPct = ((usa / total) * 100).toFixed(1);
      const cashPct = ((cash / total) * 100).toFixed(1);

      const barEl = document.getElementById("leagueAllocationBar");
      if (barEl) {
        barEl.innerHTML = `
          <div class="allocation-gpw" style="width: ${gpwPct}%" title="GPW: ${gpwPct}%"></div>
          <div class="allocation-usa" style="width: ${usaPct}%" title="USA: ${usaPct}%"></div>
          <div class="allocation-cash" style="width: ${cashPct}%" title="Gotówka: ${cashPct}%"></div>
        `;
      }
      const labelEl = document.getElementById("leagueAllocationLabels");
      if (labelEl) {
        labelEl.innerHTML = `
          <span class="text-emerald-400">🇵🇱 GPW: ${gpwPct}%</span> •
          <span class="text-blue-400">🇺🇸 USA: ${usaPct}%</span> •
          <span class="text-amber-400">💵 Gotówka: ${cashPct}%</span>
        `;
      }
    }

    function renderUserJournal(transactions) {
      const journalList = document.getElementById("userJournalList");
      if (!journalList) return;

      if (!transactions || transactions.length === 0) {
        journalList.innerHTML = '<p class="text-slate-400 text-xs py-4 text-center">Brak zapisanych tez transakcyjnych.</p>';
        return;
      }

      journalList.innerHTML = transactions.map(t => {
        const isBuy = t.type === "BUY";
        const badgeCol = isBuy ? "text-emerald-400 border-emerald-500/40 bg-emerald-500/10" : "text-rose-400 border-rose-500/40 bg-rose-500/10";
        const date = new Date(t.created_at).toLocaleDateString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

        return `
          <div class="p-3 rounded-xl bg-slate-950/70 border border-slate-800 space-y-1">
            <div class="flex items-center justify-between text-xs">
              <div class="flex items-center gap-2">
                <span class="font-bold text-white font-mono">${escapeHtml(t.ticker)}</span>
                <span class="text-[10px] px-1.5 py-0.2 rounded border font-semibold ${badgeCol}">${escapeHtml(t.type)}</span>
                <span class="text-slate-400 font-mono text-[11px]">${escapeHtml(t.shares)} szt. @ ${escapeHtml(t.price)}</span>
              </div>
              <span class="text-[10px] text-slate-500 font-mono">${escapeHtml(date)}</span>
            </div>
            <p class="text-xs text-slate-300 italic pl-2 border-l border-indigo-500/40">"${escapeHtml(t.thesis)}"</p>
            ${t.ai_roast ? `<p class="text-[11px] text-pink-400/90 font-mono pl-2">🤖 ${escapeHtml(t.ai_roast)}</p>` : ""}
          </div>
        `;
      }).join("");
    }
