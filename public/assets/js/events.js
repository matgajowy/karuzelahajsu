const clickActions = {
  "switch-tab": element => switchTab(element.dataset.tab),
  "quick-refresh": () => triggerQuickRefresh(),
  "open-rules": () => openRulesModal(),
  "open-trade": element => openTradeModal(element.dataset.tradeType),
  "open-profile": () => openProfileModal(),
  "close-profile": () => closeProfileModal(),
  "randomize-avatar": element => randomizeAvatar(element.dataset.avatar),
  "generate-nick": () => generateFunnyNick(),
  "reset-avatar": () => resetToGithubAvatar(),
  "save-profile": () => saveProfile(),
  "close-rules": () => closeRulesModal(),
  "close-trade": () => closeTradeModal(),
  "set-trade-type": element => setTradeType(element.dataset.tradeType),
  "verify-ticker": () => verifyTicker(),
  "set-shares-percentage": element => setSharesPercentage(Number(element.dataset.percent)),
  "manual-sync": () => triggerManualSync(),
  "fetch-audit": () => fetchAuditLogs(),
  "logout": () => handleLogout(),
  "open-smart-sell": element => openSmartSell(element.dataset.ticker),
};

document.addEventListener("click", event => {
  if (!(event.target instanceof Element)) return;
  const element = event.target.closest("[data-action]");
  if (!element) return;

  const action = clickActions[element.dataset.action];
  if (!action) return;
  if (element instanceof HTMLAnchorElement) event.preventDefault();
  action(element, event);
});

document.addEventListener("submit", event => {
  if (!(event.target instanceof HTMLFormElement)) return;
  const form = event.target;

  if (form.dataset.action === "add-user") {
    handleAddUser(event);
  } else if (form.dataset.action === "submit-trade") {
    submitTrade(event);
  }
});

document.addEventListener("input", event => {
  if (event.target instanceof HTMLInputElement &&
      event.target.dataset.action === "update-estimated-cost") {
    updateEstimatedCost();
  }
});

document.addEventListener("change", event => {
  if (event.target instanceof HTMLSelectElement &&
      event.target.dataset.action === "holding-selected") {
    onHoldingSelected();
  }
});

document.addEventListener("keydown", event => {
  if (event.key === "Enter" && event.target instanceof HTMLInputElement &&
      event.target.id === "tradeTickerInput") {
    event.preventDefault();
    verifyTicker();
  }
});
