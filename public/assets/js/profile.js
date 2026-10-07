    function openProfileModal() {
      if (!currentUser) return;
      document.getElementById("profileError").classList.add("hidden");
      document.getElementById("editDisplayNameInput").value = currentUser.display_name;
      tempAvatarUrl = currentUser.avatar_url || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(currentUser.display_name)}`;
      document.getElementById("editAvatarPreview").src = tempAvatarUrl;
      document.getElementById("profileModal").classList.remove("hidden");
    }

    function closeProfileModal() {
      document.getElementById("profileModal").classList.add("hidden");
    }

    function generateFunnyNick() {
      const randomNick = FUNNY_NAMES[Math.floor(Math.random() * FUNNY_NAMES.length)];
      document.getElementById("editDisplayNameInput").value = randomNick;
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

    async function saveProfile() {
      const errDiv = document.getElementById("profileError");
      errDiv.classList.add("hidden");

      const newName = document.getElementById("editDisplayNameInput").value.trim();
      if (!newName || newName.length < 2) {
        errDiv.innerText = "Nazwa musi mieć min. 2 znaki.";
        errDiv.classList.remove("hidden");
        return;
      }

      try {
        const data = await apiRequest('/api/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ display_name: newName, avatar_url: tempAvatarUrl })
        });

        if (data.status === "success") {
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

    // ==========================================
    // PANEL ADMINA: WHITELIST
    // ==========================================
