// Czas lokalny ligi (Europe/Warsaw). Crony Cloudflare działają w UTC, więc stałą porę lokalną
// (8:00 / 16:00) uzyskujemy odpalając cron w obu wariantach UTC (lato/zima) i sprawdzając godzinę tutaj.
const WARSAW = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Warsaw",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function warsawClock(date = new Date()) {
  const parts = Object.fromEntries(WARSAW.formatToParts(date).map(part => [part.type, part.value]));
  return { hour: Number(parts.hour), minute: Number(parts.minute) };
}
