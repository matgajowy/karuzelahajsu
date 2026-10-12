-- Migracja 0003: feed rynkowy ze stand-upami AI (tabela market_news)
CREATE TABLE IF NOT EXISTS market_news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('STANDUP_MORNING', 'STANDUP_EVENING', 'MARKET_ALERT')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_news_created ON market_news(created_at DESC);
