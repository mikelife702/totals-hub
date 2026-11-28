// Pull second-chance, points-off-turnovers and fast-break points per team per half (from play-by-play),
// plus ESPN's box pointsInPaint / fastBreakPoints / turnoverPoints for the game.
// Saves data/<season>-chances.json: { fields, games: { id: { teamId: { h: [[pts, scp, potov, fbp, orebs], [..2nd half incl OT..]], box: [paint, fbp, tovpts] } } } }
// Run: node scripts/pull-chances.mjs ncaa2025
import fs from 'node:fs';
export function chances(s) {
  const ids = ((s.header && s.header.competitions && s.header.competitions[0].competitors) || []).map(c => c.id);
  const plays = s.plays || [];
  if (ids.length !== 2 || plays.length < 150) return null;
  const opp = x => (x === ids[0] ? ids[1] : ids[0]);
  const rec = {}; for (const id of ids) rec[id] = { h: [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]], box: [null, null, null] };
  for (const t of ((s.boxscore && s.boxscore.teams) || [])) { const id = t.team && t.team.id; if (!rec[id]) continue; const st = n => { const x = (t.statistics || []).find(y => y.name === n); return x ? +x.displayValue : null; }; rec[id].box = [st('pointsInPaint'), st('fastBreakPoints'), st('turnoverPoints')]; }
  const secOf = (per, clk) => { const [m, sec] = String(clk).split(':').map(Number); const left = m * 60 + (sec || 0); return per <= 2 ? (per - 1) * 1200 + (1200 - left) : 2400 + (per - 3) * 300 + (300 - left); };
  let cur = null; const last = {};
  const open = (team, t, type) => { cur = { team, start: t, type, oreb: false }; last[team] = cur; };
  for (const p of plays) {
    const per = p.period && p.period.number; if (!per || !p.clock) continue;
    const half = per === 1 ? 0 : 1;
    const t = secOf(per, p.clock.displayValue); const tt = (p.type && p.type.text) || ''; const team = p.team && p.team.id; const txt = (p.text || '').toLowerCase();
    if (tt === 'End Period' || tt === 'End Game') { cur = null; continue; }
    if (!team || !rec[team]) continue;
    const isFT = /FreeThrow/.test(tt) || txt.includes('free throw');
    if (p.scoringPlay) {
      const pts = +p.scoreValue || (isFT ? 1 : (txt.includes('three') ? 3 : 2));
      const poss = cur && cur.team === team ? cur : last[team];
      const r = rec[team].h[half]; r[0] += pts;
      if (poss) { if (poss.oreb) r[1] += pts; if (poss.type === 'to') r[2] += pts; if ((poss.type === 'to' || poss.type === 'dreb') && t - poss.start <= 8 && !poss.oreb) r[3] += pts; }
      if (isFT) { const m = txt.match(/(\d) of (\d)/); const lastFT = !m || m[1] === m[2]; if (lastFT && cur && cur.team === team) open(opp(team), t, 'make'); }
      else if (!cur || cur.team === team) open(opp(team), t, 'make');
      continue;
    }
    if (isFT) continue;
    if (p.shootingPlay) { if (!cur) open(team, t, 'start'); continue; }
    if (tt === 'Defensive Rebound' || tt === 'Dead Ball Rebound') { if (!cur || cur.team !== team) open(team, t, 'dreb'); continue; }
    if (tt === 'Offensive Rebound') { if (!cur || cur.team !== team) open(team, t, 'dreb'); else { cur.oreb = true; rec[team].h[half][4]++; } continue; }
    if (/Turnover/.test(tt) || txt.includes('turnover')) { if (!cur || cur.team === team) open(opp(team), t, 'to'); continue; }
  }
  return rec;
}
if (process.argv[1] && process.argv[1].endsWith('pull-chances.mjs')) {
  const season = process.argv[2] || 'ncaa2025';
  const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function getJSON(url, tries = 4) { for (let i = 0; i < tries; i++) { try { const r = await fetch(url, { headers: { 'User-Agent': 'totals-hub-chances/1.0' } }); if (r.ok) return await r.json(); if (r.status === 404) return null; } catch (e) { } await sleep(800 * (i + 1)); } return null; }
  async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { await fn(items[k]); } catch (e) { } } })); }
  const games = Object.values(JSON.parse(fs.readFileSync('data/' + season + '-games.json', 'utf8')).games);
  const outFile = 'data/' + season + '-chances.json';
  const out = fs.existsSync(outFile) && !process.env.FORCE ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { fields: ['pts', 'secondChance', 'offTurnovers', 'fastBreak', 'offRebounds'], box: ['pointsInPaint', 'fastBreakPoints', 'turnoverPoints'], games: {} };
  const todo = games.filter(g => !(g.id in out.games));
  console.log(season, 'games', games.length, 'to pull', todo.length);
  let done = 0;
  await pool(todo, 6, async g => {
    const s = await getJSON(BASE + g.id); if (!s) return;
    out.games[g.id] = chances(s);
    if (++done % 500 === 0) { fs.writeFileSync(outFile, JSON.stringify(out)); console.log('pulled', done); }
  });
  fs.writeFileSync(outFile, JSON.stringify(out));
  console.log('saved', Object.keys(out.games).length);
}
