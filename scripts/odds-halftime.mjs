// Pull historical HALFTIME 2nd-half totals from The Odds API for a past college season and match them to ESPN games.
// Run: node scripts/odds-halftime.mjs ncaa2025 [START_DAY] [MAX_DAYS]
// Saves data/<season>-h2lines.json (resumable). Uses ~10 credits per game. Stops if credits left < MIN_LEFT.
import fs from 'node:fs';
const KEY = process.env.ODDS_API_KEY; if (!KEY) { console.log('No ODDS_API_KEY'); process.exit(1); }
const season = process.argv[2] || 'ncaa2025', START = process.argv[3] || null, MAX_DAYS = +(process.argv[4] || 999);
const MIN_LEFT = +(process.env.MIN_LEFT || 35000);
const HOST = 'https://api.the-odds-api.com', SPORT = 'basketball_ncaab';
const OUT = 'data/' + season + '-h2lines.json';
const games = Object.values(JSON.parse(fs.readFileSync('data/' + season + '-games.json', 'utf8')).games).filter(g => g.lines && g.lines.close);
let store = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
if (!store || store.v !== 2) store = { v: 2, games: {}, days: {}, log: [] }; // v2: snapshot timed from ESPN's end-of-1st-half clock
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=';
async function halftime(id) { // wall-clock end of 1st half and start of 2nd half from ESPN play-by-play
  for (let i = 0; i < 3; i++) { try { const r = await fetch(ESPN + id); if (!r.ok) return null; const s = await r.json(); const P = s.plays || [];
    const end1 = P.filter(p => p.period && p.period.number === 1 && p.wallclock).pop(), st2 = P.find(p => p.period && p.period.number === 2 && p.wallclock);
    return end1 ? { end1: Date.parse(end1.wallclock), start2: st2 ? Date.parse(st2.wallclock) : null } : null; } catch (e) { await new Promise(s => setTimeout(s, 1000)); } }
  return null;
}
let left = null;
async function call(path, params) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(HOST + path + '?' + new URLSearchParams({ ...params, apiKey: KEY }).toString());
      left = +r.headers.get('x-requests-remaining');
      if (r.status === 429) { await new Promise(s => setTimeout(s, 2000 * (i + 1))); continue; }
      if (!r.ok) return null; return await r.json();
    } catch (e) { await new Promise(s => setTimeout(s, 1500 * (i + 1))); }
  }
  return null;
}
// ---- name matching ----
const ALIAS = { 'st': 'state', 'saint': 'st.', 'univ': '', 'university': '', 'the': '', 'of': '', 'and': '', 'college': '' };
const norm = s => (s || '').toLowerCase().replace(/&/g, ' and ').replace(/[().,'’-]/g, ' ').split(/\s+/).filter(Boolean).map(w => w === 'st' ? 'state' : w).filter(w => !['university', 'univ', 'the', 'of', 'at'].includes(w));
const sim = (a, b) => { const A = new Set(norm(a)), B = new Set(norm(b)); let n = 0; A.forEach(w => { if (B.has(w)) n++; }); return n / Math.max(1, Math.min(A.size, B.size)); };
const mascot = s => norm(s).slice(-1)[0];
function matchEvent(g, events) {
  const home = g.teams.find(t => t.home) || g.teams[0], away = g.teams.find(t => t !== home);
  let best = null;
  for (const e of events) {
    const dt = Math.abs(Date.parse(e.commence_time) - Date.parse(g.date)) / 60e3; if (dt > 180) continue;
    const s1 = sim(home.name, e.home_team) + sim(away.name, e.away_team), s2 = sim(home.name, e.away_team) + sim(away.name, e.home_team);
    let s = Math.max(s1, s2); if (mascot(home.name) === mascot(e.home_team) || mascot(home.name) === mascot(e.away_team)) s += 0.25; s -= dt / 600;
    if (!best || s > best.s) best = { e, s };
  }
  return best && best.s >= 1.1 ? best.e : null;
}
const etDay = iso => new Date(Date.parse(iso) - 5 * 3600e3).toISOString().slice(0, 10);
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const byDay = {}; games.forEach(g => (byDay[etDay(g.date)] = byDay[etDay(g.date)] || []).push(g));
const days = Object.keys(byDay).sort().filter(d => !START || d >= START).slice(0, MAX_DAYS);
const save = () => fs.writeFileSync(OUT, JSON.stringify(store));
let calls = 0, matched = 0, withH2 = 0, unmatched = 0;
for (const day of days) {
  const todo = byDay[day].filter(g => !store.games[g.id]); if (!todo.length) continue;
  // events list as of 10am ET that day (games not yet started), plus 6pm ET to catch late additions
  const evs = {};
  for (const t of ['T15:00:00Z', 'T23:00:00Z']) { const r = await call('/v4/historical/sports/' + SPORT + '/events', { date: day + t }); calls++; ((r && r.data) || []).forEach(e => { evs[e.id] = e; }); }
  const events = Object.values(evs);
  for (const g of todo) {
    const e = matchEvent(g, events);
    if (!e) { store.games[g.id] = { status: 'no match' }; unmatched++; continue; }
    matched++;
    const ht = await halftime(g.id);
    if (!ht) { store.games[g.id] = { status: 'no halftime clock', oddsId: e.id }; continue; }
    const snapAt = Math.min(ht.end1 + 8 * 60e3, ht.start2 ? ht.start2 - 60e3 : Infinity);
    let r = await call('/v4/historical/sports/' + SPORT + '/events/' + e.id + '/odds', { date: iso(snapAt), regions: 'us', markets: 'totals_h2', oddsFormat: 'american' }); calls++;
    const rec = { status: 'ok', oddsId: e.id, home: e.home_team, away: e.away_team, commence: e.commence_time, end1: new Date(ht.end1).toISOString(), start2: ht.start2 ? new Date(ht.start2).toISOString() : null, asked: iso(snapAt), snap: r && r.timestamp, books: {} };
    const take = (resp, key) => ((resp && resp.data && resp.data.bookmakers) || []).forEach(b => (b.markets || []).forEach(m => { if (m.key !== key) return;
      const o = m.outcomes.find(x => x.name === 'Over'), u = m.outcomes.find(x => x.name === 'Under'); if (!o || !u) return;
      (rec.books[b.key] = rec.books[b.key] || {})[key] = [o.point, o.price, u.price, m.last_update]; }));
    take(r, 'totals_h2');
    if (!Object.keys(rec.books).length) { // no 2nd-half market: fall back to the live full-game total (line minus halftime score = implied 2nd half)
      r = await call('/v4/historical/sports/' + SPORT + '/events/' + e.id + '/odds', { date: iso(snapAt), regions: 'us', markets: 'totals', oddsFormat: 'american' }); calls++;
      take(r, 'totals'); rec.fallback = true;
    } else withH2++;
    store.games[g.id] = rec;
    if (left != null && left < MIN_LEFT) break;
  }
  store.days[day] = true; save();
  console.log(day + ' | games ' + byDay[day].length + ' | matched so far ' + matched + ' (2nd-half line ' + withH2 + ') | unmatched ' + unmatched + ' | credits left ' + left);
  if (left != null && left < MIN_LEFT) { console.log('Stopping: credits left below ' + MIN_LEFT); break; }
}
store.log.push({ at: new Date().toISOString(), days: days.length, matched, withH2, unmatched, creditsLeft: left }); save();
console.log('done: matched ' + matched + ', with 2nd-half line ' + withH2 + ', unmatched ' + unmatched + ', credits left ' + left);
