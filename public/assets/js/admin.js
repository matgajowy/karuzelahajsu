    async function fetchAdminUsers() {
      try {
        const json = await apiRequest('/api/admin/users');
        const tbody = document.getElementById("whitelistTableBody");

        if (json.status === "success" && json.data) {
          tbody.innerHTML = "";
          json.data.forEach(u => {
            const isAdm = u.is_admin === 1;
            const roleBadge = isAdm ? `<span class="text-amber-400 font-bold">Admin</span>` : `<span class="text-slate-400">Gracz</span>`;
            tbody.innerHTML += `
              <tr class="border-b border-slate-800/40 hover:bg-slate-950/40">
                <td class="py-2 text-white font-sans font-semibold">${escapeHtml(u.display_name)}</td>
                <td class="py-2 text-slate-400">@${escapeHtml(u.github_login)}</td>
                <td class="py-2 text-right text-emerald-400">${formatCK(u.current_cash_ck)}</td>
                <td class="py-2 text-center">${roleBadge}</td>
              </tr>
            `;
          });
        }
      } catch (e) {
        console.error("Admin users error:", e);
      }
    }

    async function handleAddUser(e) {
      e.preventDefault();
      const msgDiv = document.getElementById("addUserMsg");
      msgDiv.className = "hidden text-xs p-2.5 rounded-lg";

      const ghLogin = document.getElementById("newGhLogin").value.trim();
      const dispName = document.getElementById("newDisplayName").value.trim();
      const isAdmin = document.getElementById("newIsAdmin").checked;

      try {
        const data = await apiRequest('/api/admin/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ github_login: ghLogin, display_name: dispName, is_admin: isAdmin })
        });

        if (data.status === "success") {
          msgDiv.innerText = data.message;
          msgDiv.className = "text-xs p-2.5 rounded-lg bg-emerald-950/40 text-emerald-400 border border-emerald-900/50 block";
          document.getElementById("addUserForm").reset();
          fetchAdminUsers();
          fetchAllData();
        } else {
          msgDiv.innerText = data.message;
          msgDiv.className = "text-xs p-2.5 rounded-lg bg-rose-950/40 text-rose-400 border border-rose-900/50 block";
        }
      } catch (err) {
        msgDiv.innerText = "Błąd sieci podczas dodawania gracza.";
        msgDiv.className = "text-xs p-2.5 rounded-lg bg-rose-950/40 text-rose-400 border border-rose-900/50 block";
      }
    }

    // ==========================================
    // TRANSAKCJE
    // ==========================================

    async function fetchAuditLogs() {
      try {
        const json = await apiRequest('/api/admin/audit');
        const tbody = document.getElementById("auditTableBody");

        if (json.status === "success" && json.data.length > 0) {
          tbody.innerHTML = "";
          json.data.forEach(log => {
            const isOk = log.status === "SUCCESS";
            tbody.innerHTML += `
              <tr class="border-b border-slate-800/40 hover:bg-slate-950/40">
                <td class="py-2.5 px-4 text-slate-400 text-[11px]">${escapeHtml(log.created_at)}</td>
                <td class="py-2.5 px-4 text-slate-300 font-sans">${escapeHtml(log.user_name)}</td>
                <td class="py-2.5 px-4 text-indigo-300 font-semibold">${escapeHtml(log.action)}</td>
                <td class="py-2.5 px-4 ${isOk ? 'text-emerald-400' : 'text-rose-400 font-bold'}">${escapeHtml(log.status)}</td>
                <td class="py-2.5 px-4 text-slate-400 text-[11px]">${escapeHtml(log.ip_address)}</td>
                <td class="py-2.5 px-4 text-slate-400 text-[11px] truncate max-w-xs" title="${escapeHtml(log.payload)}">${escapeHtml(log.payload)}</td>
              </tr>
            `;
          });
        }
      } catch (e) {
        console.error("Audit error:", e);
      }
    }

    async function triggerManualSync() {
      if (!confirm("Czy na pewno chcesz wymusić natychmiastową synchronizację kursów?")) return;
      try {
        const json = await apiRequest('/api/admin/sync-prices');
        if (json.status === "success") {
          alert(`${json.message}\n\n${json.logs.join("\n")}`);
          fetchAllData();
        } else {
          alert("Błąd: " + json.message);
        }
      } catch (e) {
        alert(`Nie udało się zsynchronizować kursów: ${e.message}`);
      }
    }
