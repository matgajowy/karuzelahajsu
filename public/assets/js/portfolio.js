    async function fetchFeed() {
      try {
        const json = await apiRequest('/api/feed');
        const container = document.getElementById("feedContainer");

        if (json.status === "success" && json.data.length > 0) {
          container.innerHTML = "";
          json.data.forEach(item => {
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
          });
        } else {
          container.innerHTML = '<div class="text-center text-slate-400 text-xs py-6">Brak ostatnich transakcji.</div>';
        }
      } catch (e) {
        console.error("Feed error:", e);
      }
    }

    async function fetchUserPortfolio() {
      try {
        const json = await apiRequest('/api/portfolio');
        if (json.status === "success") {
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
            return;
          }

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
      } catch (e) {
        console.error("Portfolio error:", e);
      }
    }

    // ==========================================
    // EDYCJA PROFILU & GENERATOR AWATARÓW
    // ==========================================
