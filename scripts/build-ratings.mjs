// Nightly ratings builder for the Live Totals Hub.
// Pulls every completed game from ESPN, keeps a compact box score per game in data/<league>-games.json,
// and writes opponent-adjusted, recency-weighted team ratings to data/<league>-ratings.json.
// Run: node scripts/build-ratings.mjs [ncaa|nba ...]   (no args = both)
import fs from 'node:fs';
import path from 'node:path';

const LEAGUES = {
  ncaa: { path: 'basketball/mens-college-basketball', extra: '&groups=50&limit=400', start: '2026-10-28', mins: 40, ot: 5, ftc: 0.475, periods: 2, d1Only: true },
  nba:  { path: 'basketball/nba', extra: '', start: '2026-10-18', mins: 48, ot: 5, ftc: 0.44, periods: 4, d1Only: false },
};
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/';
const HALF_LIFE_DAYS = 30;   // a game this many days old counts half as much as today's
const HCA = 0.014;           // home-court effect on efficiency, each way
const PRIOR_GAMES = 2;       // early-season shrinkage toward league average (efficiency, tempo)
const PRIOR_GAMES_PCT = 5;   // stronger shrinkage for shooting percentages
const ITER = 40;
const DATA = path.resolve('data');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'totals-hub-ratings/1.0' } });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch (e) { /* retry */ }
    await sleep(800 * (i + 1));
  }
  throw new Error('fetch failed: ' + url);
}
async function pool(items, n, fn) {
  let i = 0; const out = [];
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = null; } }
  }));
  return out;
}
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const num = v => (v == null ? 0 : parseFloat(v) || 0);
function pair(v) { if (!v) return [0, 0]; const p = String(v).split('-'); return [+p[0] || 0, +p[1] || 0]; }
function stat(stats, names) { for (const n of names) { const s = stats.find(x => x.name === n); if (s && s.displayValue !== undefined && s.displayValue !== '') return s.displayValue; } return null; }

function compactGame(sum, cfg) {
  const comp = sum.header && sum.header.competitions && sum.header.competitions[0];
  if (!comp || !(comp.status && comp.status.type && comp.status.type.completed)) return null;
  const box = {};
  ((sum.boxscore && sum.boxscore.teams) || []).forEach(t => {
    const s = t.statistics || [];
    const fg = pair(stat(s, ['fieldGoalsMade-fieldGoalsAttempted']));
    const tp = pair(stat(s, ['threePointFieldGoalsMade-threePointFieldGoalsAttempted']));
    const ft = pair(stat(s, ['freeThrowsMade-freeThrowsAttempted']));
    box[String(t.team.id)] = { fgm: fg[0], fga: fg[1], tpm: tp[0], tpa: tp[1], ftm: ft[0], fta: ft[1],
      orb: num(stat(s, ['offensiveRebounds'])), drb: num(stat(s, ['defensiveRebounds'])), tov: num(stat(s, ['totalTurnovers', 'turnovers'])) };
  });
  const teams = comp.competitors.map(c => {
    const id = String(c.id || c.team.id);
    const b = box[id];
    return b ? { id, name: c.team.shortDisplayName || c.team.displayName, abbr: c.team.abbreviation, conf: c.team.conferenceId || null,
      home: c.homeAway === 'home', pts: num(c.score), ...b } : null;
  });
  if (teams.length !== 2 || teams.some(t => !t || !t.fga)) return null;
  const per = (comp.status && comp.status.period) || cfg.periods;
  return { id: String(sum.header.id), date: comp.date, neutral: !!comp.neutralSite, confGame: !!comp.conferenceCompetition,
    mins: cfg.mins + Math.max(0, per - cfg.periods) * cfg.ot, teams };
}

async function updateGames(lg, cfg) {
  const file = path.join(DATA, lg + '-games.json');
  const store = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { games: {} };
  const today = new Date();
  const ids = [];
  const meta = {}, confTeams = {};
  for (let d = new Date(cfg.start + 'T12:00:00Z'); d < today; d.setUTCDate(d.getUTCDate() + 1)) {
    const sb = await getJSON(BASE + cfg.path + '/scoreboard?dates=' + ymd(d) + cfg.extra);
    for (const e of (sb && sb.events) || []) {
      const st = e.status && e.status.type;
      if (!(st && st.completed)) continue;
      const c = e.competitions && e.competitions[0];
      if (c) {
        meta[String(e.id)] = { neutral: !!c.neutralSite, confGame: !!c.conferenceCompetition };
        (c.competitors || []).forEach(t => { if (t.team && t.team.conferenceId) confTeams[String(t.team.id)] = t.team.conferenceId; });
      }
      if (!store.games[e.id]) ids.push(String(e.id));
    }
  }
  console.log(lg + ': ' + Object.keys(store.games).length + ' cached games, ' + ids.length + ' new to fetch');
  const recs = await pool(ids, 6, async id => compactGame(await getJSON(BASE + cfg.path + '/summary?event=' + id), cfg));
  let added = 0;
  recs.forEach(r => { if (r) { store.games[r.id] = r; added++; } });
  // scoreboard carries conference and neutral-site info that game summaries lack
  for (const g of Object.values(store.games)) {
    const m = meta[g.id];
    if (m) { g.neutral = m.neutral; g.confGame = m.confGame; }
    g.teams.forEach(t => { if (confTeams[t.id]) t.conf = confTeams[t.id]; });
  }
  store.updated = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(store));
  console.log(lg + ': added ' + added + ', total ' + Object.keys(store.games).length);
  return store;
}

// ---------- ratings math ----------
export function computeRatings(games, cfg, now = new Date()) {
  const poss = t => t.fga - t.orb + cfg.ftc * t.fta + t.tov;
  const rows = []; // one row per team-game
  const teams = {};
  for (const g of games) {
    const [a, b] = g.teams;
    const pa = poss(a), pb = poss(b), gp = (pa + pb) / 2;
    if (gp < 30) continue;
    const age = Math.max(0, (now - new Date(g.date)) / 86400000);
    const w = Math.pow(0.5, age / HALF_LIFE_DAYS);
    const tempo = gp * cfg.mins / g.mins;
    for (const [me, op] of [[a, b], [b, a]]) {
      const isD1 = !cfg.d1Only || !!me.conf;
      if (!teams[me.id]) teams[me.id] = { id: me.id, name: me.name, abbr: me.abbr, conf: me.conf, d1: isD1, games: 0 };
      teams[me.id].games++;
      const loc = g.neutral ? 0 : (me.home ? 1 : -1);
      rows.push({ team: me.id, opp: op.id, w, loc, conf: g.confGame, date: g.date,
        o: me.pts / gp, d: op.pts / gp, tempo,
        // four-factor style stats, offense (o_*) and what the opponent did (d_*)
        o_tpar: me.fga ? me.tpa / me.fga : 0, d_tpar: op.fga ? op.tpa / op.fga : 0,
        o_tp: me.tpa ? me.tpm / me.tpa : null, d_tp: op.tpa ? op.tpm / op.tpa : null, o_tpa: me.tpa, d_tpa: op.tpa,
        o_p2: (me.fga - me.tpa) ? (me.fgm - me.tpm) / (me.fga - me.tpa) : null, d_p2: (op.fga - op.tpa) ? (op.fgm - op.tpm) / (op.fga - op.tpa) : null,
        o_tov: me.tov / pa, d_tov: op.tov / pb,
        o_orb: (me.orb + op.drb) ? me.orb / (me.orb + op.drb) : 0, d_orb: (op.orb + me.drb) ? op.orb / (op.orb + me.drb) : 0,
        o_ftr: me.fga ? me.fta / me.fga : 0, d_ftr: op.fga ? op.fta / op.fga : 0,
        ftp: me.fta ? me.ftm / me.fta : null, ftaN: me.fta,
      });
    }
  }
  const wavg = (rs, f) => { let s = 0, ws = 0; for (const r of rs) { const v = f(r); if (v == null || isNaN(v)) continue; s += r.w * v; ws += r.w; } return ws ? s / ws : null; };
  const lg = { eff: wavg(rows, r => r.o), tempo: wavg(rows, r => r.tempo) };
  const FACT = ['tpar', 'tp', 'p2', 'tov', 'orb', 'ftr'];
  FACT.forEach(k => { lg[k] = wavg(rows, r => r['o_' + k]); });
  lg.ftp = wavg(rows, r => r.ftp);

  const byTeam = {};
  rows.forEach(r => { (byTeam[r.team] = byTeam[r.team] || []).push(r); });
  const ids = Object.keys(teams);
  // non-D1 opponents (college) get a fixed weak rating instead of being solved
  const fixed = id => !teams[id].d1;
  const R = {};
  ids.forEach(id => {
    R[id] = fixed(id)
      ? { o: lg.eff * 0.86, d: lg.eff * 1.14, t: lg.tempo }
      : { o: lg.eff, d: lg.eff, t: lg.tempo };
    FACT.forEach(k => { R[id]['o_' + k] = lg[k]; R[id]['d_' + k] = lg[k]; });
  });
  const shrink = (s, ws, prior, k) => (s + k * prior) / (ws + k);
  for (let it = 0; it < ITER; it++) {
    const N = {};
    for (const id of ids) {
      if (fixed(id)) { N[id] = R[id]; continue; }
      let so = 0, sd = 0, st = 0, ws = 0;
      const f = {};
      FACT.forEach(k => { f[k] = { so: 0, sd: 0, wo: 0, wd: 0 }; });
      for (const r of byTeam[id]) {
        const op = R[r.opp];
        const homeO = r.loc === 1 ? 1 + HCA : r.loc === -1 ? 1 - HCA : 1;   // my offense helped at home
        const homeD = r.loc === 1 ? 1 - HCA : r.loc === -1 ? 1 + HCA : 1;   // opponent's offense hurt when I'm home
        so += r.w * (r.o / homeO) * lg.eff / op.d;
        sd += r.w * (r.d / homeD) * lg.eff / op.o;
        st += r.w * r.tempo * lg.tempo / op.t;
        ws += r.w;
        for (const k of FACT) {
          const vo = r['o_' + k], vd = r['d_' + k];
          const wo = (k === 'tp') ? r.w * Math.min(1, r.o_tpa / 20) : r.w;  // weight 3P% by attempts
          const wd = (k === 'tp') ? r.w * Math.min(1, r.d_tpa / 20) : r.w;
          if (vo != null && op['d_' + k]) { f[k].so += wo * vo * lg[k] / op['d_' + k]; f[k].wo += wo; }
          if (vd != null && op['o_' + k]) { f[k].sd += wd * vd * lg[k] / op['o_' + k]; f[k].wd += wd; }
        }
      }
      const n = { o: shrink(so, ws, lg.eff, PRIOR_GAMES), d: shrink(sd, ws, lg.eff, PRIOR_GAMES), t: shrink(st, ws, lg.tempo, PRIOR_GAMES) };
      for (const k of FACT) {
        const kk = (k === 'tp' || k === 'p2') ? PRIOR_GAMES_PCT : PRIOR_GAMES;
        n['o_' + k] = shrink(f[k].so, f[k].wo, lg[k], kk);
        n['d_' + k] = shrink(f[k].sd, f[k].wd, lg[k], kk);
      }
      N[id] = n;
    }
    // keep the scale anchored to the league average
    const d1 = ids.filter(id => !fixed(id));
    const mo = d1.reduce((s, id) => s + N[id].o, 0) / d1.length, md = d1.reduce((s, id) => s + N[id].d, 0) / d1.length;
    const mt = d1.reduce((s, id) => s + N[id].t, 0) / d1.length;
    d1.forEach(id => { N[id].o *= lg.eff / mo; N[id].d *= lg.eff / md; N[id].t *= lg.tempo / mt; });
    Object.assign(R, N);
  }
  // ranks and splits
  const d1 = ids.filter(id => !fixed(id));
  d1.sort((x, y) => (R[y].o - R[y].d) - (R[x].o - R[x].d));
  const rank = {}; d1.forEach((id, i) => { rank[id] = i + 1; });
  const out = {};
  for (const id of d1) {
    const rs = byTeam[id];
    const split = pick => {
      const sel = rs.filter(pick); if (!sel.length) return null;
      const o = wavg(sel, r => r.o * lg.eff / R[r.opp].d), d = wavg(sel, r => r.d * lg.eff / R[r.opp].o);
      return { g: sel.length, o: +o.toFixed(4), d: +d.toFixed(4) };
    };
    const t = R[id];
    out[id] = {
      name: teams[id].name, abbr: teams[id].abbr, conf: teams[id].conf, games: teams[id].games, rank: rank[id],
      o: +t.o.toFixed(4), d: +t.d.toFixed(4), em: +((t.o - t.d) * 100).toFixed(2), t: +t.t.toFixed(2),
      f: Object.fromEntries(FACT.flatMap(k => [['o_' + k, +t['o_' + k].toFixed(4)], ['d_' + k, +t['d_' + k].toFixed(4)]])),
      ftp: +(shrink(rs.reduce((s, r) => s + (r.ftp != null ? r.w * r.ftp * Math.min(1, r.ftaN / 15) : 0), 0), rs.reduce((s, r) => s + (r.ftp != null ? r.w * Math.min(1, r.ftaN / 15) : 0), 0), lg.ftp, PRIOR_GAMES_PCT)).toFixed(4),
      splits: { conf: split(r => r.conf), nonconf: split(r => !r.conf), top50: split(r => rank[r.opp] && rank[r.opp] <= 50), rest: split(r => !(rank[r.opp] && rank[r.opp] <= 50)) },
      last5: split(r => rs.slice().sort((x, y) => new Date(y.date) - new Date(x.date)).slice(0, 5).includes(r)),
    };
  }
  return { updated: now.toISOString(), games: games.length, teams: d1.length,
    settings: { halfLifeDays: HALF_LIFE_DAYS, hca: HCA, priorGames: PRIOR_GAMES, priorGamesPct: PRIOR_GAMES_PCT },
    lg: Object.fromEntries(Object.entries(lg).map(([k, v]) => [k, +v.toFixed(4)])), ratings: out };
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const which = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(LEAGUES);
  for (const lg of which) {
    const cfg = LEAGUES[lg];
    const store = await updateGames(lg, cfg);
    const res = computeRatings(Object.values(store.games), cfg);
    fs.writeFileSync(path.join(DATA, lg + '-ratings.json'), JSON.stringify(res));
    const top = Object.values(res.ratings).sort((a, b) => a.rank - b.rank).slice(0, 10)
      .map(t => t.rank + '. ' + t.name + ' ' + (t.em > 0 ? '+' : '') + t.em + ' (O ' + (t.o * 100).toFixed(1) + ' / D ' + (t.d * 100).toFixed(1) + ' / T ' + t.t + ')');
    console.log(lg + ': ' + res.teams + ' teams rated from ' + res.games + ' games. League ' + (res.lg.eff * 100).toFixed(1) + ' pts/100, tempo ' + res.lg.tempo);
    console.log(top.join('\n'));
  }
}
if (import.meta.url === 'file://' + process.argv[1]) main().catch(e => { console.error(e); process.exit(1); });
