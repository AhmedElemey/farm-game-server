const crypto = require('crypto');
const { makeCode, err } = require('./util');
const { worldFor } = require('./calendar');

function itemConf(econ, itemId) {
  return Object.assign({}, econ.default, econ.items[itemId] || {});
}

// Lazy multiplier: linear recovery toward 1.0 (recover_per_hour), clamped to item band.
function currentMultiplier(econ, row, conf) {
  const hours = (Date.now() - new Date(row.updated_at).getTime()) / 3600000;
  let m = row.multiplier + econ.market.recover_per_hour * hours;
  if (row.multiplier > 1) m = row.multiplier - econ.market.recover_per_hour * hours; // decay down if above 1
  m = Math.abs(m - 1) < 0.001 ? 1 : m;
  if ((row.multiplier - 1) * (m - 1) < 0) m = 1; // don't overshoot past 1
  return Math.min(conf.max_mult, Math.max(conf.min_mult, m));
}

// Season band for a crop item, from Hamada 10's crop_tag_map vs the live season.
function seasonMult(econ, itemId, seasonId) {
  const seasons = econ.market.crop_tag_map[itemId];
  if (!seasons || !seasonId) return 1.0;
  return seasons.includes(seasonId) ? econ.market.season_in_mult : econ.market.season_off_mult;
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
  // prizes: base 500/300/150 (+40 participant) x league multiplier by player level band
  const conf = econ.tournaments.rotation.find(r => r.id === t.kind) || econ.tournaments.rotation[0];
  const scores = await pool.query(
    `SELECT s.player_id, s.score, p.level FROM tournament_scores s JOIN players p ON p.id = s.player_id
     WHERE s.tournament_id = $1 ORDER BY s.score DESC`, [t.id]);
  for (let i = 0; i < scores.rows.length; i++) {
    const { player_id, score, level } = scores.rows[i];
    const bandIdx = econ.tournaments.level_bands.findIndex(b => level >= b[0] && level <= b[1]);
    const mult = econ.tournaments.league_mult[bandIdx] || 1;
    const rankKey = i < 3 ? String(i + 1) : 'participant';
    const prize = conf.prizes[rankKey];
    if (!prize) continue;
    const coins = prize.coins * mult;
    await pool.query('UPDATE players SET coins = coins + $1 WHERE id = $2', [coins, player_id]);
    await pool.query(
      `INSERT INTO rewards (id, player_id, kind, payload) VALUES ($1,$2,'tournament_prize',$3)`,
      [crypto.randomUUID(), player_id,
       JSON.stringify({ tournament_id: t.id, tournament: t.kind, rank: i + 1, score, coins, xp: prize.xp * mult, league_mult: mult })]);
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

module.exports = { itemConf, currentMultiplier, seasonMult, settleAuction, settleTournament, settleGuildOrder, makeCode, err, worldFor };
