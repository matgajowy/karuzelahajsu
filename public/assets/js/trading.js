    let isUpdatingTradeInputs = false;
    let tradeInputSource = "shares";

    function openTradeModal(type = 'BUY') {
      if (!currentUser) {
        alert("Musisz być zalogowany!");
        return;
      }
      document.getElementById("tradeError").classList.add("hidden");
      document.getElementById("tradeShares").value = "";
      document.getElementById("tradeAmount").value = "";
      document.getElementById("tradeAmountRemainder").classList.add("hidden");
      document.getElementById("tradeAmountRemainder").innerText = "";
      tradeInputSource = "shares";
      document.getElementById("tradeThesis").value = "";
      document.getElementById("estimatedCost").innerHTML = formatCK(0);
      document.getElementById("tradeAvailableCash").innerHTML = formatCK(currentUser.current_cash ?? 0);
      document.getElementById("verifiedInstrumentCard").classList.add("hidden");
      document.getElementById("tradeTickerInput").value = "";
      verifiedInstrument = null;

      populateHoldingsDropdown();
      setTradeType(type);
      document.getElementById("tradeModal").classList.remove("hidden");
    }

    function openSmartSell(ticker) {
      openTradeModal('SELL');
      const select = document.getElementById("userHoldingsSelect");
      select.value = ticker;
      onHoldingSelected();
    }

    function closeTradeModal() {
      document.getElementById("tradeModal").classList.add("hidden");
    }

    function setTradeType(type) {
      const previousTradeType = currentTradeType;
      currentTradeType = type;
      const bBuy = document.getElementById("btnBuy");
      const bSell = document.getElementById("btnSell");
      const buySection = document.getElementById("buyInstrumentSection");
      const sellSection = document.getElementById("sellInstrumentSection");
      const quickBtns = document.getElementById("quickSharesButtons");
      const amountSection = document.getElementById("tradeAmountSection");
      const sharesBadge = document.getElementById("availableSharesBadge");
      const submitBtn = document.getElementById("submitTradeBtn");

      if (previousTradeType && previousTradeType !== type) {
        document.getElementById("tradeShares").value = "";
        document.getElementById("tradeAmount").value = "";
        document.getElementById("tradeAmountRemainder").classList.add("hidden");
        document.getElementById("tradeError").classList.add("hidden");
        tradeInputSource = "shares";
      }

      if (type === 'BUY') {
        document.getElementById("tradeShares").step = "1";
        document.getElementById("tradeShares").min = "1";
        bBuy.className = "py-2 text-xs font-bold rounded-lg bg-emerald-600 text-white transition";
        bSell.className = "py-2 text-xs font-bold rounded-lg text-slate-400 hover:text-white transition";
        buySection.classList.remove("hidden");
        sellSection.classList.add("hidden");
        quickBtns.classList.add("hidden");
        amountSection.classList.remove("hidden");
        sharesBadge.classList.add("hidden");
        updateTradeAvailability();
        if (verifiedInstrument) syncTradeInput(tradeInputSource);
      } else {
        document.getElementById("tradeShares").step = "1";
        document.getElementById("tradeShares").min = "1";
        bSell.className = "py-2 text-xs font-bold rounded-lg bg-rose-600 text-white transition";
        bBuy.className = "py-2 text-xs font-bold rounded-lg text-slate-400 hover:text-white transition";
        buySection.classList.add("hidden");
        sellSection.classList.remove("hidden");
        quickBtns.classList.remove("hidden");
        amountSection.classList.add("hidden");
        document.getElementById("tradeAmount").value = "";
        document.getElementById("tradeAmountRemainder").classList.add("hidden");
        sharesBadge.classList.remove("hidden");
        onHoldingSelected();
      }
      updateEstimatedCost();
    }

    function syncTradeInput(source) {
      if (isUpdatingTradeInputs) return;
      const sharesInput = document.getElementById("tradeShares");
      if (currentTradeType !== "BUY") {
        updateTradeAvailability();
        updateEstimatedCost();
        return;
      }
      tradeInputSource = source;
      const amountInput = document.getElementById("tradeAmount");
      const remainder = document.getElementById("tradeAmountRemainder");
      isUpdatingTradeInputs = true;
      try {
        if (source === "shares") {
          const shares = Number(sharesInput.value);
          if (!verifiedInstrument || !Number.isFinite(shares) || shares <= 0) {
            amountInput.value = "";
            remainder.classList.add("hidden");
            remainder.innerText = "";
          } else if (!Number.isInteger(shares)) {
            amountInput.value = "";
            remainder.innerText = "Zakup dostępny wyłącznie w pełnych akcjach.";
            remainder.classList.remove("hidden");
          } else {
            amountInput.value = (shares * verifiedInstrument.price_ck).toFixed(2);
            remainder.classList.add("hidden");
            remainder.innerText = "";
          }
        } else {
          const amount = Number(amountInput.value);
          const pricePerShare = Number(verifiedInstrument?.price_ck);
          if (!Number.isFinite(amount) || amount <= 0) {
            sharesInput.value = "";
            remainder.classList.add("hidden");
            remainder.innerText = "";
          } else if (!Number.isFinite(pricePerShare) || pricePerShare <= 0) {
            sharesInput.value = "";
            remainder.innerText = "Zweryfikuj walor, aby przeliczyć kwotę.";
            remainder.classList.remove("hidden");
          } else {
            const shares = Math.floor(amount / pricePerShare);
            const cost = shares * pricePerShare;
            const change = Math.max(0, amount - cost);
            const shareText = String(shares);
            remainder.innerText =
              `Kupujesz: ${shareText} szt. • Koszt: ${formatCK(cost, false)} • Niewykorzystana reszta: ${formatCK(change, false)}`;
            sharesInput.value = shares > 0 ? shareText : "";
            remainder.classList.remove("hidden");
          }
        }
      } finally {
        isUpdatingTradeInputs = false;
      }
      updateTradeAvailability();
      updateEstimatedCost();
    }

    function updateTradeAvailability() {
      const shares = Number(document.getElementById("tradeShares").value);
      const validShares = Number.isSafeInteger(shares) && shares > 0 &&
        (currentTradeType === "BUY" || shares <= selectedHoldingMaxShares);
      document.getElementById("submitTradeBtn").disabled = !verifiedInstrument || !validShares;
    }

    function populateHoldingsDropdown() {
      const select = document.getElementById("userHoldingsSelect");
      select.innerHTML = '<option value="">Wybierz walor ze swojego portfela...</option>';
      userHoldings.forEach(h => {
        select.innerHTML += `<option value="${escapeHtml(h.ticker)}">${escapeHtml(h.ticker)} - ${escapeHtml(h.name)} (${escapeHtml(h.shares)} szt.)</option>`;
      });
    }

    function onHoldingSelected() {
      const select = document.getElementById("userHoldingsSelect");
      const ticker = select.value;
      const submitBtn = document.getElementById("submitTradeBtn");

      if (!ticker) {
        selectedHoldingMaxShares = 0;
        document.getElementById("availableSharesCount").innerText = "0";
        document.getElementById("verifiedInstrumentCard").classList.add("hidden");
        verifiedInstrument = null;
        updateTradeAvailability();
        updateEstimatedCost();
        return;
      }

      const holding = userHoldings.find(h => h.ticker === ticker);
      if (holding) {
        selectedHoldingMaxShares = holding.shares;
        document.getElementById("availableSharesCount").innerText = holding.shares;

        verifiedInstrument = {
          ticker: holding.ticker,
          name: holding.name,
          price: holding.current_price,
          currency: holding.currency,
          fx_to_ck: holding.fx_to_ck,
          price_ck: holding.current_price * holding.fx_to_ck
        };

        document.getElementById("instFullName").innerText = verifiedInstrument.name;
        document.getElementById("instTickerDisplay").innerText = verifiedInstrument.ticker;
        document.getElementById("instPriceDisplay").innerText = formatQuotePrice(verifiedInstrument.price, verifiedInstrument.currency);
        document.getElementById("instFxDisplay").innerText = verifiedInstrument.currency === "USD"
          ? `≈ ${formatCK(verifiedInstrument.price_ck, false)} / akcję`
          : "Parytet 1:1 z CK";

        document.getElementById("verifiedInstrumentCard").classList.remove("hidden");
        updateTradeAvailability();
        if (currentTradeType === "BUY") syncTradeInput(tradeInputSource);
        updateEstimatedCost();
      }
    }

    function setMaxSellShares() {
      const wholeShares = Math.floor(Number(selectedHoldingMaxShares) || 0);
      const sharesInput = document.getElementById("tradeShares");
      const error = document.getElementById("tradeError");
      error.classList.add("hidden");
      if (wholeShares < 1) {
        sharesInput.value = "";
        error.innerText = "Nie masz pełnej akcji do sprzedaży.";
        error.classList.remove("hidden");
      } else {
        sharesInput.value = String(wholeShares);
      }
      updateTradeAvailability();
      updateEstimatedCost();
    }

    async function verifyTicker() {
      const input = document.getElementById("tradeTickerInput");
      const ticker = input.value.trim().toUpperCase();
      const errDiv = document.getElementById("tradeError");
      const btn = document.getElementById("verifyBtn");
      const submitBtn = document.getElementById("submitTradeBtn");

      if (!ticker) return;

      errDiv.classList.add("hidden");
      btn.innerText = "...";
      btn.disabled = true;

      try {
        const json = await apiRequest(`/api/instruments/search?q=${encodeURIComponent(ticker)}`);

        if (json.status === "success") {
          verifiedInstrument = json.data;
          document.getElementById("instFullName").innerText = verifiedInstrument.name;
          document.getElementById("instTickerDisplay").innerText = verifiedInstrument.ticker;
          document.getElementById("instPriceDisplay").innerText = formatQuotePrice(verifiedInstrument.price, verifiedInstrument.currency);
          document.getElementById("instFxDisplay").innerText = verifiedInstrument.currency === "USD"
            ? `≈ ${formatCK(verifiedInstrument.price_ck, false)} / akcję`
            : "Parytet 1:1 z CK";

          document.getElementById("verifiedInstrumentCard").classList.remove("hidden");
          submitBtn.disabled = false;
          if (currentTradeType === "BUY") syncTradeInput(tradeInputSource);
          updateEstimatedCost();
        } else {
          verifiedInstrument = null;
          document.getElementById("verifiedInstrumentCard").classList.add("hidden");
          submitBtn.disabled = true;
          errDiv.innerText = json.message || "Walor nie został znaleziony.";
          errDiv.classList.remove("hidden");
        }
      } catch (e) {
        errDiv.innerText = e.message || "Błąd połączenia z API wyszukiwania.";
        errDiv.classList.remove("hidden");
      } finally {
        btn.innerText = "Sprawdź";
        btn.disabled = false;
      }
    }

    function updateEstimatedCost() {
      const shares = Number(document.getElementById("tradeShares").value) || 0;
      if (verifiedInstrument && shares > 0) {
        const val = shares * verifiedInstrument.price_ck;
        document.getElementById("estimatedCost").innerHTML = formatCK(val);
      } else {
        document.getElementById("estimatedCost").innerHTML = formatCK(0);
      }
    }

    async function copyFeedTrade(ticker, userName) {
      if (!currentUser) {
        location.href = "/api/auth/github";
        return;
      }

      openTradeModal("BUY");
      setTradeType("BUY");
      document.getElementById("tradeTickerInput").value = ticker;
      document.getElementById("tradeThesis").value =
        `Kopiuję ruch od @${userName}! Też w to wchodzę.`;
      await verifyTicker();
    }

    async function submitTrade(e) {
      e.preventDefault();
      const errDiv = document.getElementById("tradeError");
      errDiv.classList.add("hidden");

      if (!verifiedInstrument) {
        errDiv.innerText = "Wybierz lub zweryfikuj walor przed złożeniem zlecenia.";
        errDiv.classList.remove("hidden");
        return;
      }

      const shares = Number(document.getElementById("tradeShares").value);
      if (!Number.isSafeInteger(shares) || shares < 1) {
        errDiv.innerText = `${currentTradeType === "BUY" ? "Kupować" : "Sprzedawać"} można wyłącznie pełne akcje.`;
        errDiv.classList.remove("hidden");
        return;
      }
      if (currentTradeType === 'SELL' && shares > selectedHoldingMaxShares) {
        errDiv.innerText = `Nie możesz sprzedać więcej niż posiadasz (${selectedHoldingMaxShares} szt.).`;
        errDiv.classList.remove("hidden");
        return;
      }

      const payload = {
        ticker: verifiedInstrument.ticker,
        type: currentTradeType,
        shares: shares,
        thesis: document.getElementById("tradeThesis").value
      };

      try {
        const data = await apiRequest('/api/trade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (data.status === "success") {
          closeTradeModal();
          await fetchAllData();
          await fetchUserPortfolio();
          alert("Zlecenie zrealizowane pomyślnie!");
        } else {
          errDiv.innerText = data.message || "Błąd wykonania zlecenia";
          errDiv.classList.remove("hidden");
        }
      } catch (err) {
        errDiv.innerText = err.message || "Błąd połączenia z serwerem.";
        errDiv.classList.remove("hidden");
      }
    }
