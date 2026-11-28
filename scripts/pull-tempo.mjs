// Pull possession timing (tempo) from ESPN play-by-play game clocks for a past season's games.
// Saves data/<season>-tempo.json: { games: { id: { teamId: [ ...see FIELDS ] } } }  (offense side; defense = opponent's row)
// Run: node scripts/pull-tempo.mjs ncaa2025
import fs from 'node:fs';
export const FIELDS = ['poss', 'secs', 'possL4', 'secsL4', 'possMake', 'secsMake', 'possDreb', 'secsDreb', 'possTO', 'secsTO', 'fga', 'early10', 'late22', 'transFGA'];
export function tempo(s) {
  const ids = ((s.header && s.header.competitions && s.header.competitions[0].competitors) || []).map(c => c.id);
  const plays = s.plays || [];
  if (ids.length !== 2 || plays.length < 150) return null;
  const opp = x => (x === ids[0] ? ids[1] : ids[0]);
  const rec = {}; for (const id of ids) rec[id] = FIELDS.map(() => 0);
  const secOf = (per, clk) => { const [m, sec] = String(clk).split(':').map(Number); const left = m * 60 + (sec || 0); return per <= 2 ? (per - 1) * 1200 + (1200 - left) : 2400 + (per - 3) * 300 + (300 - left); };
  let owner = null, start = 0, type = 'start', shotStart = 0;
  const close = (t) => {
    if (!owner) return; const d = Math.min(45, Math.max(0, t - start)); const r = rec[owner];
    if (start >= 2160) { r[2]++; r[3] += d; } else { r[0]++; r[1] += d; }
    if (type === 'make') { r[4]++; r[5] += d; } else if (type === 'dreb') { r[6]++; r[7] += d; } else if (type === 'to') { r[8]++; r[9] += d; }
  };
  const open = (team, t, ty) => { owner = team; start = t; shotStart = t; type = ty; };
  for (const p of plays) {
    const per = p.period && p.period.number; if (!per || !p.clock) continue;
    const t = secOf(per, p.clock.displayValue); const tt = (p.type && p.type.text) || ''; const team = p.team && p.team.id; const txt = (p.text || '').toLowerCase();
    if (tt === 'End Period' || tt === 'End Game') { close(t); owner = null; continue; }
    if (!owner && !team) { start = t; shotStart = t; type = 'start'; continue; }
    if (!team || !rec[team]) continue;
    if (/FreeThrow/.test(tt) || txt.includes('free throw')) {
      const m = txt.match(/(\d) of (\d)/); const last = !m || m[1] === m[2];
      if (last && p.scoringPlay && owner === team) { close(t); open(opp(team), t, 'make'); }
      continue;
    }
    if (p.shootingPlay) {
      if (!owner) open(team, start, type);
      if (owner === team && start < 2160) { const r = rec[team]; const sc = t - shotStart; r[10]++; if (sc <= 10) r[11]++; if (sc >= 22) r[12]++; if ((type === 'dreb' || type === 'to') && shotStart === start && t - start <= 8) r[13]++; }
      if (p.scoringPlay && owner === team) { close(t); open(opp(team), t, 'make'); }
      continue;
    }
    if (tt === 'Defensive Rebound' || tt === 'Dead Ball Rebound') { if (owner !== team) { close(t); open(team, t, 'dreb'); } else shotStart = t; continue; }
    if (tt === 'Offensive Rebound') { if (owner !== team) { close(t); open(team, t, 'dreb'); } shotStart = t; continue; }
    if (/Turnover/.test(tt) || txt.includes('turnover')) { if (!owner || owner === team) { close(t); open(opp(team), t, 'to'); } continue; }
  }
  for (const id of ids) rec[id][1] = Math.round(rec[id][1]), rec[id][3] = Math.round(rec[id][3]);
  return rec;
}
if (process.argv[1] && process.argv[1].endsWith('pull-tempo.mjs')) {
  const season = process.argv[2] || 'ncaa2025';
  const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function getJSON(url, tries = 4) { for (let i = 0; i < tries; i++) { try { const r = await fetch(url, { headers: { 'User-Agent': 'totals-hub-tempo/1.0' } }); if (r.ok) return await r.json(); if (r.status === 404) return null; } catch (e) { } await sleep(800 * (i + 1)); } return null; }
  async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { await fn(items[k]); } catch (e) { } } })); }
  const games = Object.values(JSON.parse(fs.readFileSync('data/' + season + '-games.json', 'utf8')).games);
  const outFile = 'data/' + season + '-tempo.json';
  const out = fs.existsSync(outFile) && !process.env.FORCE ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { fields: FIELDS, games: {} };
  const todo = games.filter(g => !(g.id in out.games));
  console.log(season, 'games', games.length, 'to pull', todo.length);
  let done = 0;
  await pool(todo, 6, async g => {
    const s = await getJSON(BASE + g.id); if (!s) return;
    out.games[g.id] = tempo(s);
    if (++done % 500 === 0) { fs.writeFileSync(outFile, JSON.stringify(out)); console.log('pulled', done); }
  });
  fs.writeFileSync(outFile, JSON.stringify(out));
  console.log('saved', Object.keys(out.games).length);
}
