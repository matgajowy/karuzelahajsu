-- Sample-only data for the isolated liga_db_dev database.
-- Safe to run repeatedly: demo users' holdings and feed history are refreshed.

INSERT INTO users (github_login, display_name, avatar_url, current_cash, is_admin)
VALUES
  ('demo_marta', 'Marta Kowalska', NULL, 45500, 0),
  ('demo_kuba', 'Kuba Nowak', NULL, 11600, 0),
  ('demo_ola', 'Ola Zielińska', NULL, 30000, 0),
  ('demo_piotr', 'Piotr Wiśniewski', NULL, 83500, 0),
  ('benchmark_sp500', 'S&P 500', NULL, 60000, 0),
  ('benchmark_wig20', 'WIG20', NULL, 70000, 0)
ON CONFLICT(github_login) DO UPDATE SET
  display_name = excluded.display_name,
  avatar_url = excluded.avatar_url,
  current_cash = excluded.current_cash,
  is_admin = excluded.is_admin;

DELETE FROM transactions
WHERE user_id IN (
  SELECT id FROM users
  WHERE github_login IN (
    'demo_marta', 'demo_kuba', 'demo_ola', 'demo_piotr',
    'benchmark_sp500', 'benchmark_wig20'
  )
);

DELETE FROM holdings
WHERE user_id IN (
  SELECT id FROM users
  WHERE github_login IN (
    'demo_marta', 'demo_kuba', 'demo_ola', 'demo_piotr',
    'benchmark_sp500', 'benchmark_wig20'
  )
);

INSERT INTO market_prices (ticker, name, price, currency, fx_to_pln)
VALUES
  ('AAPL', 'Apple Inc.', 220, 'USD', 4),
  ('PKN.WA', 'ORLEN S.A.', 82.4, 'PLN', 1),
  ('NVDA', 'NVIDIA Corporation', 132, 'USD', 4),
  ('MSFT', 'Microsoft Corporation', 430, 'USD', 4),
  ('GOOGL', 'Alphabet Inc.', 160, 'USD', 4),
  ('SPY', 'SPDR S&P 500 ETF Trust', 535, 'USD', 4),
  ('^GSPC', 'S&P 500', 5350, 'USD', 4),
  ('WIG20.WA', 'Indeks WIG20', 2700, 'PLN', 1),
  ('WIG20', 'Indeks WIG20', 2700, 'PLN', 1)
ON CONFLICT(ticker) DO UPDATE SET
  name = excluded.name,
  price = excluded.price,
  currency = excluded.currency,
  fx_to_pln = excluded.fx_to_pln,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO holdings (user_id, ticker, shares, avg_buy_price)
VALUES
  ((SELECT id FROM users WHERE github_login = 'demo_marta'), 'AAPL', 40, 200),
  ((SELECT id FROM users WHERE github_login = 'demo_marta'), 'PKN.WA', 300, 75),
  ((SELECT id FROM users WHERE github_login = 'demo_kuba'), 'NVDA', 15, 140),
  ((SELECT id FROM users WHERE github_login = 'demo_kuba'), 'MSFT', 50, 400),
  ((SELECT id FROM users WHERE github_login = 'demo_ola'), 'GOOGL', 100, 175),
  ((SELECT id FROM users WHERE github_login = 'demo_piotr'), 'PKN.WA', 200, 70),
  ((SELECT id FROM users WHERE github_login = 'demo_piotr'), 'NVDA', 5, 125),
  ((SELECT id FROM users WHERE github_login = 'benchmark_sp500'), 'SPY', 20, 500),
  ((SELECT id FROM users WHERE github_login = 'benchmark_wig20'), 'WIG20.WA', 12, 2500);

INSERT INTO transactions (user_id, ticker, type, shares, price, total_value_pln, thesis, created_at)
VALUES
  ((SELECT id FROM users WHERE github_login = 'demo_marta'), 'AAPL', 'BUY', 40, 200, 32000, 'Silny popyt na nowe produkty i stabilny ekosystem usług.', datetime('now', '-5 hours')),
  ((SELECT id FROM users WHERE github_login = 'demo_marta'), 'PKN.WA', 'BUY', 300, 75, 22500, 'Dywidenda i poprawa marż w segmencie rafineryjnym.', datetime('now', '-4 hours')),
  ((SELECT id FROM users WHERE github_login = 'demo_kuba'), 'NVDA', 'BUY', 15, 140, 8400, 'Rosnący popyt na infrastrukturę obliczeniową AI.', datetime('now', '-3 hours')),
  ((SELECT id FROM users WHERE github_login = 'demo_kuba'), 'MSFT', 'BUY', 50, 400, 20000, 'Chmura i AI wspierają długoterminowy wzrost.', datetime('now', '-2 hours')),
  ((SELECT id FROM users WHERE github_login = 'demo_ola'), 'GOOGL', 'BUY', 100, 175, 70000, 'Reklama cyfrowa pozostaje mocnym źródłem przychodów.', datetime('now', '-95 minutes')),
  ((SELECT id FROM users WHERE github_login = 'demo_piotr'), 'PKN.WA', 'BUY', 200, 70, 14000, 'Zakup po korekcie z myślą o odbiciu sektora.', datetime('now', '-70 minutes')),
  ((SELECT id FROM users WHERE github_login = 'demo_piotr'), 'NVDA', 'BUY', 5, 125, 2500, 'Mała pozycja wzrostowa dla dywersyfikacji portfela.', datetime('now', '-35 minutes')),
  ((SELECT id FROM users WHERE github_login = 'benchmark_sp500'), 'SPY', 'BUY', 20, 500, 40000, 'Pasywny benchmark szerokiego rynku amerykańskiego.', datetime('now', '-25 minutes')),
  ((SELECT id FROM users WHERE github_login = 'benchmark_wig20'), 'WIG20.WA', 'BUY', 12, 2500, 30000, 'Pasywny benchmark największych spółek GPW.', datetime('now', '-15 minutes'));
