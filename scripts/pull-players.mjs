// One-time pull: player minutes for teams that had 2026 NBA first-round picks (last season, 2025-26).
// Reads data/ncaa2025-games.json, fetches each game's ESPN summary, saves per-player box + per-half points/shots
// to data/ncaa2025-players.json.   Run: node scripts/pull-players.mjs
import fs from 'node:fs';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=';
const TEAMS = ['252', '2305', '150', '153', '356', '97', '8', '248', '130', '12', '2633', '264', '251', '2294', '24', '2641', '2541', '96', '333', '2599', '239', '41', '66'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { headers: { 'User-Agent': 'totals-hub-players/1.0' } }); if (r.ok) return await r.json(); if (r.status === 404) return null; } catch (e) { }
    await sleep(800 * (i + 1));
  }
  return null;
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { await fn(items[k]); } catch (e) { } } })); }

const games = Object.values(JSON.parse(fs.readFileSync('data/ncaa2025-games.json', 'utf8')).games).filter(g => g.teams.some(t => TEAMS.includes(t.id)));
const outFile = 'data/ncaa2025-players.json';
const out = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { games: {} };
const todo = games.filter(g => !out.games[g.id]);
console.log('games for prospect teams:', games.length, 'to pull:', todo.length);

await pool(todo, 6, async g => {
  const s = await getJSON(BASE + g.id);
  if (!s || !s.boxscore || !s.boxscore.players) return;
  const rec = { date: g.date, teams: {} };
  for (const tp of s.boxscore.players) {
    const tid = tp.team && tp.team.id; const st = tp.statistics && tp.statistics[0];
    if (!tid || !st) continue;
    const labels = st.labels || st.names || [];
    rec.teams[tid] = (st.athletes || []).map(a => {
      const v = {}; labels.forEach((l, i) => { v[l] = a.stats ? a.stats[i] : null; });
      return { id: a.athlete && a.athlete.id, name: a.athlete && a.athlete.displayName, starter: !!a.starter, dnp: !!a.didNotPlay, min: parseFloat(v.MIN) || 0, pts: parseFloat(v.PTS) || 0, fg: v.FG || null, pf: parseFloat(v.PF) || 0, h: [[0, 0], [0, 0]] };
    });
  }
  // per-half points and shot attempts per player from play-by-play (shooter = first participant)
  const idx = {}; for (const tid in rec.teams) rec.teams[tid].forEach(p => { if (p.id) idx[p.id] = p; });
  for (const pl of (s.plays || [])) {
    const per = pl.period && pl.period.number; if (per !== 1 && per !== 2) continue;
    const pid = pl.participants && pl.participants[0] && pl.participants[0].athlete && pl.participants[0].athlete.id;
    const p = pid && idx[pid]; if (!p) continue;
    if (pl.shootingPlay) { const txt = (pl.text || '').toLowerCase(); if (!txt.includes('free throw')) p.h[per - 1][1]++; if (pl.scoringPlay) p.h[per - 1][0] += pl.scoreValue || 0; }
  }
  out.games[g.id] = rec;
});
fs.writeFileSync(outFile, JSON.stringify(out));
console.log('saved', Object.keys(out.games).length, 'games');
