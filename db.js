const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
  max: 5
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY,
  device_token_hash TEXT UNIQUE NOT NULL,
  friend_code TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  avatar_id TEXT NOT NULL DEFAULT 'farmer_1',
  level INT NOT NULL DEFAULT 1,
  coins INT NOT NULL DEFAULT 200,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS saves (
  player_id UUID PRIMARY KEY REFERENCES players(id),
  save_blob JSONB NOT NULL,
  save_version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS friendships (
  id UUID PRIMARY KEY,
  requester_id UUID NOT NULL REFERENCES players(id),
  addressee_id UUID NOT NULL REFERENCES players(id),
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (requester_id, addressee_id)
);
CREATE TABLE IF NOT EXISTS market_state (
  item_id TEXT PRIMARY KEY,
  multiplier DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS market_trades (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id),
  item_id TEXT NOT NULL,
  count INT NOT NULL,
  coins INT NOT NULL,
  multiplier DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auctions (
  id UUID PRIMARY KEY,
  item_id TEXT NOT NULL,
  closes_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  winner_id UUID REFERENCES players(id),
  winning_bid INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bids (
  id UUID PRIMARY KEY,
  auction_id UUID NOT NULL REFERENCES auctions(id),
  player_id UUID NOT NULL REFERENCES players(id),
  amount INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guilds (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  invite_code TEXT UNIQUE NOT NULL,
  leader_id UUID NOT NULL REFERENCES players(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guild_members (
  guild_id UUID NOT NULL REFERENCES guilds(id),
  player_id UUID NOT NULL REFERENCES players(id),
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, player_id)
);
CREATE TABLE IF NOT EXISTS guild_orders (
  id UUID PRIMARY KEY,
  guild_id UUID NOT NULL REFERENCES guilds(id),
  week_start TIMESTAMPTZ NOT NULL,
  week_end TIMESTAMPTZ NOT NULL,
  required_units INT NOT NULL,
  contributed_units INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guild_contributions (
  order_id UUID NOT NULL REFERENCES guild_orders(id),
  player_id UUID NOT NULL REFERENCES players(id),
  units INT NOT NULL DEFAULT 0,
  PRIMARY KEY (order_id, player_id)
);
CREATE TABLE IF NOT EXISTS tournaments (
  id UUID PRIMARY KEY,
  metric TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tournament_scores (
  tournament_id UUID NOT NULL REFERENCES tournaments(id),
  player_id UUID NOT NULL REFERENCES players(id),
  score DOUBLE PRECISION NOT NULL DEFAULT 0,
  allowance DOUBLE PRECISION NOT NULL DEFAULT 1000,
  allowance_ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id, player_id)
);
CREATE TABLE IF NOT EXISTS rewards (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id),
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  claimed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA);
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb };
