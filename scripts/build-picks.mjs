// Morning picks for the Live Totals Hub (college).
// Model F (Claude): points per trip built from shot mix, make rates, turnovers, rebounds, FT; schedule-adjusted;
//   pace = outlier-capped fade (70%) + Mike's chain of trimmed 5-game links (30%); rolling lean correction.
// Model C3-trimmed (Mike): opponent-adjusted ratings (90-day fade), half efficiency / half shooting profile;
//   pace nudged 20% toward Mike's trimmed last-5 (drop high and low).
// Rule (tested on 3 past seasons): F and C each 5+ points off the OPENING total, same side.
// Writes data/ncaa-picks.json (today and tomorrow) and keeps a graded forward log in data/ncaa-picks-log.json.
// Run: node scripts/build-picks.mjs            (live: pulls upcoming games + lines from ESPN)
//      node scripts/build-picks.mjs --test FILE DAY   (offline check: predicts DAY's games from FILE's earlier games)
import fs from 'node:fs';
import { computeRatings } from './build-ratings.mjs';

const FTC = 0.475, HL = 75, CFG = { mins: 40, ftc: FTC, d1Only: true };
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/';
const etDay = iso => new Date(Date.parse(iso) - 5 * 3600e3).toISOString().slice(0, 10);
const dnum = d => Date.parse(d + 'T12:00:00Z') / 864e5;
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const poss = t => t.fga - t.orb + FTC * t.fta + t.tov;

// ---------- Model F ----------
const side = (g, t, o) => { const h = g.halves && g.halves[t.id], sum = k => h ? h.reduce((s, x) => s + (x[k] || 0), 0) : 0;
  return { fgm2: t.fgm - t.tpm, poss: poss(t), fga: t.fga, tpa: t.tpa, tpm: t.tpm, fta: t.fta, ftm: t.ftm, orb: t.orb, drb: t.drb, tov: t.tov, pts: t.pts, rima: sum('rima'), rimm: sum('rimm'), jmpa: sum('jmpa'), jmpm: sum('jmpm'), hasH: !!h }; };
const ST = {
  tov: [x => x.tov, x => x.poss, 200, 300, 1],
  orb: [(x, y) => x.orb, (x, y) => x.orb + y.drb, 100, 150, 1],
  ftr: [x => x.fta, x => x.fga, 200, 300, 1],
  s3: [x => x.tpa, x => x.fga, 120, 200, 1],
  rs: [x => x.hasH ? x.rima : 0, x => x.hasH ? x.rima + x.jmpa : 0, 100, 200, 1],
  p3: [x => x.tpm, x => x.tpa, 300, 1000, 1],
  pR: [x => x.hasH ? x.rimm : 0, x => x.hasH ? x.rima : 0, 150, 300, 1],
  pJ: [x => x.hasH ? x.jmpm : 0, x => x.hasH ? x.jmpa : 0, 200, 600, 1],
  ftp: [x => x.ftm, x => x.fta, 100, 0, 0],
  p2: [x => x.fgm2, x => x.fga - x.tpa, 200, 600, 1],
};
const LG_SPLIT = { rs: 0.641, pR: 0.594, pJ: 0.385 }; // fallback rim/jumper split of twos when no half-by-half shot data yet

function modelF(done, upcoming, minBias) {
  const games = done.concat(upcoming.map(g => ({ ...g, _up: true }))).filter(g => g._up || g.mins === 40)
    .sort((a, b) => a.date < b.date ? -1 : 1);
  const H = {}, pred = {}; let graded = [];
  const days = [...new Set(games.map(g => etDay(g.date)))].sort();
  for (const day of days) {
    const today = games.filter(g => etDay(g.date) === day), now = dnum(day), teams = Object.keys(H), out = [];
    if (teams.length > 200) {
      const LG = {}; for (const s in ST) LG[s] = { n: 0, d: 0 }; let lgP = 0, lgN = 0;
      for (const id of teams) for (const r of H[id]) { for (const s in ST) { LG[s].n += ST[s][0](r.o, r.y); LG[s].d += ST[s][1](r.o, r.y); } lgP += r.gp; lgN++; }
      const lg = {}; for (const s in ST) lg[s] = LG[s].d ? LG[s].n / LG[s].d : LG_SPLIT[s]; const lgPace = lgP / lgN;
      const w = r => Math.pow(.5, (now - r.d) / HL);
      const raw1 = {};
      for (const id of teams) { raw1[id] = { o: {}, d: {} }; for (const s in ST) { let on = 0, od = 0, dn = 0, dd = 0; for (const r of H[id]) { const k = w(r); on += k * ST[s][0](r.o, r.y); od += k * ST[s][1](r.o, r.y); dn += k * ST[s][0](r.y, r.o); dd += k * ST[s][1](r.y, r.o); }
        raw1[id].o[s] = (on + ST[s][2] * lg[s]) / (od + ST[s][2]); raw1[id].d[s] = ST[s][4] ? (dn + ST[s][3] * lg[s]) / (dd + ST[s][3]) : lg[s]; } }
      const adj = {};
      for (const id of teams) { adj[id] = { o: {}, d: {} }; for (const s in ST) { let on = 0, od = 0, dn = 0, dd = 0; for (const r of H[id]) { const k = w(r), op = raw1[r.opp];
          const fo = op ? op.d[s] / lg[s] : 1, fd = op ? op.o[s] / lg[s] : 1; on += k * ST[s][0](r.o, r.y); od += k * ST[s][1](r.o, r.y) * fo; dn += k * ST[s][0](r.y, r.o); dd += k * ST[s][1](r.y, r.o) * fd; }
        adj[id].o[s] = (on + ST[s][2] * lg[s]) / (od + ST[s][2]); adj[id].d[s] = ST[s][4] ? (dn + ST[s][3] * lg[s]) / (dd + ST[s][3]) : lg[s]; } }
      const paceCC = id => { const A = H[id], gps = A.map(r => r.gp); const z = [...gps].sort((x, y) => x - y), lo = z[Math.floor(z.length * .1)], hi = z[Math.max(0, Math.ceil(z.length * .9) - 1)];
        let n = 0, s = 0; A.forEach(r => { const k = w(r); n += k; s += k * Math.min(hi, Math.max(lo, r.gp)); }); const cap = (s + 6 * lgPace) / (n + 6);
        const ch = []; let end = gps.length; for (let i = 0; i < 3 && end - 5 >= 0; i++) { const q = gps.slice(end - 5, end).sort((x, y) => x - y); ch.push(mean(q.slice(1, 4))); end -= 4; }
        return .7 * cap + .3 * (ch.length ? mean(ch) : cap); };
      const ppp = (O, D, home) => { const m = s => s === 'ftp' ? O.o.ftp : O.o[s] * D.d[s] / lg[s];
        const t = m('tov'), orb = m('orb'), ftr = m('ftr'), s3 = m('s3'), p3 = m('p3'), ftp = m('ftp'), p2 = m('p2'), rs = m('rs');
        const mix = lg.rs * lg.pR + (1 - lg.rs) * lg.pJ, pR = p2 * lg.pR / mix, pJ = p2 * lg.pJ / mix;
        const sR = (1 - s3) * rs, sJ = (1 - s3) * (1 - rs), fg = s3 * p3 + sR * pR + sJ * pJ, fpt = (1 - t) / (1 - orb * (1 - fg) + FTC * ftr);
        return fpt * (s3 * 3 * p3 + sR * 2 * pR + sJ * 2 * pJ + ftr * ftp) * home; };
      for (const g of today) {
        const [a, b] = g.teams; if (!H[a.id] || !H[b.id] || H[a.id].length < 4 || H[b.id].length < 4) continue;
        if (!g._up && !(g.lines && g.lines.close)) continue;
        const hf = t => g.neutral ? 1 : (t.home ? 1.014 : 0.986);
        const pc = paceCC(a.id) * paceCC(b.id) / lgPace;
        const v = pc * (ppp(adj[a.id], adj[b.id], hf(a)) + ppp(adj[b.id], adj[a.id], hf(b)));
        if (!isFinite(v)) continue;
        const G = graded.slice(-800), bias = G.length >= minBias ? mean(G.map(x => x.p - x.final)) : 0;
        if (g._up) pred[g.id] = v - bias; else { out.push({ p: v, final: a.pts + b.pts }); pred[g.id] = v - bias; }
      }
    }
    for (const g of today) { if (g._up) continue; const [a, b] = g.teams, sa = side(g, a, b), sb = side(g, b, a), gp = (sa.poss + sb.poss) / 2, d = dnum(day);
      (H[a.id] = H[a.id] || []).push({ d, o: sa, y: sb, opp: b.id, gp }); (H[b.id] = H[b.id] || []).push({ d, o: sb, y: sa, opp: a.id, gp }); }
    graded = graded.concat(out);
  }
  return pred;
}

// ---------- Model C3 + trimmed last-5 (Mike) ----------
function modelC(done, upcoming) {
  const pred = {}; const byDay = {};
  upcoming.forEach(g => (byDay[etDay(g.date)] = byDay[etDay(g.date)] || []).push(g));
  for (const [day, list] of Object.entries(byDay)) {
    const train = done.filter(g => g.mins >= 40 && etDay(g.date) < day);
    if (train.length < 50) continue;
    const R = computeRatings(train, { ...CFG, halfLife: 90 }, new Date(day + 'T12:00:00Z'));
    const tr = train.filter(g => g.mins === 40); let LP = 0, LN = 0; tr.forEach(g => g.teams.forEach(t => { LP += poss(t); LN++; })); const lgPace = LP / LN;
    const hist = {}; train.slice().sort((x, y) => x.date < y.date ? -1 : 1).forEach(g => { const p = (poss(g.teams[0]) + poss(g.teams[1])) / 2; g.teams.forEach(t => (hist[t.id] = hist[t.id] || []).push(p)); });
    const prof = (X, Y) => { const Lg = R.lg, k = key => X.f['o_' + key] * Y.f['d_' + key] / Lg[key];
      const tpar = k('tpar'), tp = k('tp'), p2 = k('p2'), tov = k('tov'), orb = k('orb'), ftr = k('ftr'), fg = tpar * tp + (1 - tpar) * p2;
      const fpt = (1 - tov) / (1 - orb * (1 - fg) + FTC * ftr); return fpt * (tpar * 3 * tp + (1 - tpar) * 2 * p2) + fpt * ftr * (X.ftp || Lg.ftp); };
    for (const g of list) {
      const [a, b] = g.teams, A = R.ratings[a.id], B = R.ratings[b.id];
      if (!A || !B || !hist[a.id] || !hist[b.id] || hist[a.id].length < 3 || hist[b.id].length < 3) continue;
      const hf = t => g.neutral ? 1 : (t.home ? 1.014 : 0.986);
      const lgF = { f: Object.fromEntries(Object.keys(A.f).map(k => [k, R.lg[k.slice(2)]])), ftp: R.lg.ftp }, lp = prof(lgF, lgF);
      const ppp = (P, Q) => 0.5 * P.o * Q.d / R.lg.eff + 0.5 * prof(P, Q) * R.lg.eff / lp;
      const p0 = A.t * B.t / R.lg.tempo, c3 = p0 * (ppp(A, B) * hf(a) + ppp(B, A) * hf(b));
      const tr5 = h => { const q = h.slice(-5).sort((x, y) => x - y); return q.length >= 5 ? mean(q.slice(1, 4)) : mean(h); };
      const pTrim = tr5(hist[a.id]) * tr5(hist[b.id]) / lgPace;
      const v = c3 * (0.8 + 0.2 * pTrim / p0);
      if (isFinite(v)) pred[g.id] = v;
    }
  }
  return pred;
}

// ---------- picks ----------
function pick(g, F, C) {
  const open = g.lines && g.lines.open != null ? g.lines.open : null, cur = g.lines && g.lines.close != null ? g.lines.close : null, line = open != null ? open : cur;
  if (F == null || C == null || line == null) return null;
  const FC = (F + C) / 2, gF = F - line, gC = C - line, same = Math.sign(gF) === Math.sign(gC);
  const both = same ? Math.min(Math.abs(gF), Math.abs(gC)) : 0;
  const tier = both >= 8 ? 'A' : both >= 5 ? 'B' : (same && Math.abs(FC - line) >= 5 ? 'C' : null);
  return { F: +F.toFixed(1), C: +C.toFixed(1), FC: +FC.toFixed(1), open, current: cur, line, gapF: +gF.toFixed(1), gapC: +gC.toFixed(1),
    side: tier ? (gF > 0 ? 'OVER' : 'UNDER') : null, tier, price: tier ? (gF > 0 ? (g.lines.overOdds || [])[0] : (g.lines.underOdds || [])[0]) ?? null : null,
    po: (g.lines.overOdds || [])[0] ?? null, pu: (g.lines.underOdds || [])[0] ?? null };
}

// ---------- ESPN (live) ----------
async function getJSON(url) { for (let i = 0; i < 4; i++) { try { const r = await fetch(url, { headers: { 'User-Agent': 'totals-hub-picks/1.0' } }); if (r.ok) return await r.json(); if (r.status === 404) return null; } catch (e) { } await new Promise(r => setTimeout(r, 800 * (i + 1))); } return null; }
const num = v => { if (v == null) return null; const s = String(v); if (/even/i.test(s)) return 100; const n = parseFloat(s.replace(/^[ou+]/i, '')); return isNaN(n) ? null : n; };
async function upcomingGames(days) {
  const out = [];
  for (const d of days) {
    const sb = await getJSON(BASE + 'scoreboard?dates=' + d.replace(/-/g, '') + '&groups=50&limit=400'); if (!sb) continue;
    for (const e of sb.events || []) {
      const c = e.competitions && e.competitions[0]; if (!c || (c.status && c.status.type && c.status.type.state !== 'pre')) continue;
      const teams = (c.competitors || []).map(t => ({ id: String(t.team.id), name: t.team.displayName, abbr: t.team.abbreviation, home: t.homeAway === 'home' }));
      if (teams.length !== 2) continue;
      const s = await getJSON(BASE + 'summary?event=' + e.id), pc = s && s.pickcenter && ((s.pickcenter.find(p => p.total) || s.pickcenter[0]));
      const t = (pc && pc.total) || {}, ov = t.over || {}, un = t.under || {};
      const lines = pc ? { book: pc.provider && pc.provider.name, open: num(ov.open && ov.open.line), close: num(ov.close && ov.close.line) ?? (pc.overUnder != null ? +pc.overUnder : null),
        overOdds: [num(ov.open && ov.open.odds), num(ov.close && ov.close.odds)], underOdds: [num(un.open && un.open.odds), num(un.close && un.close.odds)] } : null;
      out.push({ id: String(e.id), date: e.date, teams, neutral: !!c.neutralSite, confGame: !!c.conferenceCompetition, lines });
    }
  }
  return out;
}

// ---------- grading the forward log ----------
const pay = o => o == null ? 100 / 110 : (o > 0 ? o / 100 : 100 / -o);
function grade(log, store) {
  for (const p of Object.values(log.picks)) {
    if (p.result) continue; const g = store[p.id]; if (!g || !g.teams || g.teams.some(t => t.pts == null)) continue;
    const final = g.teams[0].pts + g.teams[1].pts; p.final = final;
    if (!p.side) { p.result = 'no bet'; continue; }
    if (final === p.line) { p.result = 'push'; continue; }
    const win = (final > p.line) === (p.side === 'OVER'); p.result = win ? 'win' : 'loss'; p.units = +(win ? pay(p.price) : -1).toFixed(3);
  }
  const rec = {}; for (const p of Object.values(log.picks)) { if (!p.tier || !['win', 'loss'].includes(p.result)) continue; for (const k of [p.tier, 'all']) { const r = rec[k] = rec[k] || { w: 0, l: 0, units: 0 }; p.result === 'win' ? r.w++ : r.l++; r.units = +(r.units + p.units).toFixed(3); } }
  log.record = rec;
}

// ---------- season bias (bias-corrected version) ----------
// Replays this season day by day with the live models (only earlier games), compares each model with the final score,
// and returns its average miss (model − final) over the last 60 game days, shrunk toward 0 by 50 games.
function seasonBias(done) {
  const withLine = done.filter(g => g.lines && (g.lines.open != null || g.lines.close != null));
  const days = [...new Set(withLine.map(g => etDay(g.date)))].sort().slice(-60);
  let sF = 0, sC = 0, n = 0;
  for (const day of days) {
    const before = done.filter(g => etDay(g.date) < day), on = withLine.filter(g => etDay(g.date) === day);
    if (before.length < 200 || !on.length) continue;
    const F = modelF(before, on, 60), C = modelC(before, on);
    for (const g of on) { const f = F[g.id], c = C[g.id]; if (f == null || c == null || !isFinite(f) || !isFinite(c)) continue;
      const fin = g.teams[0].pts + g.teams[1].pts; sF += f - fin; sC += c - fin; n++; }
  }
  return { F: n ? sF / (n + 50) : 0, C: n ? sC / (n + 50) : 0, games: n, days: days.length };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--test') { // offline check against a saved season
    const store = JSON.parse(fs.readFileSync(args[1], 'utf8')).games, day = args[2];
    const all = Object.values(store), done = all.filter(g => etDay(g.date) < day), up = all.filter(g => etDay(g.date) === day && g.lines && g.lines.close);
    const F = modelF(done, up, 200), C = modelC(done, up);
    console.log(JSON.stringify(up.slice(0, 400).map(g => ({ id: g.id, F: F[g.id], C: C[g.id] }))));
    return;
  }
  const store = JSON.parse(fs.readFileSync('data/ncaa-games.json', 'utf8')).games;
  const done = Object.values(store).filter(g => g.teams && g.teams.every(t => t.pts != null));
  const today = etDay(new Date().toISOString()), tomorrow = etDay(new Date(Date.now() + 864e5).toISOString());
  const up = await upcomingGames([today, tomorrow]);
  const F = modelF(done, up, 60), C = modelC(done, up), B = seasonBias(done);
  const games = up.map(g => { const p = pick(g, F[g.id], C[g.id]), corr = p ? { Fc: +(p.F - B.F).toFixed(1), Cc: +(p.C - B.C).toFixed(1), FCc: +(p.FC - (B.F + B.C) / 2).toFixed(1) } : {}; return { id: g.id, date: g.date, day: etDay(g.date), away: g.teams.find(t => !t.home) || g.teams[0], home: g.teams.find(t => t.home) || g.teams[1], neutral: g.neutral, conf: g.confGame, book: g.lines && g.lines.book, ...(p || {}), ...corr }; })
    .sort((x, y) => (x.date < y.date ? -1 : 1));
  fs.writeFileSync('data/ncaa-picks.json', JSON.stringify({ updated: new Date().toISOString(), bias: { F: +B.F.toFixed(2), C: +B.C.toFixed(2), games: B.games, days: B.days }, rule: 'F and C each 5+ off the opening total, same side (A = both 8+, B = both 5+, C = average 5+ only, track-only)', games }));
  const logFile = 'data/ncaa-picks-log.json', log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : { picks: {} };
  for (const g of games) { if (g.F == null) continue; const old = log.picks[g.id]; if (old && old.result) continue;
    // keep the first-seen opener and model numbers (the bet we would have made), refresh current line
    log.picks[g.id] = old && old.line != null ? { ...old, current: g.current } : { id: g.id, day: g.day, away: g.away.abbr, home: g.home.abbr, F: g.F, C: g.C, FC: g.FC, line: g.line, open: g.open, current: g.current, side: g.side, tier: g.tier, price: g.price, po: g.po, pu: g.pu, Fc: g.Fc, Cc: g.Cc, FCc: g.FCc, logged: new Date().toISOString() }; }
  grade(log, store); log.updated = new Date().toISOString();
  fs.writeFileSync(logFile, JSON.stringify(log));
  console.log('picks: ' + games.length + ' upcoming, ' + games.filter(g => g.tier === 'A' || g.tier === 'B').length + ' rule bets | bias F ' + B.F.toFixed(2) + ' C ' + B.C.toFixed(2) + ' (' + B.games + ' games) | record ' + JSON.stringify(log.record || {}));
}
main().catch(e => { console.error(e); process.exit(1); });
