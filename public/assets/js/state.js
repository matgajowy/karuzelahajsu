let currentUser = null;
    let userHoldings = [];
    let verifiedInstrument = null;
    let currentTradeType = 'BUY';
    let currentTab = 'arena';
    let selectedHoldingMaxShares = 0;
    let tempAvatarUrl = "";

    const FUNNY_NAMES = [
      "Wilk z Mordoru", "Książę GPW", "Pan Maruda (Wieczny Short)",
      "Krypto Szaman", "Mistrz All-In", "Złoty Strzał", "Spekulant przy ekspresie",
      "Królowa Dywidendy", "HODL Ape", "Prezes Zarządu ds. Strat",
      "Łowca Dołków", "Wieloryb z Korpo", "Ryzykant Piątkowy", "Rekin z Mordoru"
    ];
