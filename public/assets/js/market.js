let marketRaceChart = null;
let opponentDrawerOpener = null;

async function fetchMarketInsights() {
  await Promise.all([fetchMarketRace(), fetchMarketRecap()]);
}

async function fetchMarketRace() {
  const emptyMessage = document.getElementById("marketRaceEmpty");
  try {
    const result = await apiRequest("/api/market-race");
    const snapshots = result.data || [];
    if (snapshots.length === 0) {
      marketRaceChart?.destroy();
      marketRaceChart = null;
      emptyMessage.classList.remove("hidden");
      return;
    }
    if (typeof Chart !== "function") {
      throw new Error("Nie udało się załadować biblioteki wykresu.");
    }

    const dates = [...new Set(snapshots.map(snapshot => snapshot.date))];
    const users = new Map();
    snapshots.forEach(snapshot => {
      if (!users.has(snapshot.user_id)) {
        users.set(snapshot.user_id, {
          name: snapshot.user_name,
          avatar: snapshot.avatar_url,
          values: new Map(),
        });
      }
      users.get(snapshot.user_id).values.set(snapshot.date, Number(snapshot.valuation_ck));
    });

    const palette = ["#818cf8", "#34d399", "#fbbf24", "#fb7185", "#22d3ee", "#c084fc", "#a3e635"];
    const avatarImages = [];
    const datasets = [...users.entries()].map(([userId, user], index) => {
      const image = new Image();
      image.src = user.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(user.name)}`;
      avatarImages.push(image);
      image.onload = () => marketRaceChart?.update("none");
      const color = palette[index % palette.length];
      return {
        label: user.name,
        data: dates.map(date => user.values.get(date) ?? null),
        borderColor: color,
        backgroundColor: color,
        pointStyle: image,
        pointRadius: 5,
        pointHoverRadius: 7,
        borderWidth: 2,
        tension: 0.25,
        spanGaps: true,
      };
    });

    if (marketRaceChart) marketRaceChart.destroy();
    marketRaceChart = new Chart(document.getElementById("marketRaceChart"), {
      type: "line",
      data: {
        labels: dates.map(date => new Date(`${date}T12:00:00Z`).toLocaleDateString("pl-PL", {
          day: "2-digit",
          month: "2-digit",
        })),
        datasets,
      },
      options: {
        maintainAspectRatio: false,
        responsive: true,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            labels: { color: "#cbd5e1", usePointStyle: true, boxWidth: 18 },
          },
          tooltip: {
            callbacks: {
              label: context => `${context.dataset.label}: ${formatCK(context.parsed.y, false)}`,
            },
          },
        },
        scales: {
          x: {
            ticks: { color: "#94a3b8", maxRotation: 0, autoSkip: true },
            grid: { color: "rgba(148, 163, 184, 0.08)" },
          },
          y: {
            ticks: {
              color: "#94a3b8",
              callback: value => `${(Number(value) / 1000).toLocaleString("pl-PL")}k CK`,
            },
            grid: { color: "rgba(148, 163, 184, 0.08)" },
          },
        },
      },
    });
    marketRaceChart.$avatarImages = avatarImages;
    emptyMessage.classList.add("hidden");
  } catch (error) {
    console.error("Market race loading failed:", error);
    emptyMessage.innerText = error.message || "Nie udało się pobrać danych wyścigu.";
    emptyMessage.classList.remove("hidden");
  }
}

async function fetchMarketRecap() {
  const dateElement = document.getElementById("marketRecapDate");
  const contentElement = document.getElementById("marketRecapContent");
  try {
    const result = await apiRequest("/api/market-recap");
    if (!result.data) return;
    dateElement.innerText = `Sesja: ${result.data.date}`;
    contentElement.innerText = result.data.content;
  } catch (error) {
    console.error("Market recap loading failed:", error);
    contentElement.innerText = error.message || "Nie udało się pobrać biuletynu sesji.";
  }
}

async function openOpponentPortfolio(userId, opener) {
  const drawer = document.getElementById("opponentPortfolioDrawer");
  const error = document.getElementById("opponentDrawerError");
  const holdings = document.getElementById("opponentDrawerHoldings");
  opponentDrawerOpener = opener;
  drawer.classList.remove("hidden");
  error.classList.add("hidden");
  error.innerText = "";
  document.getElementById("opponentDrawerTitle").innerText = "Ładowanie...";
  document.getElementById("opponentDrawerValuation").innerText = "--";
  document.getElementById("opponentDrawerCash").innerText = "--";
  holdings.innerHTML = '<p class="text-xs text-slate-500">Pobieranie portfela...</p>';

  try {
    const result = await apiRequest(`/api/opponent-portfolio?user_id=${encodeURIComponent(userId)}`);
    const player = result.data;
    document.getElementById("opponentDrawerTitle").innerText = player.display_name;
    const avatar = player.avatar_url || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(player.display_name)}`;
    const avatarElement = document.getElementById("opponentDrawerAvatar");
    avatarElement.src = avatar;
    avatarElement.alt = `Awatar gracza ${player.display_name}`;
    document.getElementById("opponentDrawerValuation").innerHTML = formatCK(player.valuation_ck);
    document.getElementById("opponentDrawerCash").innerHTML = formatCK(player.cash_ck);
    if (player.holdings.length === 0) {
      holdings.innerHTML = '<p class="text-xs text-slate-500 bg-slate-900 rounded-xl p-4">Gracz nie ma otwartych pozycji.</p>';
      return;
    }

    holdings.innerHTML = player.holdings.map(position => {
      const returnPct = Number(position.return_pct);
      const roundedReturn = Number.isFinite(returnPct) ? Number(returnPct.toFixed(2)) : null;
      const returnColor = roundedReturn > 0 ? "text-emerald-400" : roundedReturn < 0 ? "text-rose-400" : "text-slate-400";
      const formattedReturn = roundedReturn === null
        ? "--"
        : `${roundedReturn > 0 ? "+" : ""}${roundedReturn.toFixed(2)}%`;
      return `
        <article class="bg-slate-900 border border-slate-800 rounded-xl p-3">
          <div class="flex justify-between gap-3">
            <div class="min-w-0">
              <p class="font-bold text-white text-sm">${escapeHtml(position.ticker)} <span class="font-normal text-slate-400">${escapeHtml(position.name)}</span></p>
              <p class="text-[11px] text-slate-500 font-mono mt-1">${escapeHtml(position.shares)} akcji • kurs ${escapeHtml(formatQuotePrice(position.current_price, position.currency))}</p>
            </div>
            <div class="text-right shrink-0">
              <p class="font-mono tabular-nums text-indigo-200 text-sm">${formatCK(position.current_value_ck, false)}</p>
              <p class="font-mono text-[11px] ${returnColor}">${formattedReturn}</p>
            </div>
          </div>
        </article>
      `;
    }).join("");
  } catch (requestError) {
    console.error("Opponent portfolio loading failed:", requestError);
    error.innerText = requestError.message || "Nie udało się pobrać portfela.";
    error.classList.remove("hidden");
    holdings.innerHTML = "";
  }
}

function closeOpponentPortfolio() {
  document.getElementById("opponentPortfolioDrawer").classList.add("hidden");
  opponentDrawerOpener?.focus();
  opponentDrawerOpener = null;
}
