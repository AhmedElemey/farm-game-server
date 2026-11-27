const express = require('express');
const fs = require('fs');
const path = require('path');
const { pool, initDb } = require('./db');
const { auth } = require('./util');

const econ = JSON.parse(fs.readFileSync(path.join(__dirname, 'economy.json'), 'utf8'));

const app = express();
app.use(express.json({ limit: '5mb' }));

// CORS: open to the game origin (hosted File + local dev)
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'farm-game-server', time: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ ok: false, error: 'db_down' });
  }
});

const authMw = auth(pool);
require('./routes-core')(app, pool, authMw, econ);
require('./routes-game')(app, pool, authMw, econ);

// eslint-disable-next-line no-unused-vars
app.use((e, req, res, next) => {
  console.error(e);
  res.status(500).json({ error: 'server_error', message: 'Unexpected error' });
});

const port = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(port, () => console.log(`farm-game-server listening on ${port}`));
  })
  .catch((e) => {
    console.error('DB init failed', e);
    process.exit(1);
  });
