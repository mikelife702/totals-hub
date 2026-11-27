// Small test of The Odds API (uses only a few credits). Reads the key from the ODDS_API_KEY secret; never prints it.
// Checks: key works + credits left; which historical markets exist for a college game; a halftime snapshot of 2nd-half lines.
import fs from 'node:fs';
const KEY = process.env.ODDS_API_KEY;
if (!KEY) { console.log('No ODDS_API_KEY secret found.'); process.exit(1); }
const HOST = 'https://api.the-odds-api.com';
const report = { when: new Date().toISOString(), steps: [] };
async function call(label, path, params) {
  const q = new URLSearchParams({ ...params, apiKey: KEY });
  const r = await fetch(HOST + path + '?' + q.toString());
  const used = r.headers.get('x-requests-used'), left = r.headers.get('x-requests-remaining'), last = r.headers.get('x-requests-last');
  let body = null; try { body = await r.json(); } catch (e) { }
  const step = { label, status: r.status, creditsThisCall: last, creditsUsed: used, creditsLeft: left };
  report.steps.push(step);
  console.log(label + ' → HTTP ' + r.status + ' | this call ' + last + ' credits | left ' + left);
  return { status: r.status, body, step };
}
const sports = await call('1) list sports (free)', '/v4/sports', {});
const ncaab = (sports.body || []).find(s => s.key === 'basketball_ncaab');
report.ncaab = ncaab || null;
console.log('   college basketball key present: ' + !!ncaab);

// 2) historical events on a busy day last season (Saturday Feb 7, 2026, 17:00 UTC = noon ET)
const day = '2026-02-07T17:00:00Z';
const ev = await call('2) historical events list', '/v4/historical/sports/basketball_ncaab/events', { date: day });
const events = (ev.body && ev.body.data) || [];
report.eventsFound = events.length;
console.log('   events found: ' + events.length);
const e = events.find(x => /Duke|Kansas|Kentucky|Gonzaga|Houston|Michigan/.test(x.home_team + x.away_team)) || events[0];
if (!e) { fs.writeFileSync('data/odds-test.json', JSON.stringify(report, null, 1)); process.exit(0); }
report.sampleEvent = { id: e.id, home: e.home_team, away: e.away_team, commence: e.commence_time };
console.log('   sample game: ' + e.away_team + ' @ ' + e.home_team + ' ' + e.commence_time);

// 3) which markets exist historically for that game (pregame snapshot)
const pre = new Date(Date.parse(e.commence_time) - 30 * 60e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
const mk = await call('3) historical event markets (pregame)', '/v4/historical/sports/basketball_ncaab/events/' + e.id + '/markets', { date: pre, regions: 'us' });
const books = (mk.body && mk.body.data && mk.body.data.bookmakers) || [];
const mset = {}; books.forEach(b => (b.markets || []).forEach(m => { mset[m.key] = (mset[m.key] || 0) + 1; }));
report.pregameMarkets = mset; console.log('   pregame markets (books offering): ' + JSON.stringify(mset));

// 4) halftime snapshot: ~70 minutes after tip, 2nd-half total + live full-game total
const ht = new Date(Date.parse(e.commence_time) + 70 * 60e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
const mk2 = await call('4a) historical event markets (halftime)', '/v4/historical/sports/basketball_ncaab/events/' + e.id + '/markets', { date: ht, regions: 'us' });
const books2 = (mk2.body && mk2.body.data && mk2.body.data.bookmakers) || [];
const mset2 = {}; books2.forEach(b => (b.markets || []).forEach(m => { mset2[m.key] = (mset2[m.key] || 0) + 1; }));
report.halftimeMarkets = mset2; console.log('   halftime markets (books offering): ' + JSON.stringify(mset2));
if (mset2.totals_h2 || mset2.totals) {
  const od = await call('4b) historical event odds at halftime (totals, totals_h2)', '/v4/historical/sports/basketball_ncaab/events/' + e.id + '/odds', { date: ht, regions: 'us', markets: ['totals', 'totals_h2'].filter(k => mset2[k]).join(','), oddsFormat: 'american' });
  const d = od.body && od.body.data;
  report.halftimeOdds = d ? (d.bookmakers || []).map(b => ({ book: b.title, updated: b.last_update, markets: (b.markets || []).map(m => ({ key: m.key, updated: m.last_update, outcomes: m.outcomes })) })) : null;
  report.snapshotTime = od.body && od.body.timestamp;
  console.log('   snapshot time: ' + report.snapshotTime);
  (report.halftimeOdds || []).slice(0, 6).forEach(b => b.markets.forEach(m => console.log('   ' + b.book + ' ' + m.key + ' ' + m.outcomes.map(o => o.name + ' ' + o.point + ' (' + o.price + ')').join(' / '))));
}
fs.writeFileSync('data/odds-test.json', JSON.stringify(report, null, 1));
console.log('saved data/odds-test.json');
