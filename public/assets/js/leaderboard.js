    const opponentPortfolioCache = new Map();
    let expandedPortfolioUserId = null;

    function toggleOpponentAccordion(userId, row) {
      const requestedId = String(userId);
      if (expandedPortfolioUserId === requestedId) {
        row.nextElementSibling?.remove();
        row.setAttribute("aria-expanded", "false");
        expandedPortfolioUserId = null;
        return;
      }

      if (expandedPortfolioUserId !== null) {
        const previousRow = document.getElementById(`leaderboard-user-${expandedPortfolioUserId}`);
        previousRow?.nextElementSibling?.remove();
        previousRow?.setAttribute("aria-expanded", "false");
      }

      expandedPortfolioUserId = requestedId;
      row.setAttribute("aria-expanded", "true");
      row.insertAdjacentHTML("afterend", `
        <tr id="accordion-user-${Number(userId)}" class="bg-slate-950/90 border-b border-slate-800/80">
          <td colspan="6" class="p-4 text-xs text-slate-400">Pobieranie portfela...</td>
        </tr>
      `);
      const detailCell = document.querySelector(`#accordion-user-${Number(userId)} td`);
      const cached = opponentPortfolioCache.get(requestedId);
      if (cached) {
        detailCell.innerHTML = renderOpponentAccordion(cached);
        return;
      }

      apiRequest(`/api/opponent-portfolio?user_id=${encodeURIComponent(requestedId)}`)
        .then(result => {
          opponentPortfolioCache.set(requestedId, result.data);
          if (expandedPortfolioUserId !== requestedId || !detailCell.isConnected) return;
          detailCell.innerHTML = renderOpponentAccordion(result.data);
        })
        .catch(error => {
          console.error("Opponent portfolio loading failed:", error);
          if (expandedPortfolioUserId === requestedId && detailCell.isConnected) {
            detailCell.innerText = error.message || "Nie udało się pobrać portfela.";
            detailCell.className = "p-4 text-xs text-rose-300";
          }
        });
    }

    function renderOpponentAccordion(player) {
      const valuation = Number(player.valuation_ck) || 0;
      const cash = Number(player.cash_ck) || 0;
      const stocks = Number(player.stocks_value_ck) || 0;
      const cashPercent = valuation > 0 ? Math.min(100, Math.max(0, cash / valuation * 100)) : 0;
      const holdings = player.holdings.length
        ? player.holdings.map(position => {
          const returnPct = Number(position.return_pct);
          const roundedReturn = Number.isFinite(returnPct) ? Number(returnPct.toFixed(2)) : null;
          const returnColor = roundedReturn > 0
            ? "text-emerald-400"
            : roundedReturn < 0
              ? "text-rose-400"
              : "text-slate-400";
          const formattedReturn = roundedReturn === null
            ? "--"
            : `${roundedReturn > 0 ? "+" : ""}${roundedReturn.toFixed(2)}%`;
          return `
            <article class="bg-slate-900 border border-slate-800 rounded-xl p-3">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="text-sm font-bold text-white">${escapeHtml(position.name)} <span class="text-slate-500 font-mono text-xs">${escapeHtml(position.ticker)}</span></p>
                  <p class="text-[11px] text-slate-400 mt-1">${escapeHtml(position.shares)} akcji · ${escapeHtml(formatQuotePrice(position.current_price, position.currency))}</p>
                </div>
                <div class="text-right shrink-0">
                  <p class="font-mono tabular-nums text-slate-200 text-xs">${formatCK(position.current_value_ck, false)}</p>
                  <p class="font-mono text-[11px] ${returnColor}">${formattedReturn}</p>
                </div>
                <button type="button" data-action="copy-accordion-holding" data-ticker="${escapeHtml(position.ticker)}" data-user-name="${escapeHtml(player.display_name)}" class="shrink-0 px-2.5 py-1 rounded-lg text-[10px] font-semibold text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 transition" title="Skopiuj zakup gracza">
                  ⚡ Kopiuj
                </button>
              </div>
            </article>
          `;
        }).join("")
        : '<p class="text-xs text-slate-500 bg-slate-900 rounded-xl p-3">Brak otwartych pozycji.</p>';
      const thesis = player.last_thesis
        ? `<blockquote class="mt-4 border-l-2 border-indigo-500/50 pl-3 text-xs text-slate-300"><span class="block text-[10px] uppercase tracking-wide text-slate-500 mb-1">Ostatnia teza · ${escapeHtml(player.last_thesis.type)} ${escapeHtml(player.last_thesis.ticker)}</span>${escapeHtml(player.last_thesis.thesis)}</blockquote>`
        : '<p class="mt-4 text-xs text-slate-500">Gracz nie dodał jeszcze tezy inwestycyjnej.</p>';

      return `
        <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4">
          <section class="rounded-xl bg-slate-900 border border-slate-800 p-3">
            <div class="flex justify-between text-xs mb-2">
              <span class="text-slate-300">Podział portfela</span>
              <span class="font-mono tabular-nums text-white">${formatCK(valuation, false)}</span>
            </div>
            <div class="flex h-2 overflow-hidden rounded-full bg-slate-800" role="img" aria-label="Gotówka ${cashPercent.toFixed(1)} procent, akcje ${(100 - cashPercent).toFixed(1)} procent">
              <span class="bg-emerald-400" style="width:${cashPercent}%"></span>
              <span class="bg-indigo-400" style="width:${100 - cashPercent}%"></span>
            </div>
            <div class="flex justify-between gap-2 mt-2 text-[10px]">
              <span class="text-emerald-300">Gotówka ${formatCK(cash, false)}</span>
              <span class="text-indigo-300">Spółki ${formatCK(stocks, false)}</span>
            </div>
            ${thesis}
          </section>
          <section class="grid grid-cols-1 sm:grid-cols-2 gap-2 content-start" aria-label="Pozycje ${escapeHtml(player.display_name)}">
            ${holdings}
          </section>
        </div>
      `;
    }

    function renderDashboard(items, lastSyncTs, syncStatus, syncSummary) {
      const statusText = document.getElementById("syncStatusText");
      const syncBadge = document.getElementById("syncStatusBadge");
      let syncTitle = "";
      if (lastSyncTs) {
        const timeStr = formatTime(lastSyncTs);
        if (syncStatus === "partial") {
          const updated = syncSummary?.updated_count ?? 0;
          const total = syncSummary?.total_count ?? updated + (syncSummary?.failed_count ?? 0);
          statusText.innerText = `Niepełne kursy: ${updated}/${total}`;
          const issues = [
            ...(syncSummary?.failed_tickers?.length
              ? [`Nie zaktualizowano: ${syncSummary.failed_tickers.join(", ")}`]
              : []),
            ...(syncSummary?.errors || []),
          ];
          syncTitle = issues.join(" ");
        } else if (syncStatus === "failed") {
          statusText.innerText = `Błąd synchronizacji: ${timeStr}`;
          const issues = [
            ...(syncSummary?.failed_tickers?.length
              ? [`Nie zaktualizowano: ${syncSummary.failed_tickers.join(", ")}`]
              : []),
            ...(syncSummary?.errors || []),
          ];
          syncTitle = issues.join(" ") || "Synchronizacja nie zaktualizowała żadnych kursów.";
        } else {
          statusText.innerText = `Kursy: ${timeStr} • Cron: 15m`;
        }
      } else {
        statusText.innerText = `Brak synchronizacji`;
      }
      syncBadge.title = syncTitle;
      document.getElementById("syncStatusBadge").classList.remove("hidden");
      document.getElementById("dataTimestamp").innerText = `Waluta: CK (1 CK = 1 PLN)`;

      const isBenchmarkRow = (item) => {
        const n = (item.Uczestnik || '').toLowerCase();
        return item.github_login === "benchmark_sp500" ||
          item.github_login === "benchmark_wig20" ||
          n.includes("benchmark") || n.includes("index") || n.includes("s&p") || n.includes("wig");
      };

      const participants = items.filter(i => !isBenchmarkRow(i));
      const sp500 = items.find(i => i.github_login === "benchmark_sp500" || (i.Uczestnik || '').includes("S&P 500"));
      const wig20 = items.find(i => i.github_login === "benchmark_wig20" || (i.Uczestnik || '').includes("WIG20") || (i.Uczestnik || '').includes("WIG 20"));

      if (participants.length > 0) {
        const leader = participants[0];
        document.getElementById("leaderName").innerText = leader.Uczestnik;
        document.getElementById("leaderReturn").innerText = formatPct(leader.Stopa_Zwrotu);
        document.getElementById("leaderValue").innerHTML = formatCK(leader.Wycena_Calkowita_CK);
        const leaderAvatar = leader.avatar_url || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(leader.Uczestnik)}`;
        document.getElementById("kpiLeaderAvatar").src = leaderAvatar;
      }

      if (sp500) {
        const ret = formatPct(sp500.Stopa_Zwrotu);
        const col = pctColorClass(sp500.Stopa_Zwrotu);
        document.getElementById("benchSp500Val").innerHTML = `<span class="${col}">${ret}</span>`;
      }
      if (wig20) {
        const ret = formatPct(wig20.Stopa_Zwrotu);
        const col = pctColorClass(wig20.Stopa_Zwrotu);
        document.getElementById("benchWig20Val").innerHTML = `<span class="${col}">${ret}</span>`;
      }

      if (participants.length > 0) {
        const totalRet = participants.reduce((acc, c) => acc + (c.Stopa_Zwrotu || 0), 0);
        const avg = totalRet / participants.length;
        document.getElementById("avgReturn").innerText = formatPct(avg);
        document.getElementById("activeParticipantsCount").innerText = `${participants.length} zarejestrowanych graczy`;
        const benchRet = sp500 ? sp500.Stopa_Zwrotu : 0;
        const winners = participants.filter(p => p.Stopa_Zwrotu > benchRet).length;
        document.getElementById("beatTheMarketNote").innerText = `${winners} z ${participants.length} graczy bije rynek 🚀`;
      }

      const tbody = document.getElementById("leaderboardBody");
      tbody.innerHTML = "";
      expandedPortfolioUserId = null;
      opponentPortfolioCache.clear();

      let livePlayerRank = 0;
      items.forEach(item => {
        const isBench = isBenchmarkRow(item);
        const rawProfit = Number(item.Zysk_Strata_CK || 0);
        const roundedProfit = Math.abs(rawProfit) < 0.005 ? 0 : Number(rawProfit.toFixed(2));
        const retCol = roundedProfit === 0 ? "text-slate-400" : pctColorClass(item.Stopa_Zwrotu);
        const rowBg = isBench
          ? "bg-indigo-950/20 border-l-4 border-indigo-500 font-semibold"
          : "cursor-pointer hover:bg-slate-900/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400 transition";

        // Rozpoznawanie flagi dla benchmarku
        const nLower = (item.Uczestnik || '').toLowerCase();
        const isSpFlag = nLower.includes("s&p") || nLower.includes("500") || (item.github_login === 'benchmark_sp500');
        const isWigFlag = nLower.includes("wig") || (item.github_login === 'benchmark_wig20');
        const flag = isSpFlag ? '🇺🇸' : (isWigFlag ? '🇵🇱' : '📊');

        // Kolumna #
        let rankBadge;
        if (isBench) {
          rankBadge = `<span class="text-slate-500 font-mono text-xs" title="Benchmark">-</span>`;
        } else if (livePlayerRank === 0) {
          rankBadge = `<span class="text-amber-400 text-base">🥇</span>`;
        } else if (livePlayerRank === 1) {
          rankBadge = `<span class="text-slate-300 text-base">🥈</span>`;
        } else if (livePlayerRank === 2) {
          rankBadge = `<span class="text-amber-600 text-base">🥉</span>`;
        } else {
          rankBadge = `<span class="text-slate-500 font-mono text-xs">${livePlayerRank + 1}</span>`;
        }
        if (!isBench) livePlayerRank += 1;

        // Kolumna Uczestnik (BEZ awatara przy benchmarkach)
        let participantCell = "";
        if (isBench) {
          participantCell = `
            <div class="flex items-center gap-2.5 py-0.5">
              <span role="img" aria-label="${isSpFlag ? 'USA' : 'Polska'}" class="w-7 h-7 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-sm">${flag}</span>
              <div class="flex flex-col">
                <span class="text-white font-semibold text-xs sm:text-sm flex items-center gap-1.5">
                  ${escapeHtml(item.Uczestnik)}
                  <span class="text-[9px] uppercase tracking-wider bg-indigo-500/20 text-indigo-300 px-1.5 py-0.2 rounded font-mono">Indeks</span>
                </span>
                <span class="text-[10px] text-slate-500 font-mono">Oficjalny Punkt Odniesienia</span>
              </div>
            </div>
          `;
        } else {
          const avatar = item.avatar_url || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(item.Uczestnik)}`;
          participantCell = `
            <div class="flex items-center gap-2.5">
              <img src="${escapeHtml(avatar)}" alt="${escapeHtml(item.Uczestnik)}" class="w-7 h-7 rounded-full bg-slate-800 object-cover border border-slate-700">
              <div class="flex flex-col">
                <span class="text-white font-semibold text-xs sm:text-sm flex items-center gap-1.5 hover:text-indigo-300">
                  ${escapeHtml(item.Uczestnik)} <span class="text-[9px] text-slate-500" aria-hidden="true">▾</span>
                </span>
                ${item.github_login ? `<span class="text-[10px] text-slate-500">@${escapeHtml(item.github_login)}</span>` : ''}
              </div>
            </div>
          `;
        }

        tbody.innerHTML += `
          <tr class="${rowBg} border-b border-slate-800/60" ${!isBench ? `id="leaderboard-user-${Number(item.id)}" data-action="toggle-opponent-accordion" data-user-id="${Number(item.id)}" tabindex="0" aria-expanded="false" aria-controls="accordion-user-${Number(item.id)}"` : ""}>
            <td class="py-3.5 px-4 text-center font-mono">${rankBadge}</td>
            <td class="py-3.5 px-4">${participantCell}</td>
            <td class="py-3.5 px-4 text-right font-mono text-slate-200">${formatCK(item.Wycena_Calkowita_CK)}</td>
            <td class="py-3.5 px-4 text-right font-mono text-slate-400">${formatCK(item.Gotowka_CK)}</td>
            <td class="py-3.5 px-4 text-right font-mono ${retCol}">${formatCK(roundedProfit)}</td>
            <td class="py-3.5 px-4 text-right font-mono font-bold ${retCol}">${formatPct(item.Stopa_Zwrotu)}</td>
          </tr>
        `;
      });

      lucide.createIcons();
    }
