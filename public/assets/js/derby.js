function renderDerbyTrack(items) {
  const track = document.getElementById("derbyTrack");
  if (!track) return;
  const players = items.filter(item => item.github_login !== "benchmark_sp500" && item.github_login !== "benchmark_wig20");
  const leaderId = players[0]?.id;

  track.innerHTML = items.map(item => {
    const isSp500 = item.github_login === "benchmark_sp500";
    const isWig20 = item.github_login === "benchmark_wig20";
    const isBenchmarkRow = isSp500 || isWig20;
    const returnRatio = Number(item.Stopa_Zwrotu || 0);
    const returnPercent = returnRatio * 100;
    const position = Math.min(96, Math.max(4, ((returnRatio + 0.1) / 0.3) * 100));
    const avatar = item.avatar_url || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(item.Uczestnik)}`;
    const icon = isSp500
      ? "🚜"
      : isWig20
        ? "🚋"
        : item.id === leaderId
          ? "🚀"
          : returnPercent < 0
            ? "🛒"
            : "🏇";
    const returnColor = returnPercent > 0 ? "text-emerald-300" : returnPercent < 0 ? "text-rose-300" : "text-slate-300";

    return `
      <div class="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-0" title="${escapeHtml(item.Uczestnik)}: ${escapeHtml(formatPct(returnRatio))}">
        <div class="flex items-center gap-2 sm:w-48 shrink-0">
          ${isBenchmarkRow
            ? `<span class="w-7 h-7 rounded-full bg-indigo-950 border border-indigo-500/30 flex items-center justify-center text-sm">${icon}</span>`
            : `<img src="${escapeHtml(avatar)}" alt="" class="w-7 h-7 rounded-full bg-slate-800 object-cover border border-slate-700">`}
          <span class="text-[11px] text-slate-300 truncate">${icon} ${escapeHtml(item.Uczestnik)}</span>
        </div>
        <div class="relative flex-1 h-10 rounded-lg bg-slate-950/80 border border-slate-800 overflow-hidden">
          <span class="absolute inset-y-0 left-0 border-r border-dashed border-slate-700"></span>
          <span class="absolute inset-y-0 left-[33.333%] border-r border-dashed border-amber-500/50"></span>
          <span class="absolute inset-y-0 left-[66.666%] border-r border-dashed border-slate-700"></span>
          <span class="absolute inset-y-0 right-0 border-l border-dashed border-slate-700"></span>
          <div class="absolute top-1/2 -translate-y-1/2 flex flex-col items-center gap-0.5 transition-[left] duration-700 ease-out" style="left:${position}%;transform:translate(-50%,-50%)">
            ${isBenchmarkRow
              ? `<span class="text-base leading-none" role="img" aria-label="${isSp500 ? "Benchmark S&P 500" : "Benchmark WIG20"}">${icon}</span>`
              : `<img src="${escapeHtml(avatar)}" alt="" class="w-6 h-6 rounded-full border-2 border-slate-950 shadow object-cover">`}
            <span class="text-[9px] leading-none font-mono font-bold ${returnColor} whitespace-nowrap bg-slate-950/90 rounded px-1">${escapeHtml(formatPct(returnRatio))}</span>
          </div>
        </div>
      </div>
    `;
  }).join("");
}
