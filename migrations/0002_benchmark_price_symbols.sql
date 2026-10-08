INSERT INTO market_prices (ticker, name, price, currency, fx_to_pln, updated_at)
SELECT '^GSPC', 'S&P 500', price, currency, fx_to_pln, CURRENT_TIMESTAMP
FROM market_prices
WHERE ticker = 'SPY'
ON CONFLICT(ticker) DO UPDATE SET
  name = excluded.name,
  price = excluded.price,
  currency = excluded.currency,
  fx_to_pln = excluded.fx_to_pln,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO market_prices (ticker, name, price, currency, fx_to_pln, updated_at)
SELECT 'WIG20', 'Indeks WIG20', price, currency, fx_to_pln, CURRENT_TIMESTAMP
FROM market_prices
WHERE ticker = 'WIG20.WA'
ON CONFLICT(ticker) DO UPDATE SET
  name = excluded.name,
  price = excluded.price,
  currency = excluded.currency,
  fx_to_pln = excluded.fx_to_pln,
  updated_at = CURRENT_TIMESTAMP;
