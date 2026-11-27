const crypto = require('crypto');
const { makeCode, err } = require('./util');
const { itemConf, currentMultiplier, seasonMult, settleAuction, settleTournament, settleGuildOrder, worldFor } = require('./game-logic');
const { seasonFor } = require('./calendar');

const WEEK_MS = 7 * 24 * 3600 * 1000;

module.exports = function gameRoutes(app, pool, authMw, econ) {

  // ---- World / seasons (shared keys for engine, art, sound, story) ----
  app.get('/world/today', async (req, res) => {
    res.json(worldFor(new Date()));
  });

  // ---- Market ----
  app.get('/market/prices', authMw, async (req, res, next) => {
    try {
      const r = await pool.query('SELECT item_id, multiplier, updated_at FROM market_state');
      const world = worldFor(new Date());
      const season = seasonFor(new Date());
      const seasonId = season ? season.id : null;
      const mults = {};
      const ids = new Set([...Object.keys(econ.items), ...r.rows.map(x => x.item_id)]);
      for (const id of ids) {
        const conf = itemConf(econ, id);
        const row = r.rows.find(x => x.item_id === id);
        const base = row ? currentMultiplier(econ, row, conf) : 1.0;
        const combined = base * seasonMult(econ, id, seasonId) * world.event_market_multiplier;
        mults[id] = Math.round(combined * 1000) / 1000;
      }
      res.json({ multipliers: mults, season: seasonId, event_market_multiplier: world.event_market_multiplier, updated_at: new Date().toISOString() });
    } catch (e) { next(e); }
  });

  app.post('/market/sell', authMw, async (req, res, next) => {
    try {
      const { item_id, count } = req.body || {};
      const n = Number(count);
      if (!item_id || !Number.isInteger(n) || n <= 0) return err(res, 400, 'bad_sell', 'item_id and positive integer count required');
      const conf = itemConf(econ, item_id);
      const r = await pool.query('SELECT * FROM market_state WHERE item_id = $1', [item_id]);
      const row = r.rows[0] || { multiplier: 1.0, updated_at: new Date() };
      const m = currentMultiplier(econ, row, conf);
      const season = seasonFor(new Date());
      const sMult = seasonMult(econ, item_id, season ? season.id : null);
      const eventMult = worldFor(new Date()).event_market_multiplier;
      const eff = m * sMult * eventMult;
      const coins = Math.round(conf.base_price * eff * n);
      // sell pressure: -drop_per_unit per unit, floored at item band / global floor
      const floor = Math.max(conf.min_mult, econ.market.floor_mult);
      const newM = Math.max(floor, m - econ.market.drop_per_unit_sold * n);
      await pool.query(
        `INSERT INTO market_state (item_id, multiplier, updated_at) VALUES ($1,$2,now())
         ON CONFLICT (item_id) DO UPDATE SET multiplier = $2, updated_at = now()`, [item_id, newM]);
      await pool.query(
        'INSERT INTO market_trades (id, player_id, item_id, count, coins, multiplier) VALUES ($1,$2,$3,$4,$5,$6)',
        [crypto.randomUUID(), req.player.id, item_id, n, coins, eff]);
      await pool.query('UPDATE players SET coins = coins + $1 WHERE id = $2', [coins, req.player.id]);
      res.json({ coins_received: coins, new_multiplier: Math.round(newM * sMult * eventMult * 1000) / 1000 });
    } catch (e) { next(e); }
  });

  // ---- Auctions (weekly) ----
  async function currentAuction() {
    let r = await pool.query(`SELECT * FROM auctions WHERE status = 'open' ORDER BY created_at DESC LIMIT 1`);
    if (r.rows.length > 0) {
      const a = r.rows[0];
      if (new Date(a.closes_at) <= new Date()) { await settleAuction(pool, a, econ); r = await pool.query(`SELECT * FROM auctions WHERE status='open' ORDER BY created_at DESC LIMIT 1`); }
      else return a;
    }
    if (r.rows.length === 0) {
      const item = econ.auctions.items[Math.floor(Math.random() * econ.auctions.items.length)];
      const id = crypto.randomUUID();
      await pool.query('INSERT INTO auctions (id, item_id, closes_at) VALUES ($1,$2,$3)',
        [id, item, new Date(Date.now() + WEEK_MS)]);
      const again = await pool.query('SELECT * FROM auctions WHERE id = $1', [id]);
      return again.rows[0];
    }
    return null;
  }

  app.get('/auctions/current', authMw, async (req, res, next) => {
    try {
      const a = await currentAuction();
      if (!a) return err(res, 404, 'no_auction', 'No auction right now');
      const top = await pool.query(
        `SELECT b.amount, p.display_name FROM bids b JOIN players p ON p.id = b.player_id
         WHERE b.auction_id = $1 AND b.status = 'active' ORDER BY b.amount DESC, b.created_at ASC LIMIT 1`, [a.id]);
      const last = await pool.query(
        `SELECT a.item_id, a.winning_bid, p.display_name AS winner_name FROM auctions a
         LEFT JOIN players p ON p.id = a.winner_id WHERE a.status = 'settled' ORDER BY a.closes_at DESC LIMIT 1`);
      res.json({
        auction_id: a.id, item: a.item_id, closes_at: a.closes_at,
        top_bid: top.rows[0] ? top.rows[0].amount : null,
        top_bidder_name: top.rows[0] ? top.rows[0].display_name : null,
        last_result: last.rows[0] || null
      });
    } catch (e) { next(e); }
  });

  app.post('/auctions/:id/bid', authMw, async (req, res, next) => {
    const client = await pool.connect();
    try {
      const amount = Number(req.body && req.body.amount);
      if (!Number.isInteger(amount) || amount <= 0) return err(res, 400, 'bad_amount', 'Positive integer amount required');
      await client.query('BEGIN');
      const ar = await client.query(`SELECT * FROM auctions WHERE id = $1 AND status = 'open' FOR UPDATE`, [req.params.id]);
      if (ar.rows.length === 0) { await client.query('ROLLBACK'); return err(res, 404, 'no_auction', 'No open auction with that id'); }
      let a = ar.rows[0];
      if (new Date(a.closes_at) <= new Date()) {
        await settleAuction(client, a, econ);
        await client.query('COMMIT');
        return err(res, 410, 'auction_closed', 'Auction already closed');
      }
      const top = await client.query(
        `SELECT amount FROM bids WHERE auction_id = $1 AND status = 'active' ORDER BY amount DESC LIMIT 1`, [a.id]);
      const minBid = (top.rows[0] ? top.rows[0].amount : 0) + econ.auctions.min_increment;
      if (amount < minBid) { await client.query('ROLLBACK'); return err(res, 400, 'bid_too_low', `Minimum bid is ${minBid}`); }
      const pr = await client.query('SELECT coins FROM players WHERE id = $1 FOR UPDATE', [req.player.id]);
      if (pr.rows[0].coins < amount) { await client.query('ROLLBACK'); return err(res, 400, 'insufficient_funds', 'Not enough coins'); }
      // refund previous active bidders, debit the new bidder
      const prev = await client.query(
        `SELECT DISTINCT player_id FROM bids WHERE auction_id = $1 AND status = 'active'`, [a.id]);
      for (const row of prev.rows) {
        const held = await client.query(
          `SELECT COALESCE(SUM(amount),0) AS s FROM bids WHERE auction_id = $1 AND player_id = $2 AND status = 'active'`,
          [a.id, row.player_id]);
        await client.query('UPDATE players SET coins = coins + $1 WHERE id = $2', [parseInt(held.rows[0].s, 10), row.player_id]);
      }
      await client.query(`UPDATE bids SET status = 'refunded' WHERE auction_id = $1 AND status = 'active'`, [a.id]);
      await client.query('UPDATE players SET coins = coins - $1 WHERE id = $2', [amount, req.player.id]);
      await client.query('INSERT INTO bids (id, auction_id, player_id, amount) VALUES ($1,$2,$3,$4)',
        [crypto.randomUUID(), a.id, req.player.id, amount]);
      // anti-sniping
      const now = Date.now();
      const close = new Date(a.closes_at).getTime();
      if (close - now < econ.auctions.anti_snipe_window_sec * 1000) {
        const newClose = new Date(now + econ.auctions.anti_snipe_extend_sec * 1000);
        await client.query('UPDATE auctions SET closes_at = $1 WHERE id = $2', [newClose, a.id]);
        a.closes_at = newClose;
      }
      await client.query('COMMIT');
      res.json({ ok: true, amount, closes_at: a.closes_at });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      next(e);
    } finally { client.release(); }
  });

  // ---- Guilds ----
  app.post('/guilds', authMw, async (req, res, next) => {
    try {
      const name = ((req.body && req.body.name) || '').trim().slice(0, 40);
      if (!name) return err(res, 400, 'no_name', 'name required');
      const member = await pool.query('SELECT guild_id FROM guild_members WHERE player_id = $1', [req.player.id]);
      if (member.rows.length > 0) return err(res, 400, 'already_in_guild', 'Leave your current guild first');
      const id = crypto.randomUUID();
      const invite = makeCode(8);
      await pool.query('INSERT INTO guilds (id, name, invite_code, leader_id) VALUES ($1,$2,$3,$4)',
        [id, name, invite, req.player.id]);
      await pool.query('INSERT INTO guild_members (guild_id, player_id, role) VALUES ($1,$2,$3)', [id, req.player.id, 'leader']);
      const now = Date.now();
      await pool.query(
        'INSERT INTO guild_orders (id, guild_id, week_start, week_end, required_units) VALUES ($1,$2,$3,$4,$5)',
        [crypto.randomUUID(), id, new Date(now), new Date(now + WEEK_MS), econ.guilds.order_size_units]);
      res.status(201).json({ guild_id: id, invite_code: invite });
    } catch (e) { next(e); }
  });

  app.post('/guilds/join', authMw, async (req, res, next) => {
    try {
      const code = ((req.body && req.body.invite_code) || '').trim().toUpperCase();
      if (!code) return err(res, 400, 'no_code', 'invite_code required');
      const g = await pool.query('SELECT id, name FROM guilds WHERE invite_code = $1', [code]);
      if (g.rows.length === 0) return err(res, 404, 'not_found', 'No guild with that invite code');
      const member = await pool.query('SELECT guild_id FROM guild_members WHERE player_id = $1', [req.player.id]);
      if (member.rows.length > 0) return err(res, 400, 'already_in_guild', 'Already in a guild');
      await pool.query('INSERT INTO guild_members (guild_id, player_id) VALUES ($1,$2)', [g.rows[0].id, req.player.id]);
      res.json({ ok: true, guild_id: g.rows[0].id, name: g.rows[0].name });
    } catch (e) { next(e); }
  });

  app.get('/guilds/me', authMw, async (req, res, next) => {
    try {
      const m = await pool.query(
        `SELECT g.id, g.name, g.invite_code, gm.role FROM guild_members gm JOIN guilds g ON g.id = gm.guild_id
         WHERE gm.player_id = $1`, [req.player.id]);
      if (m.rows.length === 0) return err(res, 404, 'no_guild', 'Not in a guild');
      const g = m.rows[0];
      const members = await pool.query(
        `SELECT p.id AS player_id, p.display_name, p.level, gm.role FROM guild_members gm
         JOIN players p ON p.id = gm.player_id WHERE gm.guild_id = $1`, [g.id]);
      let order = await pool.query(
        `SELECT * FROM guild_orders WHERE guild_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 1`, [g.id]);
      if (order.rows.length > 0 && new Date(order.rows[0].week_end) <= new Date()) {
        await settleGuildOrder(pool, order.rows[0], econ);
        const oid = crypto.randomUUID();
        const now = Date.now();
        await pool.query(
          'INSERT INTO guild_orders (id, guild_id, week_start, week_end, required_units) VALUES ($1,$2,$3,$4,$5)',
          [oid, g.id, new Date(now), new Date(now + WEEK_MS), econ.guilds.order_size_units]);
        order = await pool.query('SELECT * FROM guild_orders WHERE id = $1', [oid]);
      }
      const o = order.rows[0] || null;
      res.json({
        guild_id: g.id, name: g.name, invite_code: g.invite_code, role: g.role,
        members: members.rows,
        weekly_order: o ? {
          order_id: o.id, required_units: o.required_units, contributed_units: o.contributed_units,
          week_start: o.week_start, week_end: o.week_end, status: o.status
        } : null
      });
    } catch (e) { next(e); }
  });

  app.post('/guilds/orders/contribute', authMw, async (req, res, next) => {
    try {
      const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
      const units = items.reduce((s, it) => s + (Number.isInteger(it.count) ? it.count : 0), 0);
      if (units <= 0) return err(res, 400, 'no_items', 'items: [{item_id, count}] with positive counts');
      const m = await pool.query('SELECT guild_id FROM guild_members WHERE player_id = $1', [req.player.id]);
      if (m.rows.length === 0) return err(res, 404, 'no_guild', 'Not in a guild');
      const o = await pool.query(
        `SELECT * FROM guild_orders WHERE guild_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 1`, [m.rows[0].guild_id]);
      if (o.rows.length === 0) return err(res, 404, 'no_order', 'No open weekly order');
      const order = o.rows[0];
      await pool.query(
        `INSERT INTO guild_contributions (order_id, player_id, units) VALUES ($1,$2,$3)
         ON CONFLICT (order_id, player_id) DO UPDATE SET units = guild_contributions.units + $3`,
        [order.id, req.player.id, units]);
      const updated = await pool.query(
        `UPDATE guild_orders SET contributed_units = contributed_units + $1 WHERE id = $2 RETURNING contributed_units`,
        [units, order.id]);
      res.json({ ok: true, contributed_units: updated.rows[0].contributed_units, required_units: order.required_units });
    } catch (e) { next(e); }
  });

  // ---- Tournaments ----
  async function currentTournament() {
    let r = await pool.query(`SELECT * FROM tournaments WHERE status = 'open' ORDER BY created_at DESC LIMIT 1`);
    if (r.rows.length > 0) {
      const t = r.rows[0];
      if (new Date(t.ends_at) <= new Date()) {
        await settleTournament(pool, t, econ);
        r = await pool.query(`SELECT * FROM tournaments WHERE status = 'open' ORDER BY created_at DESC LIMIT 1`);
      } else return t;
    }
    if (r.rows.length === 0) {
      // rotate through Hamada 10's tournament set with their windows
      const last = await pool.query('SELECT kind FROM tournaments ORDER BY created_at DESC LIMIT 1');
      const rot = econ.tournaments.rotation;
      const lastIdx = last.rows.length ? rot.findIndex(x => x.id === last.rows[0].kind) : -1;
      const next = rot[(lastIdx + 1) % rot.length];
      const id = crypto.randomUUID();
      const now = Date.now();
      await pool.query('INSERT INTO tournaments (id, kind, metric, starts_at, ends_at) VALUES ($1,$2,$3,$4,$5)',
        [id, next.id, next.metric, new Date(now), new Date(now + next.window_seconds * 1000)]);
      const again = await pool.query('SELECT * FROM tournaments WHERE id = $1', [id]);
      return again.rows[0];
    }
    return null;
  }

  app.get('/tournaments/current', authMw, async (req, res, next) => {
    try {
      const t = await currentTournament();
      if (!t) return err(res, 404, 'no_tournament', 'No tournament right now');
      const top = await pool.query(
        `SELECT p.display_name, s.score FROM tournament_scores s JOIN players p ON p.id = s.player_id
         WHERE s.tournament_id = $1 ORDER BY s.score DESC LIMIT 10`, [t.id]);
      const mine = await pool.query(
        'SELECT score FROM tournament_scores WHERE tournament_id = $1 AND player_id = $2', [t.id, req.player.id]);
      let rank = null, myScore = 0;
      if (mine.rows.length > 0) {
        myScore = mine.rows[0].score;
        const higher = await pool.query(
          'SELECT COUNT(*) AS c FROM tournament_scores WHERE tournament_id = $1 AND score > $2', [t.id, myScore]);
        rank = parseInt(higher.rows[0].c, 10) + 1;
      }
      res.json({
        tournament_id: t.id, tournament: t.kind, metric: t.metric,
        window: { starts_at: t.starts_at, ends_at: t.ends_at },
        your_rank: rank,
        your_score: myScore,
        top: top.rows
      });
    } catch (e) { next(e); }
  });

  app.post('/tournaments/score', authMw, async (req, res, next) => {
    try {
      const delta = Number(req.body && req.body.delta);
      if (!Number.isFinite(delta) || delta <= 0) return err(res, 400, 'bad_delta', 'Positive numeric delta required');
      const t = await currentTournament();
      if (!t) return err(res, 404, 'no_tournament', 'No tournament right now');
      const capPerMin = econ.tournaments.max_delta_per_minute;
      const cur = await pool.query(
        'SELECT score, allowance, allowance_ts FROM tournament_scores WHERE tournament_id = $1 AND player_id = $2',
        [t.id, req.player.id]);
      let allowance = capPerMin, allowanceTs = Date.now(), score = 0;
      if (cur.rows.length > 0) {
        const row = cur.rows[0];
        const elapsedMin = (Date.now() - new Date(row.allowance_ts).getTime()) / 60000;
        allowance = Math.min(capPerMin, row.allowance + elapsedMin * capPerMin);
        score = row.score;
      }
      const accepted = Math.min(delta, allowance);
      allowance -= accepted;
      await pool.query(
        `INSERT INTO tournament_scores (tournament_id, player_id, score, allowance, allowance_ts)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tournament_id, player_id)
         DO UPDATE SET score = tournament_scores.score + $3, allowance = $4, allowance_ts = $5`,
        [t.id, req.player.id, accepted, allowance, new Date()]);
      res.json({ ok: true, accepted_delta: accepted, your_score: score + accepted });
    } catch (e) { next(e); }
  });
};
