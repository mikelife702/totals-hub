// Pull referee crews (+ team fouls) for a past season's games from ESPN game summaries.
// Saves data/<season>-officials.json: { games: { id: { refs: [names], fouls: { teamId: [fouls1H, fouls2H, foulsGame] } } } }
// Run: node scripts/pull-officials.mjs ncaa2025
import fs from 'node:fs';
const season = process.argv[2] || 'ncaa2025';
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url, tries = 4) { for (let i = 0; i < tries; i++) { try { const r = await fetch(url, { headers: { 'User-Agent': 'totals-hub-refs/1.0' } }); if (r.ok) return await r.json(); if (r.status === 404) return null; } catch (e) { } await sleep(800 * (i + 1)); } return null; }
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { await fn(items[k]); } catch (e) { } } })); }
const games = Object.values(JSON.parse(fs.readFileSync('data/' + season + '-games.json', 'utf8')).games);
const outFile = 'data/' + season + '-officials.json';
const out = fs.existsSync(outFile) && !process.env.FORCE ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { games: {} };
const todo = games.filter(g => !out.games[g.id]);
console.log(season, 'games', games.length, 'to pull', todo.length);
let done = 0;
await pool(todo, 6, async g => {
  const s = await getJSON(BASE + g.id); if (!s) return;
  const refs = (((s.gameInfo || {}).officials) || []).map(o => (o.displayName || o.fullName || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const fouls = {};
  for (const t of ((s.boxscore && s.boxscore.teams) || [])) {
    const tid = t.team && t.team.id; if (!tid) continue;
    const f = (t.statistics || []).find(x => x.name === 'fouls' || x.name === 'totalFouls' || x.name === 'personalFouls');
    fouls[tid] = [0, 0, f ? +f.displayValue : null];
  }
  for (const pl of (s.plays || [])) {
    const per = pl.period && pl.period.number; if (per !== 1 && per !== 2) continue;
    const txt = (pl.text || '').toLowerCase(); if (!txt.includes('foul')) continue;
    const tid = pl.team && pl.team.id; if (!tid || !fouls[tid]) continue;
    fouls[tid][per - 1]++;
  }
  out.games[g.id] = { refs, fouls };
  if (++done % 500 === 0) { fs.writeFileSync(outFile, JSON.stringify(out)); console.log('pulled', done); }
});
fs.writeFileSync(outFile, JSON.stringify(out));
console.log('saved', Object.keys(out.games).length);
