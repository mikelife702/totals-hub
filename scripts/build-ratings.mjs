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

function parseLines(sum) {
  const pc = (sum.pickcenter || []).find(p => p.total) || (sum.pickcenter || [])[0];
  if (!pc) return { close: null, open: null };
  const ln = v => { const n = parseFloat(String(v || '').replace(/^[ou]/i, '')); return isNaN(n) ? null : n; };
  const t = pc.total || {}, o = t.over || {};
  return { book: (pc.provider && pc.provider.name) || null, open: ln(o.open && o.open.line), close: ln(o.close && o.close.line) || (pc.overUnder ? +pc.overUnder : null), spread: pc.spread != null ? +pc.spread : null };
}

// 1st- and 2nd-half team stats from play-by-play (regulation only; NBA halves = Q1-2 / Q3-4)
function parseHalves(sum, cfg) {
  const plays = sum.plays || [];
  if (!plays.length) return null;
  const half = per => cfg.periods === 2 ? (per === 1 ? 0 : per === 2 ? 1 : -1) : (per <= 2 ? 0 : per <= 4 ? 1 : -1);
  const blank = () => ({ pts: 0, tpa: 0, tpm: 0, a2: 0, m2: 0, fta: 0, ftm: 0, orb: 0, tov: 0 });
  const out = {};
  for (const x of plays) {
    const h = half(x.period && x.period.number);
    if (h < 0 || !x.team) continue;
    const id = String(x.team.id), t = (x.type && x.type.text) || '';
    const r = (out[id] = out[id] || [blank(), blank()])[h];
    if (x.shootingPlay) {
      const pa = x.pointsAttempted;
      if (pa === 3) { r.tpa++; if (x.scoringPlay) { r.tpm++; r.pts += 3; } }
      else if (pa === 2) { r.a2++; if (x.scoringPlay) { r.m2++; r.pts += 2; } }
      else if (pa === 1) { r.fta++; if (x.scoringPlay) { r.ftm++; r.pts += 1; } }
    } else if (t === 'Offensive Rebound') r.orb++;
    else if (/Turnover/i.test(t)) r.tov++;
  }
  return Object.keys(out).length === 2 ? out : null;
}

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
    mins: cfg.mins + Math.max(0, per - cfg.periods) * cfg.ot, teams, lines: parseLines(sum), halves: parseHalves(sum, cfg) };
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
      if (!store.games[e.id] || !store.games[e.id].lines || !('halves' in store.games[e.id])) ids.push(String(e.id));
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

// ---------- season replay (walk-forward) ----------
// For each day, rate teams using only games played before that day, predict each game's total,
// and compare with the DraftKings closing line and the final score.
export function backtest(games, cfg) {
  const etDay = iso => new Date(new Date(iso).getTime() - 5 * 3600000).toISOString().slice(0, 10);
  const byDay = {};
  games.forEach(g => { (byDay[etDay(g.date)] = byDay[etDay(g.date)] || []).push(g); });
  const days = Object.keys(byDay).sort();
  const rows = [];
  for (const day of days) {
    const todays = byDay[day].filter(g => g.lines && g.lines.close);
    if (!todays.length) continue;
    const train = games.filter(g => etDay(g.date) < day);
    if (train.length < 50) continue;
    const R = computeRatings(train, cfg, new Date(day + 'T12:00:00Z'));
    for (const g of todays) {
      const [a, b] = g.teams, ra = R.ratings[a.id], rb = R.ratings[b.id];
      if (!ra || !rb || ra.games < 3 || rb.games < 3) continue;
      const hf = t => g.neutral ? 1 : (t.home ? 1 + HCA : 1 - HCA);
      const pace = ra.t * rb.t / R.lg.tempo;
      const pred = pace * (ra.o * rb.d / R.lg.eff * hf(a) + rb.o * ra.d / R.lg.eff * hf(b)) * g.mins / cfg.mins;
      const final = a.pts + b.pts, close = g.lines.close, open = g.lines.open;
      const side = pred > close ? 'over' : 'under';
      const result = final > close ? 'over' : final < close ? 'under' : 'push';
      const form = r => r.last5 ? ((r.last5.o - r.last5.d) - (r.o - r.d)) * 100 : 0;
      const feat = {
        pace: +pace.toFixed(1), paceVsLg: +(pace - R.lg.tempo).toFixed(1),
        offense: +(100 * ((ra.o + rb.o) / 2 / R.lg.eff - 1)).toFixed(1), defense: +(100 * ((ra.d + rb.d) / 2 / R.lg.eff - 1)).toFixed(1),
        form: +((form(ra) + form(rb)) / 2).toFixed(1), spread: g.lines.spread != null ? Math.abs(g.lines.spread) : null,
        line: close, minGames: Math.min(ra.games, rb.games), seasonDay: Math.round((new Date(day) - new Date(days[0])) / 864e5),
        conf: g.confGame ? 1 : 0, neutral: g.neutral ? 1 : 0,
      };
      rows.push({ id: g.id, day, game: a.abbr + ' v ' + b.abbr, pred: +pred.toFixed(1), open, close, final, diff: +(pred - close).toFixed(1), feat,
        side, result, win: result === 'push' ? null : side === result,
        moved: open != null && close !== open ? (Math.sign(close - open) === Math.sign(pred - open) ? 'toward' : 'away') : 'none' });
    }
  }
  const buckets = [[0, 1.5], [1.5, 3], [3, 5], [5, 8], [8, 99]];
  const summarize = rs => {
    const w = rs.filter(r => r.win === true).length, l = rs.filter(r => r.win === false).length, p = rs.filter(r => r.win === null).length;
    return { n: rs.length, w, l, p, pct: w + l ? +(100 * w / (w + l)).toFixed(1) : null, roi: w + l ? +(100 * (w * 100 / 110 - l) / (w + l)).toFixed(1) : null };
  };
  const mae = (rs, f) => rs.length ? +(rs.reduce((s, r) => s + Math.abs(r.final - f(r)), 0) / rs.length).toFixed(2) : null;
  const bias = (rs, f) => rs.length ? +(rs.reduce((s, r) => s + (r.final - f(r)), 0) / rs.length).toFixed(2) : null;
  const mv = rs => { const m = rs.filter(r => r.moved !== 'none'); const t = m.filter(r => r.moved === 'toward').length; return { n: rs.length, moved: m.length, toward: t, away: m.length - t, pctToward: m.length ? +(100 * t / m.length).toFixed(1) : null }; };
  // Where is the edge? For each ingredient, split games into thirds and show
  // (a) how Vegas missed (final minus close: + means games went over the line) and
  // (b) how our picks did. A third where Vegas misses one way consistently is a lead worth chasing.
  const avg = (rs, f) => rs.length ? +(rs.reduce((s, r) => s + f(r), 0) / rs.length).toFixed(2) : null;
  const factors = {};
  Object.keys((rows[0] && rows[0].feat) || {}).forEach(k => {
    const rs = rows.filter(r => r.feat[k] != null).sort((x, y) => x.feat[k] - y.feat[k]);
    if (rs.length < 30) return;
    const binary = rs.every(r => r.feat[k] === 0 || r.feat[k] === 1);
    const groups = binary ? [['no', rs.filter(r => r.feat[k] === 0)], ['yes', rs.filter(r => r.feat[k] === 1)]]
      : [['low', rs.slice(0, Math.floor(rs.length / 3))], ['mid', rs.slice(Math.floor(rs.length / 3), Math.floor(2 * rs.length / 3))], ['high', rs.slice(Math.floor(2 * rs.length / 3))]];
    factors[k] = groups.map(([label, g]) => ({ label, n: g.length, from: g.length ? g[0].feat[k] : null, to: g.length ? g[g.length - 1].feat[k] : null,
      vegasMiss: avg(g, r => r.final - r.close), ourMiss: avg(g, r => r.final - r.pred), overPct: +(100 * g.filter(r => r.final > r.close).length / Math.max(1, g.filter(r => r.final !== r.close).length)).toFixed(1),
      picks: summarize(g.filter(r => Math.abs(r.diff) >= 3)) }));
  });
  return {
    updated: new Date().toISOString(), games: rows.length, factors, days: [...new Set(rows.map(r => r.day))].length,
    accuracy: { maeVegas: mae(rows, r => r.close), maeOurs: mae(rows, r => r.pred), biasVegas: bias(rows, r => r.close), biasOurs: bias(rows, r => r.pred) },
    all: summarize(rows),
    buckets: buckets.map(([lo, hi]) => ({ range: lo + (hi < 99 ? '–' + hi : '+'), ...summarize(rows.filter(r => Math.abs(r.diff) >= lo && Math.abs(r.diff) < hi)) })),
    bySide: { over: summarize(rows.filter(r => r.side === 'over' && Math.abs(r.diff) >= 3)), under: summarize(rows.filter(r => r.side === 'under' && Math.abs(r.diff) >= 3)) },
    lineMove: { all: mv(rows), gap2: mv(rows.filter(r => r.open != null && Math.abs(r.pred - r.open) >= 2)), gap4: mv(rows.filter(r => r.open != null && Math.abs(r.pred - r.open) >= 4)) },
    rows: rows.slice(-400),
  };
}

// ---------- four competing halftime models ----------
// Each projects the 2nd half at halftime from the 1st half, differing only in how much of each 1st-half signal carries over.
//   pace: share of the 1st-half pace gap that carries   k3/k2: share of the 3P%/2P% gap given BACK (negative = it carries)
//   v3: share of extra three volume kept   tov/orb: share of the turnover / off.-rebound gap that carries   margin: close/blowout effect
export const HT_MODELS = {
  ncaa: {
    A: { name: 'Catch-up', pace: 0.35, k3: 0.30, k2: 0.15, v3: 0, tov: 0, orb: 0, margin: false },
    B: { name: 'Back to normal', pace: 0.35, k3: 0, k2: 0, v3: 0, tov: 0, orb: 0, margin: false },
    C: { name: 'Data carry-over', pace: 0.35, k3: -0.08, k2: -0.25, v3: 0.30, tov: 0.15, orb: 0.20, margin: true },
    D: { name: 'Possession-heavy', pace: 0.50, k3: 0, k2: 0, v3: 0, tov: 0.50, orb: 0.50, margin: false },
  },
  nba: {
    A: { name: 'Catch-up', pace: 0.30, k3: 0.30, k2: 0.15, v3: 0, tov: 0, orb: 0, margin: false },
    B: { name: 'Back to normal', pace: 0.30, k3: 0, k2: 0, v3: 0, tov: 0, orb: 0, margin: false },
    C: { name: 'Data carry-over', pace: 0.30, k3: -0.06, k2: -0.04, v3: 0.07, tov: 0.04, orb: 0.05, margin: false },
    D: { name: 'Possession-heavy', pace: 0.50, k3: 0, k2: 0, v3: 0, tov: 0.50, orb: 0.50, margin: false },
  },
};

export function halftimeModels(games, cfg, lg) {
  const M = HT_MODELS[lg], min3 = lg === 'nba' ? 10 : 8, min2 = lg === 'nba' ? 14 : 10, ftc = cfg.ftc;
  const reg = games.filter(g => g.halves && g.mins === cfg.mins);
  const hp = r => r.tpa + r.a2 + ftc * r.fta - r.orb + r.tov;
  // season sums per team (full-game box), used leave-one-out
  const box = t => ({ n: 1, poss: t.fga - t.orb + ftc * t.fta + t.tov, pts: t.pts, fga: t.fga, fgm: t.fgm, tpa: t.tpa, tpm: t.tpm, a2: t.fga - t.tpa, m2: t.fgm - t.tpm, tov: t.tov, orb: t.orb });
  // offense sums (own box) and defense sums (what opponents did against them), used leave-one-out
  const off = {}, def = {}, lgS = {};
  const add = (a, b, k) => { for (const x in b) a[x] = (a[x] || 0) + k * b[x]; };
  games.filter(g => g.mins === cfg.mins).forEach(g => g.teams.forEach((t, i) => {
    const o = g.teams[1 - i];
    add(off[t.id] = off[t.id] || {}, box(t), 1); add(def[t.id] = def[t.id] || {}, box(o), 1); add(lgS, box(t), 1);
  }));
  const lg3 = lgS.tpm / lgS.tpa, lg2 = lgS.m2 / lgS.a2;
  const L = { pace: lgS.poss / lgS.n, fpt: lgS.fga / lgS.poss, r3: lgS.tpa / lgS.poss, p3: lg3, p2: lg2, tov: lgS.tov / lgS.poss,
    orb: lgS.orb / (lgS.fga - lgS.fgm), ppp: lgS.pts / lgS.poss, fg: lgS.fgm / lgS.fga };
  const mx = (o, d, l) => o * d / l;   // matchup: offense x opponent defense / league
  const stat = S => ({ pace: S.poss / S.n, fpt: S.fga / S.poss, r3: S.tpa / S.poss, p3: (S.tpm + 60 * lg3) / (S.tpa + 60), p2: (S.m2 + 60 * lg2) / (S.a2 + 60),
    tov: S.tov / S.poss, orb: S.orb / Math.max(1, S.fga - S.fgm), ppp: S.pts / S.poss, fg: S.fgm / S.fga });
  let P1 = 0, P2 = 0, Q1 = 0, Q2 = 0;
  reg.forEach(g => Object.values(g.halves).forEach(([a, b]) => { P1 += a.pts; P2 += b.pts; Q1 += hp(a); Q2 += hp(b); }));
  const share2 = P2 / (P1 + P2), possShare1 = Q1 / (Q1 + Q2);
  const rows = [];
  for (const g of reg) {
    if (!g.lines || !g.lines.close) continue;
    const N = [];
    let ok = true;
    for (let i = 0; i < 2; i++) {
      const t = g.teams[i], u = g.teams[1 - i];
      const O = Object.assign({}, off[t.id]); add(O, box(t), -1);   // my offense, this game removed
      const D = Object.assign({}, def[u.id]); add(D, box(t), -1);   // opponent's defense, this game removed
      const h = g.halves[t.id];
      if (!h || !(O.n >= 4) || !(D.n >= 4) || O.poss <= 0 || D.poss <= 0) { ok = false; break; }
      const so = stat(O), sd = stat(D);
      N.push({ t, h1: h[0], h2: h[1], pN: so.pace, pD: sd.pace, fpt: mx(so.fpt, sd.fpt, L.fpt), r3n: mx(so.r3, sd.r3, L.r3), fgN: mx(so.fg, sd.fg, L.fg),
        p3n: mx(so.p3, sd.p3, L.p3), p2n: mx(so.p2, sd.p2, L.p2), tovN: mx(so.tov, sd.tov, L.tov), orbN: mx(so.orb, sd.orb, L.orb), pppN: mx(so.ppp, sd.ppp, L.ppp) });
    }
    if (!ok) continue;
    const line2 = g.lines.h2 != null ? g.lines.h2 : Math.round(g.lines.close * share2 * 2) / 2;
    const real = g.lines.h2 != null;
    const mPace = (mx(N[0].pN, N[1].pD, L.pace) + mx(N[1].pN, N[0].pD, L.pace)) / 2;
    const exp1 = mPace * possShare1, exp2 = mPace * (1 - possShare1);
    const trips1 = (hp(N[0].h1) + hp(N[1].h1)) / 2, paceGap = trips1 / exp1 - 1;
    const pts1 = N[0].h1.pts + N[1].h1.pts, pts2 = N[0].h2.pts + N[1].h2.pts;
    const margin = Math.abs(N[0].h1.pts - N[1].h1.pts);
    // shooting luck in the 1st half, net of the second chances a miss usually brings
    let luck = 0;
    for (const n of N) {
      const back = n.orbN * n.pppN, p1 = hp(n.h1);
      n.p1 = p1;
      n.gap3 = n.h1.tpa >= min3 ? n.h1.tpm / n.h1.tpa - n.p3n : 0;
      n.gap2 = n.h1.a2 >= min2 ? n.h1.m2 / n.h1.a2 - n.p2n : 0;
      n.rate3l = p1 > 0 ? n.h1.tpa / p1 : n.r3n;
      n.tovL = p1 > 0 ? n.h1.tov / p1 : n.tovN;
      const miss1 = n.h1.tpa - n.h1.tpm + n.h1.a2 - n.h1.m2;
      n.orbL = miss1 > 0 ? n.h1.orb / miss1 : n.orbN;
      luck += (n.h1.tpm - n.h1.tpa * n.p3n) * (3 - back) + (n.h1.m2 - n.h1.a2 * n.p2n) * (2 - back);
    }
    const preds = {};
    for (const [key, m] of Object.entries(M)) {
      const paceAdj = 1 + m.pace * paceGap, trips2 = exp2 * paceAdj;
      let pred = line2 * paceAdj;
      for (const n of N) {
        const r3 = trips2 * (n.r3n + m.v3 * (n.rate3l - n.r3n)), r2 = trips2 * n.fpt - r3, r3b = trips2 * n.r3n;
        pred += (r3 - r3b) * (3 * n.p3n - 2 * n.p2n) + r3 * 3 * (-m.k3 * n.gap3) + r2 * 2 * (-m.k2 * n.gap2);
        pred += -m.tov * (n.tovL - n.tovN) * trips2 * (n.pppN / (1 - n.tovN));
        pred += m.orb * (n.orbL - n.orbN) * trips2 * n.fpt * (1 - n.fgN) * n.pppN;
      }
      if (m.margin && lg === 'ncaa') pred *= margin <= 8 ? 1.02 : margin >= 15 ? 0.98 : 1;
      preds[key] = pred;
    }
    const d1 = pts1 - g.lines.close * (1 - share2), paceP = paceGap * g.lines.close * (1 - share2);
    const type = d1 >= 3 ? (luck > paceP ? 'over · hot shooting' : 'over · pace') : d1 <= -3 ? (luck < paceP ? 'under · cold shooting' : 'under · slow pace') : 'near the number';
    rows.push({ id: g.id, day: g.date.slice(0, 10), game: N[0].t.abbr + ' v ' + N[1].t.abbr, line2, real, pts2, preds, type, d1: +d1.toFixed(1), luck: +luck.toFixed(1), paceGap: +(paceGap * 100).toFixed(1) });
  }
  const rec = rs => {
    const w = rs.filter(r => r.win === true).length, l = rs.filter(r => r.win === false).length;
    return { n: w + l, w, l, pct: w + l ? +(100 * w / (w + l)).toFixed(1) : null, roi: w + l ? +(100 * (w * 100 / 110 - l) / (w + l)).toFixed(1) : null };
  };
  const bet = (r, pred) => r.pts2 === r.line2 ? null : (pred > r.line2) === (r.pts2 > r.line2);
  const models = Object.entries(M).map(([key, m]) => ({
    key, ...m,
    mae: rows.length ? +(rows.reduce((s, r) => s + Math.abs(r.pts2 - r.preds[key]), 0) / rows.length).toFixed(2) : null,
    bets: [1, 2, 3, 5].map(T => ({ T, ...rec(rows.filter(r => Math.abs(r.preds[key] - r.line2) >= T).map(r => ({ win: bet(r, r.preds[key]) }))) })),
  }));
  const keys = Object.keys(M);
  const agree = (need, T) => rec(rows.map(r => {
    const sides = keys.map(k => r.preds[k] - r.line2).filter(d => Math.abs(d) >= T);
    const ov = sides.filter(d => d > 0).length, un = sides.filter(d => d < 0).length;
    if (ov >= need && un === 0) return { win: bet(r, r.line2 + 1) };
    if (un >= need && ov === 0) return { win: bet(r, r.line2 - 1) };
    return null;
  }).filter(Boolean));
  const types = ['over · hot shooting', 'over · pace', 'near the number', 'under · cold shooting', 'under · slow pace'].map(type => {
    const x = rows.filter(r => r.type === type);
    const o = x.filter(r => r.pts2 > r.line2).length, u = x.filter(r => r.pts2 < r.line2).length;
    return { type, n: x.length, overPct: o + u ? +(100 * o / (o + u)).toFixed(1) : null, vsLine: x.length ? +(x.reduce((s, r) => s + r.pts2 - r.line2, 0) / x.length).toFixed(1) : null };
  });
  return {
    games: rows.length, realLines: rows.filter(r => r.real).length, share2: +(share2 * 100).toFixed(1),
    normals: 'Matchup normals: each team\'s offense x the opponent\'s defense / league (season to date, this game left out).',
    lineNote: 'Stand-in 2nd-half line = closing total x the league 2nd-half share, until real halftime lines are logged.',
    models, agree: { all4: [1, 2, 3].map(T => ({ T, ...agree(4, T) })), three: [1, 2, 3].map(T => ({ T, ...agree(3, T) })) },
    types,
    rows: rows.slice(-150).map(r => ({ ...r, preds: Object.fromEntries(Object.entries(r.preds).map(([k, v]) => [k, +v.toFixed(1)])) })),
  };
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const which = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(LEAGUES);
  for (const lg of which) {
    const cfg = LEAGUES[lg];
    const store = await updateGames(lg, cfg);
    const res = computeRatings(Object.values(store.games), cfg);
    fs.writeFileSync(path.join(DATA, lg + '-ratings.json'), JSON.stringify(res));
    const bt = backtest(Object.values(store.games), cfg);
    try { bt.halftime = halftimeModels(Object.values(store.games), cfg, lg); console.log(lg + ' halftime models: ' + bt.halftime.games + ' games; ' + bt.halftime.models.map(m => m.name + ' ' + JSON.stringify(m.bets[1])).join(' | ')); }
    catch (e) { console.error('halftime models failed', e); }
    fs.writeFileSync(path.join(DATA, lg + '-backtest.json'), JSON.stringify(bt));
    console.log(lg + ' replay: ' + bt.games + ' games, all ' + JSON.stringify(bt.all) + ', buckets ' + JSON.stringify(bt.buckets) + ', line moves ' + JSON.stringify(bt.lineMove) + ', accuracy ' + JSON.stringify(bt.accuracy));
    const top = Object.values(res.ratings).sort((a, b) => a.rank - b.rank).slice(0, 10)
      .map(t => t.rank + '. ' + t.name + ' ' + (t.em > 0 ? '+' : '') + t.em + ' (O ' + (t.o * 100).toFixed(1) + ' / D ' + (t.d * 100).toFixed(1) + ' / T ' + t.t + ')');
    console.log(lg + ': ' + res.teams + ' teams rated from ' + res.games + ' games. League ' + (res.lg.eff * 100).toFixed(1) + ' pts/100, tempo ' + res.lg.tempo);
    console.log(top.join('\n'));
  }
}
if (import.meta.url === 'file://' + process.argv[1]) main().catch(e => { console.error(e); process.exit(1); });
