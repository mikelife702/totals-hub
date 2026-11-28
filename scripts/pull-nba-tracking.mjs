// NBA shot tracking by closest-defender distance, per team per game per half (stats.nba.com leaguedashteamptshot,
// one call per date × distance × half; a team plays at most once a day, so date = game).
// Saves data/<season>-nbadef.json: { dates: { 'YYYY-MM-DD': { teamId: { '1H'|'2H': { vt|t|o|wo: [fga, fgm, fg3a, fg3m] } } } } }
// Run: node scripts/pull-nba-tracking.mjs nba2025   (TEST=1 → one date only, prints the reply)
import fs from 'node:fs';
const season = process.argv[2] || 'nba2025';
const yr = +season.slice(3); const SEASON = yr + '-' + String(yr + 1).slice(2);
const RANGES = { vt: '0-2 Feet - Very Tight', t: '2-4 Feet - Tight', o: '4-6 Feet - Open', wo: '6+ Feet - Wide Open' };
const SEGS = { '1H': 'First Half', '2H': 'Second Half' };
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Referer': 'https://www.nba.com/', 'Origin': 'https://www.nba.com', 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9', 'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(date, range, seg, tries = 3) {
  const [y, m, d] = date.split('-');
  const q = new URLSearchParams({ CloseDefDistRange: range, Conference: '', DateFrom: `${m}/${d}/${y}`, DateTo: `${m}/${d}/${y}`, Division: '', GameScope: '', GameSegment: seg, LastNGames: '0', LeagueID: '00', Location: '', Month: '0', OpponentTeamID: '0', Outcome: '', PORound: '0', PerMode: 'Totals', Period: '0', Season: SEASON, SeasonSegment: '', SeasonType: 'Regular Season', VsConference: '', VsDivision: '' });
  for (let i = 0; i < tries; i++) {
    try { const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 20000); const r = await fetch('https://stats.nba.com/stats/leaguedashteamptshot?' + q, { headers: H, signal: ac.signal }); clearTimeout(to); if (r.ok) return await r.json(); console.log('status', r.status); } catch (e) { console.log('err', e.name); }
    await sleep(3000 * (i + 1));
  }
  return null;
}
const games = Object.values(JSON.parse(fs.readFileSync('data/' + season + '-games.json', 'utf8')).games);
const etDay = iso => new Date(Date.parse(iso) - 5 * 3600e3).toISOString().slice(0, 10);
const dates = [...new Set(games.map(g => etDay(g.date)))].sort();
const outFile = 'data/' + season + '-nbadef.json';
const out = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { fields: ['fga', 'fgm', 'fg3a', 'fg3m'], dates: {} };
const todo = process.env.TEST ? dates.slice(80, 81) : dates.filter(d => !out.dates[d]);
console.log(season, SEASON, 'dates', dates.length, 'to pull', todo.length);
let fails = 0, n = 0;
for (const date of todo) {
  const rec = {}; let ok = true;
  for (const [sk, seg] of Object.entries(SEGS)) for (const [rk, range] of Object.entries(RANGES)) {
    const j = await get(date, range, seg); await sleep(700);
    if (!j) { ok = false; break; }
    const rs = j.resultSets && j.resultSets[0]; if (!rs) { ok = false; break; }
    if (process.env.TEST) console.log(JSON.stringify(rs.headers), JSON.stringify(rs.rowSet.slice(0, 2)));
    const ix = k => rs.headers.indexOf(k);
    for (const row of rs.rowSet) { const id = row[ix('TEAM_ID')]; const t = rec[id] = rec[id] || {}; const s = t[sk] = t[sk] || {}; s[rk] = [row[ix('FGA')], row[ix('FGM')], row[ix('FG3A')], row[ix('FG3M')]]; }
  }
  if (!ok) { if (++fails >= 3) { console.log('stopping: stats.nba.com not answering'); break; } continue; }
  fails = 0; out.dates[date] = rec;
  if (++n % 20 === 0) { fs.writeFileSync(outFile, JSON.stringify(out)); console.log('dates done', n); }
}
if (!process.env.TEST) fs.writeFileSync(outFile, JSON.stringify(out));
console.log('saved dates', Object.keys(out.dates).length);
