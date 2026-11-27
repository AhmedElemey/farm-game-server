const crypto = require('crypto');
const { makeCode, err } = require('./util');
const { worldFor } = require('./calendar');

function itemConf(econ, itemId) {
  return Object.assign({}, econ.default, econ.items[itemId] || {});
}

// Lazy multiplier: recover toward 1.0 with time, apply clamp.
function currentMultiplier(econ, row, conf) {
  const tauMs = econ.market.recovery_tau_hours * 3600 * 1000;
  const dt = Date.now() - new Date(row.updated_at).getTime();
  const m = 1 + (row.multiplier - 1) * Math.exp(-dt / tauMs);
  return Math.min(conf.max_mult, Math.max(conf.min_mult, m));
}

// Losers are refunded at outbid time (see POST /auctions/:id/bid), so settling
// only marks the top active bid as won and records the reward.
async function settleAuction(pool, a, econ) {
  const top = await pool.query(
    `SELECT id, player_id, amount FROM bids WHERE auction_id = $1 AND status = 'active'
     ORDER BY amount DESC, created_at ASC LIMIT 1`, [a.id]);
  if (top.rows.length > 0) {
    const win = top.rows[0];
    await pool.query(`UPDATE bids SET status = 'won' WHERE id = $1`, [win.id]);
    await pool.query(
      `UPDATE auctions SET status = 'settled', winner_id = $1, winning_bid = $2 WHERE id = $3`,
      [win.player_id, win.amount, a.id]);
    await pool.query(
      `INSERT INTO rewards (id, player_id, kind, payload) VALUES ($1,$2,'auction_win',$3)`,
      [crypto.randomUUID(), win.player_id, JSON.stringify({ auction_id: a.id, item_id: a.item_id, bid: win.amount })]);
  } else {
    await pool.query(`UPDATE auctions SET status = 'settled' WHERE id = $1`, [a.id]);
  }
}

async function settleTournament(pool, t, econ) {
  const top = await pool.query(
    `SELECT player_id, score FROM tournament_scores WHERE tournament_id = $1 ORDER BY score DESC LIMIT 3`, [t.id]);
  for (let i = 0; i < top.rows.length; i++) {
    const coins = econ.tournaments.payout_coins[i] || 0;
    await pool.query('UPDATE players SET coins = coins + $1 WHERE id = $2', [coins, top.rows[i].player_id]);
    await pool.query(
      `INSERT INTO rewards (id, player_id, kind, payload) VALUES ($1,$2,'tournament_prize',$3)`,
      [crypto.randomUUID(), top.rows[i].player_id,
       JSON.stringify({ tournament_id: t.id, rank: i + 1, score: top.rows[i].score, coins })]);
  }
  await pool.query(`UPDATE tournaments SET status = 'settled' WHERE id = $1`, [t.id]);
}

async function settleGuildOrder(pool, o, econ) {
  if (o.contributed_units < o.required_units) {
    await pool.query(`UPDATE guild_orders SET status = 'expired' WHERE id = $1`, [o.id]);
    return;
  }
  const shares = await pool.query(
    'SELECT player_id, units FROM guild_contributions WHERE order_id = $1 AND units > 0', [o.id]);
  const total = shares.rows.reduce((s, r) => s + r.units, 0) || 1;
  for (const s of shares.rows) {
    const coins = Math.round(econ.guilds.order_reward_pool_coins * s.units / total);
    await pool.query('UPDATE players SET coins = coins + $1 WHERE id = $2', [coins, s.player_id]);
    await pool.query(
      `INSERT INTO rewards (id, player_id, kind, payload) VALUES ($1,$2,'guild_order_reward',$3)`,
      [crypto.randomUUID(), s.player_id, JSON.stringify({ order_id: o.id, units: s.units, coins })]);
  }
  await pool.query(`UPDATE guild_orders SET status = 'settled' WHERE id = $1`, [o.id]);
}

module.exports = { itemConf, currentMultiplier, settleAuction, settleTournament, settleGuildOrder, makeCode, err, worldFor };
