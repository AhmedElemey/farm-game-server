const crypto = require('crypto');
const { makeCode, hashToken, err } = require('./util');

// Players, cloud save, friends.
module.exports = function coreRoutes(app, pool, authMw, econ) {

  app.post('/players', async (req, res, next) => {
    try {
      const id = crypto.randomUUID();
      const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
      const name = (req.body && typeof req.body.display_name === 'string' && req.body.display_name.trim())
        ? req.body.display_name.trim().slice(0, 40)
        : 'مزارع ' + makeCode(4);
      let friendCode = null;
      for (let i = 0; i < 10 && !friendCode; i++) {
        const c = makeCode(6);
        const dupe = await pool.query('SELECT 1 FROM players WHERE friend_code = $1', [c]);
        if (dupe.rows.length === 0) friendCode = c;
      }
      await pool.query(
        'INSERT INTO players (id, device_token_hash, friend_code, display_name, coins) VALUES ($1,$2,$3,$4,$5)',
        [id, hashToken(token), friendCode, name, econ.players.starting_coins]
      );
      res.status(201).json({ player_id: id, device_token: token, friend_code: friendCode, display_name: name });
    } catch (e) { next(e); }
  });

  app.get('/players/me', authMw, async (req, res, next) => {
    try {
      const p = req.player;
      const rewards = await pool.query(
        'SELECT id, kind, payload, created_at FROM rewards WHERE player_id = $1 AND NOT claimed ORDER BY created_at', [p.id]);
      res.json({
        player_id: p.id, friend_code: p.friend_code, display_name: p.display_name,
        avatar_id: p.avatar_id, level: p.level, coins: p.coins, last_seen: p.last_seen,
        pending_rewards: rewards.rows
      });
    } catch (e) { next(e); }
  });

  app.patch('/players/me', authMw, async (req, res, next) => {
    try {
      const { display_name, avatar_id, level } = req.body || {};
      const sets = [], vals = [];
      if (typeof display_name === 'string' && display_name.trim()) { vals.push(display_name.trim().slice(0, 40)); sets.push(`display_name = $${vals.length}`); }
      if (typeof avatar_id === 'string' && avatar_id.trim()) { vals.push(avatar_id.trim().slice(0, 40)); sets.push(`avatar_id = $${vals.length}`); }
      if (Number.isInteger(level) && level >= 1 && level <= 999) { vals.push(level); sets.push(`level = $${vals.length}`); }
      if (sets.length === 0) return err(res, 400, 'nothing_to_update', 'Send display_name, avatar_id or level');
      vals.push(req.player.id);
      await pool.query(`UPDATE players SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.post('/rewards/claim', authMw, async (req, res, next) => {
    try {
      const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
      if (ids.length === 0) return err(res, 400, 'no_ids', 'Send ids[]');
      const r = await pool.query(
        'UPDATE rewards SET claimed = true WHERE player_id = $1 AND id = ANY($2::uuid[]) AND NOT claimed RETURNING id, kind, payload',
        [req.player.id, ids]);
      res.json({ claimed: r.rows });
    } catch (e) { next(e); }
  });

  // ---- Cloud save (last-write-wins on updated_at, 409 returns stored blob) ----

  app.put('/save', authMw, async (req, res, next) => {
    try {
      const { save_blob, save_version, updated_at, level } = req.body || {};
      if (save_blob === undefined || save_blob === null) return err(res, 400, 'no_blob', 'save_blob required');
      const clientTs = updated_at ? new Date(updated_at) : new Date();
      if (isNaN(clientTs.getTime())) return err(res, 400, 'bad_ts', 'updated_at not a date');
      const ver = Number.isInteger(save_version) ? save_version : 1;
      const cur = await pool.query('SELECT save_blob, save_version, updated_at FROM saves WHERE player_id = $1', [req.player.id]);
      if (cur.rows.length > 0 && new Date(cur.rows[0].updated_at) > clientTs) {
        return res.status(409).json({
          error: 'conflict', message: 'Server has a newer save',
          save_blob: cur.rows[0].save_blob, save_version: cur.rows[0].save_version, updated_at: cur.rows[0].updated_at
        });
      }
      await pool.query(
        `INSERT INTO saves (player_id, save_blob, save_version, updated_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (player_id) DO UPDATE SET save_blob = $2, save_version = $3, updated_at = $4`,
        [req.player.id, JSON.stringify(save_blob), ver, clientTs]);
      if (Number.isInteger(level)) {
        pool.query('UPDATE players SET level = $1 WHERE id = $2', [level, req.player.id]).catch(() => {});
      }
      res.json({ ok: true, updated_at: clientTs });
    } catch (e) { next(e); }
  });

  app.get('/save', authMw, async (req, res, next) => {
    try {
      const r = await pool.query('SELECT save_blob, save_version, updated_at FROM saves WHERE player_id = $1', [req.player.id]);
      if (r.rows.length === 0) return err(res, 404, 'no_save', 'No cloud save yet');
      res.json(r.rows[0]);
    } catch (e) { next(e); }
  });

  // ---- Friends ----

  app.post('/friends/request', authMw, async (req, res, next) => {
    try {
      const code = ((req.body && req.body.friend_code) || '').trim().toUpperCase();
      if (!code) return err(res, 400, 'no_code', 'friend_code required');
      const target = await pool.query('SELECT id, display_name FROM players WHERE friend_code = $1', [code]);
      if (target.rows.length === 0) return err(res, 404, 'not_found', 'No player with that friend code');
      const other = target.rows[0].id;
      if (other === req.player.id) return err(res, 400, 'self', 'Cannot friend yourself');
      // reverse pending request? treat as accept
      const rev = await pool.query(
        `SELECT id FROM friendships WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'`, [other, req.player.id]);
      if (rev.rows.length > 0) {
        await pool.query(`UPDATE friendships SET status = 'accepted' WHERE id = $1`, [rev.rows[0].id]);
        return res.json({ ok: true, status: 'accepted', player_id: other });
      }
      const existing = await pool.query(
        'SELECT status FROM friendships WHERE requester_id = $1 AND addressee_id = $2', [req.player.id, other]);
      if (existing.rows.length > 0) return res.json({ ok: true, status: existing.rows[0].status, player_id: other });
      await pool.query(
        'INSERT INTO friendships (id, requester_id, addressee_id) VALUES ($1,$2,$3)',
        [crypto.randomUUID(), req.player.id, other]);
      res.status(201).json({ ok: true, status: 'pending', player_id: other });
    } catch (e) { next(e); }
  });

  app.post('/friends/accept', authMw, async (req, res, next) => {
    try {
      const pid = req.body && req.body.player_id;
      if (!pid) return err(res, 400, 'no_player', 'player_id required');
      const r = await pool.query(
        `UPDATE friendships SET status = 'accepted' WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending' RETURNING id`,
        [pid, req.player.id]);
      if (r.rows.length === 0) return err(res, 404, 'no_request', 'No pending request from that player');
      res.json({ ok: true, status: 'accepted' });
    } catch (e) { next(e); }
  });

  app.get('/friends', authMw, async (req, res, next) => {
    try {
      const r = await pool.query(
        `SELECT p.id AS player_id, p.display_name, p.avatar_id, p.level, p.last_seen
         FROM friendships f JOIN players p
           ON p.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
         WHERE (f.requester_id = $1 OR f.addressee_id = $1) AND f.status = 'accepted'`, [req.player.id]);
      const incoming = await pool.query(
        `SELECT p.id AS player_id, p.display_name, p.level FROM friendships f JOIN players p ON p.id = f.requester_id
         WHERE f.addressee_id = $1 AND f.status = 'pending'`, [req.player.id]);
      res.json({ friends: r.rows, incoming_requests: incoming.rows });
    } catch (e) { next(e); }
  });

  app.get('/friends/:id/farm', authMw, async (req, res, next) => {
    try {
      const fid = req.params.id;
      const fr = await pool.query(
        `SELECT 1 FROM friendships WHERE status = 'accepted' AND
         ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))`,
        [req.player.id, fid]);
      if (fr.rows.length === 0) return err(res, 403, 'not_friends', 'Not friends with that player');
      const p = await pool.query('SELECT id, display_name, avatar_id, level FROM players WHERE id = $1', [fid]);
      if (p.rows.length === 0) return err(res, 404, 'not_found', 'No such player');
      const s = await pool.query('SELECT save_blob, updated_at FROM saves WHERE player_id = $1', [fid]);
      const blob = s.rows.length ? s.rows[0].save_blob : null;
      res.json({
        player_id: p.rows[0].id, display_name: p.rows[0].display_name,
        avatar_id: p.rows[0].avatar_id, level: p.rows[0].level,
        farm_snapshot: blob && blob.farm ? blob.farm : blob,
        save_updated_at: s.rows.length ? s.rows[0].updated_at : null
      });
    } catch (e) { next(e); }
  });
};
