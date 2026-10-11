    function openProfileModal() {
      if (!currentUser) return;
      document.getElementById("profileError").classList.add("hidden");
      document.getElementById("editDisplayNameInput").value = currentUser.display_name;
      tempAvatarUrl = currentUser.avatar_url || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(currentUser.display_name)}`;
      document.getElementById("editAvatarPreview").src = tempAvatarUrl;

      // Tożsamość użytkownika
      const ghLoginEl = document.getElementById("profileGhLogin");
      if (ghLoginEl) ghLoginEl.innerText = `@${currentUser.github_login || "nieznany"}`;

      const valEl = document.getElementById("profileCurrentValuation");
      if (valEl) {
        const cash = Number(currentUser.current_cash || 0);
        const stocks = (userHoldings || []).reduce((sum, h) => sum + Number(h.current_value_ck || h.current_value_pln || 0), 0);
        valEl.innerHTML = formatCK(cash + stocks);
      }

      // Motyw
      const currentTheme = currentUser.theme || localStorage.getItem("kh_theme") || "v2";
      document.querySelectorAll("input[name='uiThemeOption']").forEach(radio => {
        radio.checked = radio.value === currentTheme;
      });

      document.getElementById("profileModal").classList.remove("hidden");
    }

    function closeProfileModal() {
      document.getElementById("profileModal").classList.add("hidden");
    }

    async function generateFunnyNick() {
      const button = document.getElementById("generateNickBtn");
      const input = document.getElementById("editDisplayNameInput");
      const errDiv = document.getElementById("profileError");
      const originalContent = button.innerHTML;
      button.disabled = true;
      button.innerHTML = '<i data-lucide="loader-circle" class="w-3 h-3 inline animate-spin"></i> Losuję…';
      errDiv.classList.add("hidden");
      if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
      try {
        const result = await apiRequest("/api/profile/generate-nickname", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (result.status !== "success" || !result.data?.nickname) {
          throw new Error(result.message || "Nie udało się wygenerować ksywki.");
        }
        input.value = result.data.nickname;
      } catch (error) {
        errDiv.innerText = error.message || "Nie udało się wygenerować ksywki.";
        errDiv.classList.remove("hidden");
      } finally {
        button.disabled = false;
        button.innerHTML = originalContent;
        if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
      }
    }

    function randomizeAvatar(collection) {
      const randomSeed = Math.random().toString(36).substring(2, 9);
      tempAvatarUrl = `https://api.dicebear.com/7.x/${collection}/svg?seed=${randomSeed}`;
      document.getElementById("editAvatarPreview").src = tempAvatarUrl;
    }

    function resetToGithubAvatar() {
      if (currentUser?.github_login) {
        tempAvatarUrl = `https://github.com/${currentUser.github_login}.png`;
        document.getElementById("editAvatarPreview").src = tempAvatarUrl;
      }
    }

    function onThemeRadioChange(e) {
      const newTheme = e.target.value;
      if (typeof setTheme === "function") {
        setTheme(newTheme);
      }
    }

    async function saveProfile() {
      const errDiv = document.getElementById("profileError");
      errDiv.classList.add("hidden");

      const newName = document.getElementById("editDisplayNameInput").value.trim();
      if (!newName || newName.length < 2) {
        errDiv.innerText = "Nazwa musi mieć min. 2 znaki.";
        errDiv.classList.remove("hidden");
        return;
      }

      const selectedTheme = document.querySelector("input[name='uiThemeOption']:checked")?.value || "v2";

      try {
        const data = await apiRequest('/api/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            display_name: newName,
            avatar_url: tempAvatarUrl,
            theme: selectedTheme
          })
        });

        if (data.status === "success") {
          if (currentUser) currentUser.theme = selectedTheme;
          setTheme(selectedTheme);
          closeProfileModal();
          await checkAuth();
          await fetchAllData();
          alert("Profil zaktualizowany!");
        } else {
          errDiv.innerText = data.message || "Błąd zapisu profilu.";
          errDiv.classList.remove("hidden");
        }
      } catch (err) {
        errDiv.innerText = err.message || "Błąd połączenia z serwerem.";
        errDiv.classList.remove("hidden");
      }
    }
