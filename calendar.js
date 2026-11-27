// Server-side mirror of Hamada 18's seasons_calendar.json (shared keys only).
// Computes season, active events, decoration_theme, music_key, quest ids and
// event market multipliers for a given date. Weather stays client-side
// (deterministic per date+save seed, which only the client knows).
const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'seasons_calendar.json'), 'utf8'));

function md(date) { return { m: date.getMonth() + 1, d: date.getDate() }; }
function afterEq(a, b) { return a.m > b.m || (a.m === b.m && a.d >= b.d); }
function beforeEq(a, b) { return a.m < b.m || (a.m === b.m && a.d <= b.d); }

function seasonFor(date) {
  const cur = md(date);
  for (const s of data.seasons) {
    const st = { m: s.start_day.month, d: s.start_day.day };
    const en = { m: s.end_day.month, d: s.end_day.day };
    if (s.wraps_year) {
      if (afterEq(cur, st) || beforeEq(cur, en)) return s;
    } else if (afterEq(cur, st) && beforeEq(cur, en)) return s;
  }
  return null;
}

function isoDay(date) {
  const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function activeEvents(date) {
  const today = isoDay(date);
  const year = String(date.getFullYear());
  const out = [];
  for (const e of data.events) {
    const win = e.dates && (e.dates[year] || e.dates.fixed);
    if (!win) continue;
    if (today >= win.start && today <= win.end) out.push(e);
  }
  const wd = date.getDay(); // 0=Sun; data uses weekday with 5=Friday
  for (const w of data.weekly || []) {
    if (w.weekday === wd) out.push(w);
  }
  return out;
}

// Merged view for a date: everything other teams keyed off.
function worldFor(date) {
  const season = seasonFor(date);
  const evts = activeEvents(date);
  let marketMult = 1.0;
  const themes = [], music = [], quests = [], shopItems = [];
  for (const e of evts) {
    const fx = e.effects || {};
    if (fx.market_price_multiplier) marketMult *= fx.market_price_multiplier;
    if (fx.decoration_theme) themes.push(fx.decoration_theme);
    if (fx.music_key) music.push(fx.music_key);
    for (const q of e.quests || []) quests.push(q);
    for (const it of fx.shop_items || []) shopItems.push(it);
  }
  return {
    date: isoDay(date),
    season: season ? { id: season.id, name_ar: season.name_ar, crop_boost: season.crop_boost, crop_penalty: season.crop_penalty, watering_multiplier: season.watering_multiplier } : null,
    events: evts.map(e => ({ id: e.id, name_ar: e.name_ar, type: e.type || 'weekly' })),
    decoration_theme: themes[0] || null,
    music_key: music[0] || null,
    quest_ids: quests,
    shop_items: shopItems,
    event_market_multiplier: Math.round(marketMult * 1000) / 1000
  };
}

module.exports = { worldFor, seasonFor, activeEvents, data };
