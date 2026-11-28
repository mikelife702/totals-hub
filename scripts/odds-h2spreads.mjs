// Pull DraftKings' 2nd-half SPREAD at halftime for past games already matched in data/<season>-h2lines.json.
// Same snapshot time as the 2nd-half totals (8 min after the 1st half ended). No event-list cost.
// Priority: favorites 6+ that were 6+ short of schedule at halftime, then favorites 6+ ahead of schedule, then other favorites 6+, then the rest.
// Run: node scripts/odds-h2spreads.mjs ncaa2025   (env ODDS_API_KEY, MIN_LEFT)
import fs from 'node:fs';
const KEY = process.env.ODDS_API_KEY; if (!KEY) { console.log('No ODDS_API_KEY'); process.exit(1); }
const season = process.argv[2] || 'ncaa2025', MIN_LEFT = +(process.env.MIN_LEFT || 100);
const HOST = 'https://api.the-odds-api.com', SPORT = 'basketball_ncaab', OUT = 'data/' + season + '-h2spreads.json';
const H = JSON.parse(fs.readFileSync('data/' + season + '-h2lines.json', 'utf8')).games;
const G = JSON.parse(fs.readFileSync('data/' + season + '-games.json', 'utf8')).games;
let store = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { v: 1, games: {}, log: [] };
const save = () => fs.writeFileSync(OUT, JSON.stringify(store));
let left = null;
async function call(path, params) {
  for (let i = 0; i < 4; i++) {
    try { const r = await fetch(HOST + path + '?' + new URLSearchParams({ ...params, apiKey: KEY }).toString());
      left = +r.headers.get('x-requests-remaining'); if (r.status === 429) { await new Promise(s => setTimeout(s, 2000 * (i + 1))); continue; }
      if (!r.ok) return null; return await r.json(); } catch (e) { await new Promise(s => setTimeout(s, 1500 * (i + 1))); }
  }
  return null;
}
const pri = id => { const g = G[id]; if (!g || !g.lines || g.lines.spread == null || !g.halves) return 9;
  const home = g.teams.find(t => t.home), away = g.teams.find(t => !t.home); if (!home || !away || !g.halves[home.id] || !g.halves[away.id]) return 9;
  const sp = Math.abs(g.lines.spread), fav = g.lines.spread < 0 ? home : away, dog = fav === home ? away : home;
  const short = sp * 0.476 - (g.halves[fav.id][0].pts - g.halves[dog.id][0].pts);
  if (sp >= 6 && short >= 6) return 0; if (sp >= 6 && short <= 0) return 1; if (sp >= 6) return 2; if (sp >= 3) return 3; return 4; };
const todo = Object.entries(H).filter(([id, r]) => r.status === 'ok' && r.oddsId && r.asked && r.books && r.books.draftkings && !store.games[id])
  .map(([id, r]) => ({ id, r, p: pri(id) })).filter(x => x.p < 9).sort((a, b) => a.p - b.p || (a.id < b.id ? -1 : 1));
console.log('to pull: ' + todo.length + ' (priority counts: ' + [0, 1, 2, 3, 4].map(p => todo.filter(x => x.p === p).length).join('/') + ')');
let n = 0, got = 0;
for (const { id, r, p } of todo) {
  const resp = await call('/v4/historical/sports/' + SPORT + '/events/' + r.oddsId + '/odds', { date: r.asked, regions: 'us', markets: 'spreads_h2', oddsFormat: 'american' }); n++;
  const rec = { p, snap: resp && resp.timestamp, books: {} };
  ((resp && resp.data && resp.data.bookmakers) || []).forEach(b => (b.markets || []).forEach(m => { if (m.key !== 'spreads_h2') return;
    rec.books[b.key] = m.outcomes.map(o => [o.name, o.point, o.price]).concat([[ 'updated', m.last_update ]]); }));
  if (Object.keys(rec.books).length) got++;
  store.games[id] = rec;
  if (n % 50 === 0) { save(); console.log('pulled ' + n + ' | with 2H spread ' + got + ' | credits left ' + left); }
  if (left != null && left < MIN_LEFT) { console.log('Stopping: credits left below ' + MIN_LEFT); break; }
}
store.log.push({ at: new Date().toISOString(), pulled: n, withSpread: got, creditsLeft: left }); save();
console.log('done: pulled ' + n + ', with 2H spread ' + got + ', credits left ' + left);
