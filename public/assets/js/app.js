    document.addEventListener("DOMContentLoaded", () => {
      lucide.createIcons();
      checkAuth();
      fetchAllData();
    });

    function switchTab(tabId) {
      if ((tabId === 'portfolio' || tabId === 'admin') && !currentUser) {
        alert("Zaloguj się kontem GitHub, aby uzyskać dostęp!");
        return;
      }
      if (tabId === 'admin' && currentUser?.is_admin !== 1) {
        alert("Brak uprawnień administratora.");
        return;
      }

      currentTab = tabId;

      document.getElementById("viewArena").style.display = tabId === 'arena' ? 'block' : 'none';
      document.getElementById("viewPortfolio").style.display = tabId === 'portfolio' ? 'block' : 'none';
      document.getElementById("viewAdmin").style.display = tabId === 'admin' ? 'block' : 'none';

      const tabs = {
        arena: document.getElementById("tabBtnArena"),
        portfolio: document.getElementById("tabBtnPortfolio"),
        admin: document.getElementById("tabBtnAdmin")
      };

      Object.keys(tabs).forEach(key => {
        if (!tabs[key]) return;
        if (key === tabId) {
          tabs[key].className = "py-3 px-4 text-xs font-bold border-b-2 border-indigo-500 text-indigo-400 flex items-center gap-2 transition";
        } else {
          tabs[key].className = "py-3 px-4 text-xs font-bold border-b-2 border-transparent text-slate-400 hover:text-slate-200 flex items-center gap-2 transition";
        }
      });

      if (tabId === 'portfolio') fetchUserPortfolio();
      if (tabId === 'admin') {
        fetchAuditLogs();
        fetchAdminUsers();
      }
      lucide.createIcons();
    }

    async function checkAuth() {
      try {
        const data = await apiRequest('/api/me');
        const authContainer = document.getElementById("authContainer");

        if (data.authenticated) {
          currentUser = data.user;
          const userAvatar = currentUser.avatar_url || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(currentUser.display_name)}`;

          authContainer.innerHTML = `
            <div class="flex items-center gap-2 bg-slate-900 border border-slate-800 py-1 px-2 rounded-xl text-xs">
              <img src="${escapeHtml(userAvatar)}" alt="${escapeHtml(currentUser.display_name)}" class="w-6 h-6 rounded-full bg-slate-800 object-cover border border-indigo-500/30">
              <span class="text-white font-semibold hidden md:inline">${escapeHtml(currentUser.display_name)}</span>
              <button data-action="logout" class="text-slate-400 hover:text-rose-400 p-1 transition" title="Wyloguj">
                <i data-lucide="log-out" class="w-3.5 h-3.5"></i>
              </button>
            </div>
          `;

          document.getElementById("tabBtnPortfolio").style.display = 'flex';
          document.getElementById("quickTradeBtnContainer").style.display = 'block';
          document.getElementById("userNameDisplay").innerText = currentUser.display_name;
          document.getElementById("myPortfolioAvatar").src = userAvatar;

          if (currentUser.is_admin === 1) {
            document.getElementById("tabBtnAdmin").style.display = 'flex';
          }

          fetchUserPortfolio();
        } else {
          currentUser = null;
          authContainer.innerHTML = `
            <a href="/api/auth/github" class="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-3.5 py-1.5 rounded-lg text-xs font-semibold shadow-md shadow-indigo-600/20 transition">
              <i data-lucide="log-in" class="w-4 h-4"></i>
              <span>Zaloguj z GitHub</span>
            </a>
          `;
          document.getElementById("tabBtnPortfolio").style.display = 'none';
          document.getElementById("quickTradeBtnContainer").style.display = 'none';
          document.getElementById("tabBtnAdmin").style.display = 'none';
          switchTab('arena');
        }
        lucide.createIcons();
      } catch (e) {
        console.error("Auth check failed:", e);
      }
    }

    async function fetchAllData() {
      await fetchLeaderboard();
      await fetchFeed();
    }

    async function triggerQuickRefresh() {
      const icon = document.getElementById("quickRefreshIcon");
      if (icon) icon.classList.add("animate-spin");
      await fetchAllData();
      if (currentUser) await fetchUserPortfolio();
      setTimeout(() => {
        if (icon) icon.classList.remove("animate-spin");
      }, 500);
    }

    async function fetchLeaderboard() {
      try {
        const json = await apiRequest('/api/leaderboard');
        if (json.status === "success") {
          renderDashboard(json.data, json.last_sync, json.sync_status, json.sync_summary);
        }
      } catch (e) {
        console.error("Leaderboard error:", e);
      }
    }


    async function handleLogout() {
      await apiRequest('/api/logout', { method: 'POST' });
      location.reload();
    }

    function openRulesModal() { document.getElementById("rulesModal").classList.remove("hidden"); }
    function closeRulesModal() { document.getElementById("rulesModal").classList.add("hidden"); }
