const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeCode(len) {
  let s = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function err(res, status, code, message) {
  return res.status(status).json({ error: code, message });
}

// Bearer auth middleware: resolves req.player from players table.
function auth(pool) {
  return async (req, res, next) => {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return err(res, 401, 'no_auth', 'Missing bearer token');
    const tokenHash = hashToken(m[1]);
    try {
      const r = await pool.query('SELECT * FROM players WHERE device_token_hash = $1', [tokenHash]);
      if (r.rows.length === 0) return err(res, 401, 'bad_token', 'Unknown device token');
      req.player = r.rows[0];
      // touch last_seen at most once a minute
      if (Date.now() - new Date(req.player.last_seen).getTime() > 60000) {
        pool.query('UPDATE players SET last_seen = now() WHERE id = $1', [req.player.id]).catch(() => {});
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

module.exports = { makeCode, hashToken, err, auth };
