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

const PF = {}, PF2 = {}, PC = {}, PC1 = {}; // model pieces for the playbook (hybrid = C pace × F points per trip; C core = Mike's original C)
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

// opt (version F2, Nov 28): prior = [[games, age, weight per game], ...] keeps past seasons' games as history at a fixed weight;
// era = 'auto' rescales prior-season stats to this season's league level in Nov–Dec; store = where pieces go (default PF).
function modelF(done, upcoming, minBias, opt = {}) {
  const games = done.concat(upcoming.map(g => ({ ...g, _up: true }))).filter(g => g._up || g.mins === 40)
    .sort((a, b) => a.date < b.date ? -1 : 1);
  const H = {}, pred = {}, STORE = opt.store || PF, PW = {}; let graded = [];
  for (const [pg, age, wt] of (opt.prior || [])) { PW[age] = wt;
    for (const g of pg) { if (g.mins !== 40 || !g.teams || g.teams.length !== 2 || !g.teams.every(t => t.fga > 0)) continue;
      const [a, b] = g.teams, sa = side(g, a, b), sb = side(g, b, a), gp = (sa.poss + sb.poss) / 2, d = dnum(etDay(g.date));
      (H[a.id] = H[a.id] || []).push({ age, d, o: sa, y: sb, opp: b.id, gp }); (H[b.id] = H[b.id] || []).push({ age, d, o: sb, y: sa, opp: a.id, gp }); } }
  const days = [...new Set(games.map(g => etDay(g.date)))].sort();
  for (const day of days) {
    const today = games.filter(g => etDay(g.date) === day), now = dnum(day), teams = Object.keys(H), out = [];
    if (teams.length > 200) {
      const LG = {}; for (const s in ST) LG[s] = { n: 0, d: 0 }; let lgP = 0, lgN = 0;
      const ERA = opt.era === 'auto' && ['11', '12'].includes(day.slice(5, 7)), LGP = { 1: {}, 2: {} }, PP = { 1: [0, 0], 2: [0, 0] };
      for (const a of [1, 2]) for (const s in ST) LGP[a][s] = { n: 0, d: 0 };
      for (const id of teams) for (const r of H[id]) { if (r.age) { if (ERA) { for (const s in ST) { LGP[r.age][s].n += ST[s][0](r.o, r.y); LGP[r.age][s].d += ST[s][1](r.o, r.y); } PP[r.age][0] += r.gp; PP[r.age][1]++; } continue; }
        for (const s in ST) { LG[s].n += ST[s][0](r.o, r.y); LG[s].d += ST[s][1](r.o, r.y); } lgP += r.gp; lgN++; }
      if (opt.prior && lgN < 300) { // too few games this season: lean on last season's league rates
        const L1 = { n: {}, d: {} }, P1 = [0, 0]; for (const id of teams) for (const r of H[id]) if (r.age === 1) { for (const s in ST) { L1.n[s] = (L1.n[s] || 0) + ST[s][0](r.o, r.y); L1.d[s] = (L1.d[s] || 0) + ST[s][1](r.o, r.y); } P1[0] += r.gp; P1[1]++; }
        const wc = lgN / 300, sc = P1[1] ? (lgN || 1) / P1[1] : 0; if (P1[1]) { for (const s in ST) { LG[s].n = wc * LG[s].n + (1 - wc) * L1.n[s] * sc; LG[s].d = wc * LG[s].d + (1 - wc) * L1.d[s] * sc; } lgP = lgN ? wc * lgP + (1 - wc) * P1[0] / P1[1] * lgN : P1[0] / P1[1]; lgN = lgN || 1; } }
      const lg = {}; for (const s in ST) lg[s] = LG[s].d ? LG[s].n / LG[s].d : LG_SPLIT[s]; const lgPace = lgP / lgN;
      const SC = { 1: {}, 2: {} }, PSC = { 1: 1, 2: 1 }; if (ERA) for (const a of [1, 2]) { for (const s in ST) { const q = LGP[a][s]; SC[a][s] = q.d && q.n ? lg[s] / (q.n / q.d) : 1; } PSC[a] = PP[a][1] ? lgPace / (PP[a][0] / PP[a][1]) : 1; }
      const fac = (r, s) => r.age && ERA ? SC[r.age][s] : 1, gpx = r => r.age && ERA ? r.gp * PSC[r.age] : r.gp;
      const w = r => r.age ? (PW[r.age] || 0) : Math.pow(.5, (now - r.d) / HL);
      const raw1 = {};
      for (const id of teams) { raw1[id] = { o: {}, d: {} }; for (const s in ST) { let on = 0, od = 0, dn = 0, dd = 0; for (const r of H[id]) { const k = w(r), fx = fac(r, s); on += k * ST[s][0](r.o, r.y) * fx; od += k * ST[s][1](r.o, r.y); dn += k * ST[s][0](r.y, r.o) * fx; dd += k * ST[s][1](r.y, r.o); }
        raw1[id].o[s] = (on + ST[s][2] * lg[s]) / (od + ST[s][2]); raw1[id].d[s] = ST[s][4] ? (dn + ST[s][3] * lg[s]) / (dd + ST[s][3]) : lg[s]; } }
      const adj = {};
      for (const id of teams) { adj[id] = { o: {}, d: {} }; for (const s in ST) { let on = 0, od = 0, dn = 0, dd = 0; for (const r of H[id]) { const k = w(r), op = raw1[r.opp];
          const fx = fac(r, s), fo = op ? op.d[s] / lg[s] : 1, fd = op ? op.o[s] / lg[s] : 1; on += k * ST[s][0](r.o, r.y) * fx; od += k * ST[s][1](r.o, r.y) * fo; dn += k * ST[s][0](r.y, r.o) * fx; dd += k * ST[s][1](r.y, r.o) * fd; }
        adj[id].o[s] = (on + ST[s][2] * lg[s]) / (od + ST[s][2]); adj[id].d[s] = ST[s][4] ? (dn + ST[s][3] * lg[s]) / (dd + ST[s][3]) : lg[s]; } }
      const paceCC = id => { const A = H[id], gps = A.filter(r => !r.age).map(r => r.gp); const z = [...(gps.length >= 3 ? gps : A.map(gpx))].sort((x, y) => x - y), lo = z[Math.floor(z.length * .1)], hi = z[Math.max(0, Math.ceil(z.length * .9) - 1)];
        let n = 0, s = 0; A.forEach(r => { const k = w(r); n += k; s += k * Math.min(hi, Math.max(lo, gpx(r))); }); const cap = (s + 6 * lgPace) / (n + 6);
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
        const _pa = ppp(adj[a.id], adj[b.id], hf(a)), _pb = ppp(adj[b.id], adj[a.id], hf(b)); const v = pc * (_pa + _pb);
        if (!isFinite(v)) continue;
        const G = graded.slice(-800), bias = G.length >= minBias ? mean(G.map(x => x.p - x.final)) : 0;
        STORE[g.id] = { pace: pc, ppp: _pa + _pb };
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
    const R30 = computeRatings(train, { ...CFG, halfLife: 30 }, new Date(day + 'T12:00:00Z'));
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
      if (isFinite(v)) { pred[g.id] = v; PC[g.id] = { pace: p0 * (0.8 + 0.2 * pTrim / p0) }; }
      const X = R30.ratings[a.id], Y = R30.ratings[b.id];
      if (X && Y) { const c1 = X.t * Y.t / R30.lg.tempo * (X.o * Y.d / R30.lg.eff * hf(a) + Y.o * X.d / R30.lg.eff * hf(b)); if (isFinite(c1)) PC1[g.id] = c1; }
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
  // playbook (side by side): its own result per pick, units = tier size × win/loss
  const prec = {};
  for (const p of Object.values(log.picks)) {
    if (!p.pbTier || p.final == null || p.line == null) continue;
    if (p.pbResult == null) { if (p.final === p.line) p.pbResult = 'push'; else { const win = (p.final > p.line) === (p.pbSide === 'OVER'); p.pbResult = win ? 'win' : 'loss'; p.pbU = +((win ? pay(p.pbSide === 'OVER' ? p.po : p.pu) : -1) * (p.pbUnits || 0)).toFixed(3); } }
    if (!['win', 'loss'].includes(p.pbResult)) continue;
    for (const k of [p.pbSkip ? 'Skipped' : p.pbTier, p.pbSkip ? null : 'all'].filter(Boolean)) { const r = prec[k] = prec[k] || { w: 0, l: 0, units: 0 }; p.pbResult === 'win' ? r.w++ : r.l++; r.units = +(r.units + (p.pbU || 0)).toFixed(3); }
  }
  log.pbRecord = prec;
  const prec2 = {};
  for (const p of Object.values(log.picks)) {
    if (!p.pb2Tier || p.final == null || p.line == null) continue;
    if (p.pb2Result == null) { if (p.final === p.line) p.pb2Result = 'push'; else { const win = (p.final > p.line) === (p.pb2Side === 'OVER'); p.pb2Result = win ? 'win' : 'loss'; p.pb2U = +((win ? pay(p.pb2Side === 'OVER' ? p.po : p.pu) : -1) * (p.pb2Units || 0)).toFixed(3); } }
    if (!['win', 'loss'].includes(p.pb2Result)) continue;
    for (const k of [p.pb2Skip ? 'Skipped' : p.pb2Tier, p.pb2Skip ? null : 'all'].filter(Boolean)) { const r = prec2[k] = prec2[k] || { w: 0, l: 0, units: 0 }; p.pb2Result === 'win' ? r.w++ : r.l++; r.units = +(r.units + (p.pb2U || 0)).toFixed(3); }
  }
  log.pb2Record = prec2;
  const prech = {};
  for (const p of Object.values(log.picks)) {
    if (!p.h2Tier || p.final == null || p.line == null) continue;
    if (p.h2Result == null) { if (p.final === p.line) p.h2Result = 'push'; else { const win = (p.final > p.line) === (p.h2Side === 'OVER'); p.h2Result = win ? 'win' : 'loss'; p.h2U = +((win ? pay(p.h2Side === 'OVER' ? p.po : p.pu) : -1) * (p.h2Units || 0)).toFixed(3); } }
    if (!['win', 'loss'].includes(p.h2Result)) continue;
    for (const k of [p.h2Skip ? 'Skipped' : p.h2Tier, p.h2Skip ? null : 'all'].filter(Boolean)) { const r = prech[k] = prech[k] || { w: 0, l: 0, units: 0 }; p.h2Result === 'win' ? r.w++ : r.l++; r.units = +(r.units + (p.h2U || 0)).toFixed(3); }
  }
  log.h2Record = prech;
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

// ---------- playbook (Nov 28): four versions vs the opener, tiers, C-core filter ----------
// Each version = raw model minus its rolling lean (avg raw − final over this season's last 800 graded games, min 60):
// F, C (C3-trimmed), F + C average, hybrid (C's pace × F's points per trip), and Mike's original C core (filter only).
// Top: hybrid 10+ off the opener and F + C 5+ same side (2 units) · Strong: hybrid 7+ and F + C 5+ (1.5 units) ·
// Base: all four versions 5+ same side (1 unit) · Skip any of them when C core is under 3 off the opener on that side.
function playbook(done, up, Cpred, FS = PF) {
  const raw = g => { const f = FS[g.id], c = PC[g.id], c1 = PC1[g.id], c3 = Cpred[g.id]; if (!f || !c || c1 == null || c3 == null) return null;
    const v = { F: f.pace * f.ppp, C: c3, H: c.pace * f.ppp, H2: (0.7 * c.pace + 0.3 * f.pace) * f.ppp, C1: c1 }; return Object.values(v).every(isFinite) ? v : null; };
  const hist = done.filter(g => g.lines && (g.lines.close != null || g.lines.open != null)).sort((x, y) => x.date < y.date ? -1 : 1)
    .map(g => ({ v: raw(g), fin: g.teams[0].pts + g.teams[1].pts })).filter(x => x.v).slice(-800);
  const lean = {}; for (const k of ['F', 'C', 'H', 'H2', 'C1']) lean[k] = hist.length >= 60 ? hist.reduce((s, x) => s + x.v[k] - x.fin, 0) / hist.length : 0;
  const out = {};
  for (const g of up) {
    const v = raw(g), open = g.lines && g.lines.open != null ? g.lines.open : null; if (!v || open == null) continue;
    const F = v.F - lean.F, C = v.C - lean.C, H = v.H - lean.H, H2 = v.H2 - lean.H2, C1 = v.C1 - lean.C1, FC = (F + C) / 2;
    const d = { F: F - open, C: C - open, FC: FC - open, H: H - open, H2: H2 - open, C1: C1 - open };
    const sideOf = x => Math.sign(x), same = (x, s, t) => sideOf(x) === s && Math.abs(x) >= t;
    let tier = null, s = sideOf(d.H);
    if (same(d.H, s, 10) && same(d.FC, s, 5)) tier = 'Top';
    else if (same(d.H, s, 7) && same(d.FC, s, 5)) tier = 'Strong';
    else { s = sideOf(d.F); if (['F', 'C', 'FC', 'H'].every(k => same(d[k], s, 5))) tier = 'Base'; }
    const skip = !!tier && !same(d.C1, s, 3);
    // H2 version (Nov 28, tracked): Strong tier uses (0.7 C pace + 0.3 F pace) × F scoring; Top and Base unchanged
    let t2 = null, s2 = sideOf(d.H);
    if (same(d.H, s2, 10) && same(d.FC, s2, 5)) t2 = 'Top';
    else { s2 = sideOf(d.H2); if (same(d.H2, s2, 7) && same(d.FC, s2, 5)) t2 = 'Strong'; else { s2 = sideOf(d.F); if (['F', 'C', 'FC', 'H'].every(k => same(d[k], s2, 5))) t2 = 'Base'; } }
    const skip2 = !!t2 && !same(d.C1, s2, 3);
    const cur = g.lines.close != null ? g.lines.close : null;
    out[g.id] = { F: +F.toFixed(1), C: +C.toFixed(1), FC: +FC.toFixed(1), H: +H.toFixed(1), C1: +C1.toFixed(1), gapH: +d.H.toFixed(1), gapFC: +d.FC.toFixed(1),
      tier, side: tier ? (s > 0 ? 'OVER' : 'UNDER') : null, skip, units: tier && !skip ? { Top: 2, Strong: 1.5, Base: 1 }[tier] : 0,
      gapNow: tier && cur != null ? +((s > 0 ? 1 : -1) * ((tier === 'Base' ? FC : H) - cur)).toFixed(1) : null,
      H2: +H2.toFixed(1), h2: t2 ? { tier: t2, side: s2 > 0 ? 'OVER' : 'UNDER', skip: skip2, units: skip2 ? 0 : { Top: 2, Strong: 1.5, Base: 1 }[t2] } : null };
  }
  return { out, lean: Object.fromEntries(Object.entries(lean).map(([k, x]) => [k, +x.toFixed(2)])), games: hist.length };
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
  const F = modelF(done, up, 60), C = modelC(done, done.concat(up)), PB = playbook(done, up, C), B = seasonBias(done);
  // F2 (tracked side by side): last two seasons as light history (0.08 / 0.02 per game) + this year's style rescale in Nov–Dec
  const sy = (() => { const d = new Date(); return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; })();
  const loadS = y => { const f = 'data/ncaa' + y + '-games.json'; return fs.existsSync(f) ? Object.values(JSON.parse(fs.readFileSync(f, 'utf8')).games) : []; };
  const P1g = loadS(sy - 1), P2g = loadS(sy - 2);
  let PB2 = { out: {}, lean: {}, games: 0 };
  if (P1g.length) { modelF(done, up, 60, { prior: [[P1g, 1, 0.08], [P2g, 2, 0.02]], era: 'auto', store: PF2 }); PB2 = playbook(done, up, C, PF2); }
  const games = up.map(g => { const p = pick(g, F[g.id], C[g.id]), corr = p ? { Fc: +(p.F - B.F).toFixed(1), Cc: +(p.C - B.C).toFixed(1), FCc: +(p.FC - (B.F + B.C) / 2).toFixed(1) } : {}; return { id: g.id, pb: PB.out[g.id] || null, pb2: PB2.out[g.id] || null, date: g.date, day: etDay(g.date), away: g.teams.find(t => !t.home) || g.teams[0], home: g.teams.find(t => t.home) || g.teams[1], neutral: g.neutral, conf: g.confGame, book: g.lines && g.lines.book, ...(p || {}), ...corr }; })
    .sort((x, y) => (x.date < y.date ? -1 : 1));
  fs.writeFileSync('data/ncaa-picks.json', JSON.stringify({ updated: new Date().toISOString(), bias: { F: +B.F.toFixed(2), C: +B.C.toFixed(2), games: B.games, days: B.days }, playbookLean: PB.lean, playbookGames: PB.games, playbook2Lean: PB2.lean, playbook2Games: PB2.games, rule: 'F and C each 5+ off the opening total, same side (A = both 8+, B = both 5+, C = average 5+ only, track-only)', games }));
  const logFile = 'data/ncaa-picks-log.json', log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : { picks: {} };
  for (const g of games) { if (g.F == null) continue; const old = log.picks[g.id]; if (old && old.result) continue;
    // keep the first-seen opener and model numbers (the bet we would have made), refresh current line
    const pbLog = { ...(g.pb ? { pbTier: g.pb.tier, pbSide: g.pb.side, pbSkip: g.pb.skip, pbUnits: g.pb.units, H: g.pb.H, C1: g.pb.C1, pbFC: g.pb.FC } : {}), ...(g.pb && g.pb.h2 ? { h2Tier: g.pb.h2.tier, h2Side: g.pb.h2.side, h2Skip: g.pb.h2.skip, h2Units: g.pb.h2.units } : {}), ...(g.pb2 ? { pb2Tier: g.pb2.tier, pb2Side: g.pb2.side, pb2Skip: g.pb2.skip, pb2Units: g.pb2.units, F2: g.pb2.F, H2: g.pb2.H } : {}) };
    log.picks[g.id] = old && old.line != null ? { ...pbLog, ...old, current: g.current } : { ...pbLog, id: g.id, day: g.day, away: g.away.abbr, home: g.home.abbr, F: g.F, C: g.C, FC: g.FC, line: g.line, open: g.open, current: g.current, side: g.side, tier: g.tier, price: g.price, po: g.po, pu: g.pu, Fc: g.Fc, Cc: g.Cc, FCc: g.FCc, logged: new Date().toISOString() }; }
  grade(log, store); log.updated = new Date().toISOString();
  fs.writeFileSync(logFile, JSON.stringify(log));
  console.log('picks: ' + games.length + ' upcoming, ' + games.filter(g => g.tier === 'A' || g.tier === 'B').length + ' rule bets | bias F ' + B.F.toFixed(2) + ' C ' + B.C.toFixed(2) + ' (' + B.games + ' games) | record ' + JSON.stringify(log.record || {}));
}
main().catch(e => { console.error(e); process.exit(1); });
