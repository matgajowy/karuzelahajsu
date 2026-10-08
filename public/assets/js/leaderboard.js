    function renderDashboard(items, lastSyncTs) {
      const statusText = document.getElementById("syncStatusText");
      if (lastSyncTs) {
        const syncDate = new Date(lastSyncTs);
        const timeStr = syncDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        statusText.innerText = `Kursy: ${timeStr} • Cron: 15m`;
      } else {
        statusText.innerText = `Brak synchronizacji`;
      }
      document.getElementById("syncStatusBadge").classList.remove("hidden");
      document.getElementById("dataTimestamp").innerText = `Waluta: CK (1 CK = 1 PLN)`;

      const isBenchmarkRow = (name) => {
        const n = (name || '').toLowerCase();
        return n.includes("benchmark") || n.includes("index") || n.includes("s&p") || n.includes("wig");
      };

      const participants = items.filter(i => !isBenchmarkRow(i.Uczestnik));
      const sp500 = items.find(i => (i.Uczestnik || '').includes("S&P 500"));
      const wig20 = items.find(i => (i.Uczestnik || '').includes("WIG20") || (i.Uczestnik || '').includes("WIG 20"));

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
        const col = sp500.Stopa_Zwrotu >= 0 ? 'text-emerald-400' : 'text-rose-400';
        document.getElementById("benchSp500Val").innerHTML = `<span class="${col}">${ret}</span>`;
      }
      if (wig20) {
        const ret = formatPct(wig20.Stopa_Zwrotu);
        const col = wig20.Stopa_Zwrotu >= 0 ? 'text-emerald-400' : 'text-rose-400';
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

      items.forEach((item, idx) => {
        const isBench = isBenchmarkRow(item.Uczestnik);
        const retCol = item.Stopa_Zwrotu > 0 ? "text-emerald-400" : (item.Stopa_Zwrotu < 0 ? "text-rose-400" : "text-slate-400");
        const rowBg = isBench
          ? "bg-indigo-950/20 border-l-4 border-indigo-500 font-semibold"
          : "hover:bg-slate-900/60 transition";

        // Rozpoznawanie flagi dla benchmarku
        const nLower = (item.Uczestnik || '').toLowerCase();
        const isSpFlag = nLower.includes("s&p") || nLower.includes("500") || (item.github_login === 'benchmark_sp500');
        const isWigFlag = nLower.includes("wig") || (item.github_login === 'benchmark_wig20');
        const flag = isSpFlag ? '🇺🇸' : (isWigFlag ? '🇵🇱' : '📊');

        // Kolumna #
        let rankBadge = `<span class="text-slate-500 font-mono text-xs">${idx + 1}</span>`;
        if (isBench) {
          rankBadge = `<span class="text-base" title="Oficjalny Benchmark">${flag}</span>`;
        } else if (idx === 0) {
          rankBadge = `<span class="text-amber-400 text-base">🥇</span>`;
        } else if (idx === 1) {
          rankBadge = `<span class="text-slate-300 text-base">🥈</span>`;
        } else if (idx === 2) {
          rankBadge = `<span class="text-amber-600 text-base">🥉</span>`;
        }

        // Kolumna Uczestnik (BEZ awatara przy benchmarkach)
        let participantCell = "";
        if (isBench) {
          participantCell = `
            <div class="flex items-center gap-2 py-0.5">
              <span class="text-base">${flag}</span>
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
                <span class="text-white font-semibold text-xs sm:text-sm flex items-center gap-1.5">
                  ${escapeHtml(item.Uczestnik)}
                </span>
                ${item.github_login ? `<span class="text-[10px] text-slate-500">@${escapeHtml(item.github_login)}</span>` : ''}
              </div>
            </div>
          `;
        }

        tbody.innerHTML += `
          <tr class="${rowBg} border-b border-slate-800/60">
            <td class="py-3.5 px-4 text-center font-mono">${rankBadge}</td>
            <td class="py-3.5 px-4">${participantCell}</td>
            <td class="py-3.5 px-4 text-right font-mono text-slate-200">${formatCK(item.Wycena_Calkowita_CK)}</td>
            <td class="py-3.5 px-4 text-right font-mono text-slate-400">${formatCK(item.Gotowka_CK)}</td>
            <td class="py-3.5 px-4 text-right font-mono ${retCol}">${formatCK(item.Zysk_Strata_CK)}</td>
            <td class="py-3.5 px-4 text-right font-mono font-bold ${retCol}">${formatPct(item.Stopa_Zwrotu)}</td>
          </tr>
        `;
      });

      lucide.createIcons();
    }
