// Market Hours Guard: sesje regularne GPW i USA liczone w czasie Europe/Warsaw
// (CET/CEST obsługuje Intl.DateTimeFormat, więc nie ma ręcznego przesuwania DST).

const TIME_ZONE = "Europe/Warsaw";

const MARKETS = {
  GPW: { open: 9 * 60, close: 17 * 60, openLabel: "09:00", closeLabel: "17:00" },
  USA: { open: 15 * 60 + 30, close: 22 * 60, openLabel: "15:30", closeLabel: "22:00" },
};

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function getWarsawClock(date) {
  const parts = Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
  return {
    weekday: WEEKDAYS[parts.weekday],
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function getMarketOf(ticker) {
  return String(ticker || "").trim().toUpperCase().endsWith(".WA") ? "GPW" : "USA";
}

export function getMarketInfo(ticker, date = new Date()) {
  const market = getMarketOf(ticker);
  const { open, close, openLabel, closeLabel } = MARKETS[market];
  const schedule = `Pn-Pt ${openLabel}-${closeLabel}`;
  const { weekday, minutes } = getWarsawClock(date);
  const isWeekend = weekday === 0 || weekday === 6;

  if (!isWeekend && minutes >= open && minutes < close) {
    return {
      market,
      isOpen: true,
      schedule,
      nextOpenInfo: `Sesja trwa do ${closeLabel}`,
    };
  }

  let reason;
  let nextOpenInfo;
  if (isWeekend) {
    reason = "Rynek zamknięty w weekendy";
    nextOpenInfo = `Otwarcie w poniedziałek o ${openLabel}`;
  } else if (minutes < open) {
    reason = "Przed otwarciem sesji";
    nextOpenInfo = `Otwarcie dziś o ${openLabel}`;
  } else {
    reason = "Po zamknięciu sesji";
    nextOpenInfo = weekday === 5
      ? `Otwarcie w poniedziałek o ${openLabel}`
      : `Otwarcie jutro o ${openLabel}`;
  }

  return { market, isOpen: false, reason, schedule, nextOpenInfo };
}

export function marketClosedMessage(info) {
  const [, hours] = info.schedule.split(" ");
  return `Handel na rynku ${info.market} jest obecnie zablokowany. Sesja trwa w godzinach ${hours.replace("-", " - ")} (Pn-Pt).`;
}

export function toMarketStatus(info) {
  return {
    is_open: info.isOpen,
    market: info.market,
    message: info.reason || "Rynek otwarty",
    hours: info.schedule,
    next_open: info.nextOpenInfo,
  };
}
