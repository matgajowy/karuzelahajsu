import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker/index.js";
import { getMarketInfo, getMarketOf } from "../src/worker/lib/marketHours.js";

// Środa 2026-10-07 obowiązuje CEST (UTC+2); środa 2026-12-02 obowiązuje CET (UTC+1).
const summer = (h, m) => new Date(Date.UTC(2026, 9, 7, h - 2, m));
const winter = (h, m) => new Date(Date.UTC(2026, 11, 2, h - 1, m));

test("GPW session boundaries 09:00-17:00", () => {
  assert.equal(getMarketInfo("CDR.WA", summer(8, 59)).isOpen, false);
  assert.equal(getMarketInfo("CDR.WA", summer(9, 0)).isOpen, true);
  assert.equal(getMarketInfo("CDR.WA", summer(16, 59)).isOpen, true);
  assert.equal(getMarketInfo("CDR.WA", summer(17, 0)).isOpen, false);
});

test("USA session boundaries 15:30-22:00", () => {
  assert.equal(getMarketInfo("NVDA", summer(15, 29)).isOpen, false);
  assert.equal(getMarketInfo("NVDA", summer(15, 30)).isOpen, true);
  assert.equal(getMarketInfo("NVDA", summer(21, 59)).isOpen, true);
  assert.equal(getMarketInfo("NVDA", summer(22, 0)).isOpen, false);
});

test("boundaries hold in winter time (CET)", () => {
  assert.equal(getMarketInfo("PKO.WA", winter(8, 59)).isOpen, false);
  assert.equal(getMarketInfo("PKO.WA", winter(9, 0)).isOpen, true);
  assert.equal(getMarketInfo("AAPL", winter(15, 29)).isOpen, false);
  assert.equal(getMarketInfo("AAPL", winter(15, 30)).isOpen, true);
  assert.equal(getMarketInfo("AAPL", winter(22, 0)).isOpen, false);
});

test("weekends are closed at any hour for both markets", () => {
  for (const day of [3, 4]) { // 2026-10-03 sobota, 2026-10-04 niedziela
    for (const hour of [0, 9, 12, 16, 17, 18, 21, 23]) {
      const date = new Date(Date.UTC(2026, 9, day, hour - 2, 0));
      for (const ticker of ["CDR.WA", "WIG20.WA", "TSLA", "^GSPC"]) {
        const info = getMarketInfo(ticker, date);
        assert.equal(info.isOpen, false, `${ticker} ${day}.10 ${hour}:00`);
        assert.equal(info.reason, "Rynek zamknięty w weekendy");
      }
    }
  }
});

test("Warsaw weekday is used, not UTC (Friday 23:30 CEST is still Friday)", () => {
  const fridayLate = new Date(Date.UTC(2026, 9, 9, 21, 30)); // pt 23:30 w Warszawie
  const info = getMarketInfo("NVDA", fridayLate);
  assert.equal(info.isOpen, false);
  assert.equal(info.reason, "Po zamknięciu sesji");
  assert.match(info.nextOpenInfo, /poniedziałek/);
});

test("ticker parsing: .WA is GPW, everything else is USA", () => {
  assert.equal(getMarketOf("CDR.WA"), "GPW");
  assert.equal(getMarketOf("pko.wa"), "GPW");
  for (const t of ["NVDA", "TSLA", "AAPL", "MSFT", "^GSPC"]) assert.equal(getMarketOf(t), "USA");
  assert.equal(getMarketInfo("CDR.WA", summer(10, 0)).schedule, "Pn-Pt 09:00-17:00");
  assert.equal(getMarketInfo("NVDA", summer(10, 0)).schedule, "Pn-Pt 15:30-22:00");
});

test("reason and nextOpenInfo for closed sessions", () => {
  assert.equal(getMarketInfo("CDR.WA", summer(8, 0)).reason, "Przed otwarciem sesji");
  assert.match(getMarketInfo("CDR.WA", summer(8, 0)).nextOpenInfo, /dziś o 09:00/);
  assert.match(getMarketInfo("CDR.WA", summer(18, 0)).nextOpenInfo, /jutro o 09:00/);
});

test("POST /api/trade rejects closed market with MARKET_CLOSED and audits it", async () => {
  const RealDate = Date;
  const fixed = new RealDate(Date.UTC(2026, 9, 7, 5, 0)); // środa 07:00 w Warszawie
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixed.getTime()])); }
    static now() { return fixed.getTime(); }
  };
  const writes = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...values) { this.values = values; return this; },
          async first() { return sql.includes("FROM sessions") ? { id: 1, current_cash: 1000 } : null; },
          async run() { writes.push({ sql, values: this.values }); return { success: true }; },
        };
      },
    },
  };
  try {
    const response = await worker.fetch(new Request("https://dev.example/api/trade", {
      method: "POST",
      headers: { Cookie: "session_token=s", "Content-Type": "application/json" },
      body: JSON.stringify({ ticker: "CDR.WA", type: "BUY", shares: 1, thesis: "Teza dłuższa niż piętnaście znaków." }),
    }), env, {});
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.code, "MARKET_CLOSED");
    assert.match(body.message, /GPW/);
    assert.match(body.message, /09:00 - 17:00/);
    const audit = writes.find(w => w.sql.includes("INSERT INTO audit_log"));
    assert.equal(audit.values.at(-1), "REJECTED_MARKET_CLOSED");
  } finally {
    globalThis.Date = RealDate;
  }
});
