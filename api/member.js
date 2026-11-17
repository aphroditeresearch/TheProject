// The signed-in member's own things.
// GET  /api/member → their certificates and promotion status
// POST /api/member { action:'submit', lessonId, notes, homework, files:[…] }
//      → hand in notes + homework for a lesson or lesson part, or notes + mark-ups for a breakdown ('bd:<id>').
//        The item has to be unlocked for them, and its video (if any) watched to the end first.
// POST /api/member { action:'cert-add', kind:'payout'|'funded', file, note } → add a certificate to their profile
// POST /api/member { action:'cert-delete', id }                            → remove one (not while it's being used for promotion)
// POST /api/member { action:'promote-request', certId }                     → ask to be promoted to the next level with a payout certificate
// POST /api/member { action:'flag', kind }                                    → record a blocked action (right-click, dev tools, screenshot…)
// POST /api/member { action:'journal-create', rules:[…] } / { action:'journal-rules', rules:[…] } → create the journal / update its rules
// POST /api/member { action:'journal-add', entry } / { action:'journal-delete', id }             → post / remove a journal entry
// GET  /api/member?board=week|month|all → the psych leaderboard (points from journal entries)
// GET  /api/member?wins=1 → approved testimonials (+ your own, any status) and recent certified payouts members chose to share
// POST { action:'testimonial-add', rating:1-5, text, result } → a review; an admin approves it before it shows (and posts to Discord)
// POST { action:'testimonial-delete', id } → remove your own review
// GET  /api/member?stats=1 → every member's Funded/Evaluation trades and no-trade days combined, anonymous and reduced to
//                          what the Stats tab summary needs (admins get the full detail from /api/admin/members)
// GET  /api/member?pages=1 → the member's Notes pages (Notion-style: title, icon, blocks)
// POST { action:'page-save', page:{ id?, title, icon, blocks:[{ t, x, c }], pinned } } / { action:'page-delete', id } → their own pages only
// POST { action:'week-save', week:'YYYY-MM-DD' (any day), went, didnt, fix } → the weekly review (kept per Monday; empty = delete)
// GET  /api/member?feed=1[&before=<iso>] → the group feed (newest 40). Staff reading it marks posts "seen by" them.
// POST { action:'feed-post', kind:'recap'|'trade'|'win'|'plan'|'note', text, entryId?, date? } → share to the group. Trade and
//      recap posts are built from the member's own journal on the server, so numbers can't be typed in.
// POST { action:'feed-react', id, emoji } (toggle) / { action:'feed-reply', id, text } / { action:'feed-delete', id } (own, or staff)
// Files are uploaded straight from the browser to Vercel Blob first (see /api/upload), into members/<their id>/…
const crypto = require('crypto');
const { readSession, isAdmin, kvConfigured, loadProgress, json, kv, clientIp, rateLimit, staffAlert, timeoutUser } = require('./_lib');
const { logActivity, gateFor, saveSub, findItem, loadCerts, saveCert, deleteCert, loadPromo, savePromo, loadJournal, saveJournal, loadEntries, saveEntry, deleteEntry, entryPoints, entryStatus, basePoints, streakOf, nyToday, tradeDay, tradeDayOf, loadDayNotes, loadTestimonials, saveTestimonial, deleteTestimonial } = require('./_gate');
const { listMembers } = require('./_lib');
const { signAll, cleanFile } = require('./_blob');

const FLAG_KINDS = ['right-click', 'devtools-keys', 'devtools-open', 'save', 'view-source', 'print', 'screenshot'];
// only real actions count now: developer tools actually opened, and screenshot keys. The rest are still accepted from older
// pages (so nothing errors) but never alerted or counted toward a timeout.
const LIGHT_FLAGS = ['right-click', 'save', 'print', 'devtools-keys', 'view-source'];

// ---- Notes pages (Notion-style). Stored per member in pages:<uid> (id → JSON). Only the member reads or writes them. ----
const BLOCK_TYPES = ['p', 'h1', 'h2', 'todo', 'ul', 'ol', 'quote', 'callout', 'hr'];
const MAX_PAGES = 200, MAX_BLOCKS = 400;
function cleanPage(p, old) {
  p = p && typeof p === 'object' ? p : {};
  const blocks = (Array.isArray(p.blocks) ? p.blocks : []).slice(0, MAX_BLOCKS).map((b) => {
    const t = BLOCK_TYPES.includes(b && b.t) ? b.t : 'p';
    const o = { t, x: t === 'hr' ? '' : String((b && b.x) || '').slice(0, 4000) };
    if (t === 'todo') o.c = !!(b && b.c);
    return o;
  });
  const now = new Date().toISOString();
  return { id: old ? old.id : 'pg' + crypto.randomBytes(6).toString('hex'), title: String(p.title || '').trim().slice(0, 140) || 'Untitled',
    icon: String(p.icon || '').slice(0, 8), blocks, pinned: !!p.pinned, tpl: String(p.tpl || (old && old.tpl) || '').slice(0, 24),
    createdAt: old ? old.createdAt : now, updatedAt: now };
}
async function loadPages(uid) {
  const f = await kv(['HGETALL', 'pages:' + uid]); const out = [];
  const put = (v) => { try { out.push(JSON.parse(v)); } catch (e) {} };
  if (Array.isArray(f)) for (let i = 1; i < f.length; i += 2) put(f[i]); else if (f && typeof f === 'object') Object.values(f).forEach(put);
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
async function loadWeekReviews(uid) {
  const f = await kv(['HGETALL', 'weekrev:' + uid]); const out = {};
  const put = (k, v) => { try { out[k] = JSON.parse(v); } catch (e) {} };
  if (Array.isArray(f)) for (let i = 0; i < f.length; i += 2) put(f[i], f[i + 1]); else if (f && typeof f === 'object') Object.keys(f).forEach((k) => put(k, f[k]));
  return out;
}
function mondayOfDay(d) { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); }

// ---- the group feed: members choose to share a plan, recap, trade or win. Stored in feed:posts (id → JSON) + feed:order. ----
const FEED_KINDS = ['recap', 'trade', 'win', 'plan', 'note'];
const FEED_EMOJI = ['\u{1F525}', '\u{1F4AF}', '\u{1F44F}', '\u{1F9E0}', '\u{1F48E}'];
async function feedGet(id) { try { return JSON.parse((await kv(['HGET', 'feed:posts', id])) || 'null'); } catch (e) { return null; } }
async function feedPut(p) { await kv(['HSET', 'feed:posts', p.id, JSON.stringify(p)]); }
async function feedList(before, staff) {
  const ids = (await kv(['LRANGE', 'feed:order', '0', '499'])) || [];
  const out = [];
  for (const id of ids) { if (out.length >= 40) break; const p = await feedGet(id); if (!p) continue; if (before && p.at >= before) continue; out.push(p); }
  // staff reading the feed: mark each post seen by them (the "seen by" line students get)
  if (staff) { for (const p of out) { if (!p.seen || !p.seen[staff.id]) { p.seen = Object.assign({}, p.seen || {}); p.seen[staff.id] = staff.name; await feedPut(p); } } }
  return out;
}
function byEntry(a, b) { return (String(b.date) + String(b.time || '') + b.createdAt).localeCompare(String(a.date) + String(a.time || '') + a.createdAt); }
// The psych leaderboard: points from journal entries in the period (dates are the trade dates members enter)
async function leaderboard(period, me) {
  // weeks and months follow the trading day (New York), not UTC, so they don't roll over at 6–7 pm US time
  const today = nyToday();
  let from = '0000-00-00';
  if (period === 'week') { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); from = d.toISOString().slice(0, 10); }
  if (period === 'month') from = today.slice(0, 8) + '01';
  const members = await listMembers();
  const rows = [];
  await Promise.all(members.map(async (m) => {
    const j = await loadJournal(m.id); if (!j) return;
    const all = Object.values(await loadEntries(m.id));
    const ents = all.filter((e) => e.date >= from && entryStatus(e) === 'approved');   // only entries an admin approved
    const points = ents.reduce((t, e) => t + entryPoints(e), 0);
    const trades = ents.filter((e) => e.kind === 'trade');
    rows.push({ id: m.id, name: m.displayName || m.username, username: m.username, avatar: m.avatar || null, points,
      entries: ents.length, followedPct: ents.length ? Math.round(ents.filter((e) => e.followed).length / ents.length * 100) : 0,
      tps: trades.filter((e) => e.outcome === 'tp').length, trades: trades.length, me: m.id === me, streak: streakOf(all).current });
  }));
  rows.sort((a, b) => b.points - a.points || b.followedPct - a.followedPct || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return { period, from, rows };
}
// The payout leaderboard: payouts an admin has certified, added up per member (by the day of the payout)
async function payoutBoard(period, me) {
  // weeks and months follow the trading day (New York), not UTC, so they don't roll over at 6–7 pm US time
  const today = nyToday();
  let from = '0000-00-00';
  if (period === 'week') { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); from = d.toISOString().slice(0, 10); }
  if (period === 'month') from = today.slice(0, 8) + '01';
  const rows = [];
  await Promise.all((await listMembers()).map(async (m) => {
    const paid = Object.values(await loadCerts(m.id)).filter((c) => c.kind === 'payout' && c.review && c.review.status === 'approved' && String(c.paidAt || c.uploadedAt).slice(0, 10) >= from);
    if (!paid.length) return;
    const total = paid.reduce((t, c) => t + (+c.review.amount || +c.amount || 0), 0);
    const lastAt = paid.map((c) => String(c.paidAt || '')).sort().pop();
    rows.push({ id: m.id, name: m.displayName || m.username, username: m.username, avatar: m.avatar || null, total: Math.round(total * 100) / 100, payouts: paid.length, lastAt, me: m.id === me });
  }));
  rows.sort((a, b) => b.total - a.total || b.payouts - a.payouts || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return { period, from, kind: 'payout', rows };
}
// Community stats: only the fields the stats need, nothing that says whose entry it is. Cached for 2 minutes.
// students only see the combined summary (tiles, W/L/NT, R, profit factor), so only the fields it needs leave the server
const STAT_FIELDS = ['date', 'kind', 'outcome', 'pnl', 'followed', 'account', 'dir', 'risk', 'pEntry', 'pStop', 'pExit'];
// choices for the optional trade-data fields (the journal form offers the same lists)
const HTFS = ['Weekly', 'Daily', '4H', '1H', '15m'];
const LTFS = ['30s', '1m', '2m', '3m', '5m', '15m'];
const SWEPT = ['Asia high', 'Asia low', 'London high', 'London low', 'Previous day high', 'Previous day low', 'Equal highs', 'Equal lows', 'Nothing swept'];
const CONFL = ['FVG', 'Order block', 'Breaker', 'SMT divergence', 'Displacement', 'Premium / discount', 'Killzone', 'Opening range'];
const MANAGE = ['Held to target / stop', 'Took partials', 'Moved stop to BE', 'Trailed stop', 'Closed early'];
const MISTAKES = ['Entered early', 'Entered late', 'Moved stop', 'Oversized', 'Chased', 'Traded through news', 'Revenge trade', 'Overtraded'];
const GRADES = ['A+', 'A', 'B', 'C'];
const ENTRY_TYPES = ['Limit', 'Market', 'Stop', 'Internal manip'];
const EMOTIONS = ['Calm', 'Confident', 'Hesitant', 'FOMO', 'Frustrated', 'Tired'];
// One journal entry from what the page sent. Only what decides stats and points is required:
//   trades: date, result (TP/SL/BE), account, followed rules · no-trade days: date, followed rules
// Everything else (time, instrument, P&L, notes, screenshots, trade data, tags) is optional.
const CSV_LOCKED = ['kind', 'pair', 'dir', 'date', 'sunday', 'time', 'exitTime', 'contracts', 'outcome', 'pnl', 'noPnl', 'pEntry', 'pExit'];
// a hand-logged trade that a CSV row proves: same day and symbol, same P&L to the cent, and the same entry time when both have one
function csvMatches(hand, row) {
  if (hand.kind !== 'trade' || hand.src === 'csv' || hand.noPnl) return false;
  if (String(hand.sunday || hand.date) !== String(row.sunday || row.date) && hand.date !== row.date) return false;
  if (String(hand.pair || '').toUpperCase().trim() !== String(row.pair || '').toUpperCase().trim()) return false;
  if (Math.abs((+hand.pnl || 0) - (+row.pnl || 0)) > 0.005) return false;
  return !(hand.time && row.time && hand.time !== row.time);
}
function buildEntry(e, uid, old) {
  const kind = e.kind === 'none' ? 'none' : 'trade';
  const rawDate = str(e.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate) || isNaN(Date.parse(rawDate)) || Date.parse(rawDate) > Date.now() + 36 * 3600 * 1000) return { error: 'bad_date' };
  const date = tradeDay(rawDate);   // the day picked; only a Sunday date counts as Monday
  if (typeof e.followed !== 'boolean') return { error: 'missing', fields: ['followed'] };
  const files = (Array.isArray(e.files) ? e.files : []).slice(0, MAX_FILES).map((f) => cleanFile(f, uid, 'journal'));
  if (files.some((f) => !f)) return { error: 'bad_file' };
  const tags = [...new Set((Array.isArray(e.tags) ? e.tags : []).map((t) => str(t, 24).replace(/[^\w\s+&/.#-]/g, '').trim()).filter(Boolean))].slice(0, 8);
  const entry = { id: old ? old.id : 'j' + crypto.randomBytes(6).toString('hex'), kind, date, followed: e.followed, overview: str(e.overview, 4000), session: str(e.session, 40),
    createdAt: new Date().toISOString(), void: false, status: 'pending', files,
    news: ['yes', 'no'].includes(e.news) ? e.news : '', newsWhat: e.news === 'yes' ? str(e.newsWhat, 60) : '' };
  if (tags.length) entry.tags = tags;
  if (typeof e.goalKept === 'boolean') entry.goalKept = e.goalKept;   // did they keep this week's focus goal
  if (date !== rawDate) entry.sunday = rawDate;   // the Sunday it was logged on
  if (kind === 'none') return { entry };
  const num = (v) => { if (v === '' || v === null || v === undefined) return undefined; const n = Number(v); return isFinite(n) && Math.abs(n) < 1e9 ? n : undefined; };
  const pick = (v, list) => (list.includes(v) ? v : undefined);
  const many = (v, list) => { const a = Array.isArray(v) ? [...new Set(v.filter((x) => list.includes(x)))] : []; return a.length ? a : undefined; };
  Object.assign(entry, {
    time: /^\d{2}:\d{2}$/.test(str(e.time, 5)) ? str(e.time, 5) : '', pair: str(e.pair, 40), account: str(e.account, 40),
    outcome: ['tp', 'sl', 'be'].includes(e.outcome) ? e.outcome : '', model: ['BOS', 'MITIGATION', 'Chained OBs', 'DIV + OB'].includes(e.model) ? e.model : '',
  });
  const c = num(e.contracts); if (c > 0 && c <= 10000) entry.contracts = c;
  const pnl = num(e.pnl); entry.pnl = pnl === undefined ? 0 : pnl; if (pnl === undefined) entry.noPnl = true;
  const extra = {
    dir: pick(e.dir, ['long', 'short']),
    exitTime: /^\d{2}:\d{2}$/.test(str(e.exitTime, 5)) ? str(e.exitTime, 5) : undefined,
    tz: /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(str(e.tz, 60)) ? str(e.tz, 60) : undefined,
    pEntry: num(e.pEntry), pStop: num(e.pStop), pTarget: num(e.pTarget), pExit: num(e.pExit),
    risk: num(e.risk) ? Math.abs(num(e.risk)) : undefined,   // stop size is a positive amount; a minus typed in front is read as the same size
    mae: num(e.mae) >= 0 ? num(e.mae) : undefined, mfe: num(e.mfe) >= 0 ? num(e.mfe) : undefined,
    htf: pick(e.htf, HTFS), bias: pick(e.bias, ['bullish', 'bearish', 'neutral']), ltf: pick(e.ltf, LTFS),
    swept: many(e.swept, SWEPT), confl: many(e.confl, CONFL), manage: many(e.manage, MANAGE), mistakes: many(e.mistakes, MISTAKES),
    grade: pick(e.grade, GRADES), entryType: pick(e.entryType, ENTRY_TYPES), emotion: pick(e.emotion, EMOTIONS),
    acctId: /^a[0-9a-f]{10}$/.test(str(e.acctId, 12)) ? str(e.acctId, 12) : undefined,   // which prop account (Coaching → Accounts)
  };
  Object.keys(extra).forEach((k) => { if (extra[k] !== undefined) entry[k] = extra[k]; });
  const missing = ['outcome', 'account'].filter((k) => !entry[k]);
  if (missing.length) return { error: 'missing', fields: missing };
  return { entry };
}
const entryLabel = (e) => (e.kind === 'none' ? 'No-trade day' : ((e.pair || 'Trade') + ' ' + (e.outcome || '').toUpperCase() + (e.noPnl ? '' : ' ' + (e.pnl >= 0 ? '+$' : '−$') + Math.abs(e.pnl))).trim());

// The Wins tab: approved reviews, and certified payouts (cached 2 minutes; reading every member's certificates)
async function wins(uid) {
  const all = Object.values(await loadTestimonials());
  const pub = (t) => ({ id: t.id, name: t.name, avatar: t.avatar || null, rating: t.rating, text: t.text, result: t.result || '', createdAt: t.createdAt, mine: t.uid === uid });
  const testimonials = all.filter((t) => t.status === 'approved').sort((a, b) => String(b.reviewedAt || b.createdAt).localeCompare(String(a.reviewedAt || a.createdAt))).map(pub);
  const mine = all.filter((t) => t.uid === uid).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((t) => Object.assign(pub(t), { status: t.status, note: t.status === 'denied' ? t.note || '' : '' }));
  let payouts = null;
  try { const c = await kv(['GET', 'wins-cache']); if (c) payouts = JSON.parse(c); } catch (e) {}
  if (!payouts) {
    payouts = [];
    await Promise.all((await listMembers()).map(async (m) => {
      Object.values(await loadCerts(m.id)).forEach((c) => {
        if (c.kind !== 'payout' || !c.review || c.review.status !== 'approved' || c.share === false) return;
        payouts.push({ name: m.displayName || m.username, avatar: m.avatar || null, amount: Number(c.review.amount || c.amount || 0), note: c.note || '', paidAt: c.paidAt || String(c.uploadedAt || '').slice(0, 10), at: c.review.at || '' });
      });
    }));
    payouts.sort((a, b) => String(b.paidAt).localeCompare(String(a.paidAt)) || String(b.at).localeCompare(String(a.at)));   // newest payout first payouts = payouts.slice(0, 60);
    try { await kv(['SET', 'wins-cache', JSON.stringify(payouts), 'EX', 120]); } catch (e) {}
  }
  return { testimonials, mine, payouts };
}
async function communityStats() {
  try { const c = await kv(['GET', 'stats-cache']); if (c) return JSON.parse(c); } catch (e) {}
  const out = []; let members = 0;
  await Promise.all((await listMembers()).map(async (m, i) => {
    // stats only count Funded / Evaluation trades (no-trade days always count); same rule as countsInStats() in index.html
    const ents = Object.values(await loadEntries(m.id)).filter((e) => entryStatus(e) !== 'denied' && (e.kind !== 'trade' || /^(funded|evaluation)$/i.test(String(e.account || '').trim())));
    if (ents.length) members++;
    // _u: a number per journal so each student's days count separately (not who it is)
    ents.forEach((e) => { const x = { _u: i }; STAT_FIELDS.forEach((k) => { if (e[k] !== undefined) x[k] = e[k]; }); out.push(x); });
  }));
  const data = { entries: out, members, at: new Date().toISOString() };
  try { await kv(['SET', 'stats-cache', JSON.stringify(data), 'EX', 120]); } catch (e) {}
  return data;
}
// files per journal entry, and per hand-in (lecture homework, homework assignments, breakdown mark-ups); index.html matches
const MAX_FILES = 12;
const MAX_HANDIN_FILES = 20;
const MAX_ENTRIES = 5000;   // journal entries per member (about 20 years of daily journaling)
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

module.exports = async (req, res) => {
  const s = readSession(req);
  if (!s) return json(res, 401, { error: 'signed_out' });
  const uid = s.user.id;

  // blocked actions, shown against the member in Admin → Members → Flags
  if (req.method === 'POST') {
    let fb = req.body;
    if (typeof fb === 'string') { try { fb = JSON.parse(fb); } catch (e) { fb = null; } }
    if (fb && fb.action === 'flag') {
      if (!FLAG_KINDS.includes(fb.kind)) return json(res, 400, { error: 'bad_kind' });
      const ip = clientIp(req);
      if (!kvConfigured()) return json(res, 202, { recorded: false, ip });
      const key = 'flags:' + uid;
      await kv(['HINCRBY', key, fb.kind, 1]);
      await kv(['HINCRBY', key, 'total', 1]);
      await kv(['HSET', key, 'last', new Date().toISOString(), 'lastKind', fb.kind, 'lastIp', ip || '']);
      // tell staff: dev tools opened, or 5+ blocked actions inside 10 minutes. Heavy abuse = an automatic 5-minute timeout:
      // 5+ serious flags in 10 minutes, or developer tools opened twice in 30 minutes. Right-click, save and print never count.
      let timeout = null;
      if (!isAdmin(s) && !LIGHT_FLAGS.includes(fb.kind)) {
        const who = { id: uid, name: s.user.displayName || s.user.username, ip };
        const under = await rateLimit('flagburst:' + uid, 4, 600);
        // screenshots alone never time anyone out (only alert staff); developer tools opened twice in 30 minutes does
        if (fb.kind === 'devtools-open' && !(await rateLimit('dtburst:' + uid, 1, 1800))) timeout = timeout || await timeoutUser(who, 'Opened developer tools again');
        if (fb.kind === 'devtools-open') { const size = /^[\dx .z]{3,40}$/.test(String(fb.size || '')) ? String(fb.size) : '';
          await staffAlert('devtools', who, 'Opened developer tools on the site (confirmed). The portal was cleared on their screen and stays locked until they close them.' + (size ? ' Window / page size: ' + size + '.' : '')); }
        else if (!under) { const f = await kv(['HGETALL', key]); const m = {}; if (Array.isArray(f)) for (let i = 0; i < f.length; i += 2) m[f[i]] = f[i + 1];
          await staffAlert('flags', who, '5+ screenshot attempts in 10 minutes. Latest: ' + fb.kind + '. All time: ' + FLAG_KINDS.filter((k) => m[k]).map((k) => k + ' ×' + m[k]).join(', ')); }
      }
      return json(res, 200, { recorded: true, ip, timeout });
    }
  }
  if (!kvConfigured()) return json(res, 503, { error: 'no_storage' });

  if (req.method === 'GET') {
    const board = /[?&]board=(week|month|all)/.exec(req.url || '');
    if (board && /[?&]kind=payout/.test(req.url || '')) return json(res, 200, await payoutBoard(board[1], uid));
    if (board) return json(res, 200, await leaderboard(board[1], uid));
    if (/[?&]stats=1/.test(req.url || '')) return json(res, 200, await communityStats());
    if (/[?&]wins=1/.test(req.url || '')) return json(res, 200, await wins(uid));
    if (/[?&]pages=1/.test(req.url || '')) return json(res, 200, { pages: await loadPages(uid) });
    if (/[?&]feed=1/.test(req.url || '')) {
      const before = (/[?&]before=([\w:.%-]+)/.exec(req.url || '') || [])[1];
      const posts = await feedList(before ? decodeURIComponent(before) : '', isAdmin(s) ? { id: uid, name: s.user.displayName || s.user.username } : null);
      return json(res, 200, { posts, me: uid, emoji: FEED_EMOJI });
    }
    const [certs, promo, journal, entries, dayNotes, weekReviews] = await Promise.all([loadCerts(uid), loadPromo(uid), loadJournal(uid), loadEntries(uid), loadDayNotes(uid), loadWeekReviews(uid).catch(() => ({}))]);
    const list = Object.values(certs).sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
    const ents = Object.values(entries).sort(byEntry).map((e) => Object.assign({}, e, { status: entryStatus(e), points: entryPoints(e), worth: basePoints(e) }));
    await signAll(req, list.map((c) => c.file).concat(...ents.map((e) => e.files || [])), 'url');
    return json(res, 200, { certs: list, promo, journal, entries: ents, dayNotes, weekReviews });
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return json(res, 405, { error: 'method' }); }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const action = body && body.action;
  if (!(await rateLimit('member:' + uid, 300, 600))) {   // 300 actions per 10 minutes
    await staffAlert('rate-limit', { id: uid, name: s.user.displayName || s.user.username, ip: clientIp(req) }, 'Over 300 actions in 10 minutes. Last one: ' + String(action || 'unknown').slice(0, 40));
    if (!isAdmin(s)) { const t = await timeoutUser({ id: uid, name: s.user.displayName || s.user.username, ip: clientIp(req) }, 'Sent requests too fast (300+ in 10 minutes)'); if (t) return json(res, 423, Object.assign({ error: 'timeout' }, t)); };
    return json(res, 429, { error: 'slow_down' });
  }

  /* ---------- hand-in ---------- */
  if (action === 'submit') {
    const lessonId = typeof body.lessonId === 'string' ? body.lessonId : '';
    const notes = str(body.notes, 8000), homework = str(body.homework, 8000);
    if (notes.length < 20) return json(res, 400, { error: 'notes_short' });
    const admin = isAdmin(s);
    const { content, subs, access } = await gateFor(s, admin);
    // files: new uploads in the member's folder, or ones already in their earlier hand-in (those come back as signed links)
    const prevFiles = ((subs[lessonId] || {}).files || []);
    const files = [], badNames = [];
    (Array.isArray(body.files) ? body.files : []).slice(0, MAX_HANDIN_FILES).forEach((f) => {
      const ok = cleanFile(f, uid, 'homework')
        || prevFiles.find((p) => f && p.url && typeof f.url === 'string' && f.url.split('?')[0] === p.url)
        || prevFiles.find((p) => f && p.name && p.name === f.name && (+p.size || 0) === (+f.size || 0));
      if (ok) files.push(ok); else badNames.push(String((f && f.name) || 'a file').slice(0, 80));
    });
    if (badNames.length) return json(res, 400, { error: 'bad_file', files: badNames });
    if (homework.length < 20 && !files.length) return json(res, 400, { error: 'homework_short' });

    const found = findItem(content, lessonId);
    if (!found) return json(res, 404, { error: 'no_lesson' });
    if (!access.all[lessonId] || !access.all[lessonId].open) return json(res, 403, { error: 'locked' });
    const skippable = found.kind === 'breakdown' && (found.item || {}).kind !== 'advanced';   // breakdowns can be handed in without watching to the end
    if (found.video && !admin && !skippable) {
      const prog = await loadProgress(uid);
      if (!prog[lessonId]) return json(res, 409, { error: 'watch_first' });
    }
    const prev = subs[lessonId];
    if (prev && prev.status === 'approved') return json(res, 409, { error: 'already_approved' });
    const now = new Date().toISOString();
    const sub = {
      notes, homework, files, status: 'submitted', submittedAt: now,
      firstSubmittedAt: (prev && prev.firstSubmittedAt) || now, attempts: ((prev && prev.attempts) || 0) + 1,
      feedback: prev && prev.status === 'returned' ? prev.feedback || '' : '', reviewedAt: null, reviewer: null,
    };
    await saveSub(uid, lessonId, sub);
    const it = found.item || {}, label = found.kind === 'part' ? (found.lesson.title + ' · ' + it.title) : found.kind === 'breakdown' && it.kind === 'advanced' ? 'Advanced · ' + it.title : it.title;
    await logActivity(s.user, { type: 'handin', key: lessonId, what: found.kind === 'homework' ? 'homework' : found.kind === 'breakdown' ? (it.kind === 'advanced' ? 'advanced' : 'breakdown') : 'lesson', label: label || lessonId, again: !!prev });
    return json(res, 200, { saved: true, sub, unlockMode: content.settings.unlockMode });
  }

  /* ---------- journal ---------- */
  if (action === 'journal-create' || action === 'journal-rules') {
    const rules = (Array.isArray(body.rules) ? body.rules : []).map((r) => str(r, 300)).filter((r) => r.length >= 3).slice(0, 25);
    if (!rules.length) return json(res, 400, { error: 'need_rules' });
    const prev = await loadJournal(uid);
    if (action === 'journal-create' && prev) return json(res, 409, { error: 'already_created' });
    if (action === 'journal-rules' && !prev) return json(res, 404, { error: 'no_journal' });
    const now = new Date().toISOString();
    const j = { rules: rules.map((t, i) => ({ id: 'r' + (i + 1), text: t })), createdAt: (prev && prev.createdAt) || now, updatedAt: now };
    await saveJournal(uid, j);
    return json(res, 200, { saved: true, journal: j });
  }
  if (action === 'journal-add' || action === 'journal-edit') {
    const j = await loadJournal(uid);
    if (!j) return json(res, 409, { error: 'no_journal' });
    const entries = await loadEntries(uid);
    const old = action === 'journal-edit' ? entries[String(body.id || '')] : null;
    if (action === 'journal-edit' && !old) return json(res, 404, { error: 'not_found' });   // only your own entries
    if (!old && Object.keys(entries).length >= MAX_ENTRIES) return json(res, 409, { error: 'journal_full' });
    const built = buildEntry(body.entry || {}, uid, old);
    if (built.error) return json(res, 400, built);
    const entry = built.entry;
    // a CSV trade's numbers came from the broker, so they stay as imported: that's what ✓ Verified means
    if (old && old.src === 'csv') CSV_LOCKED.forEach((k) => { if (old[k] !== undefined && old[k] !== null && old[k] !== '') entry[k] = old[k]; });
    if (entry.kind === 'none' && Object.values(entries).some((x) => x.kind === 'none' && x.date === entry.date && x.id !== entry.id)) return json(res, 409, { error: 'none_exists' });
    if (old) {
      // editing keeps the review, unless something that decides points changed: then it goes back to the mentor
      const was = Object.assign({}, old, { date: tradeDay(old.sunday || old.date) });   // as it's shown now (entries the old evening rule moved are back on their day)
      const keyChanged = ['kind', 'date', 'outcome', 'account', 'followed'].some((k) => String(was[k] === undefined ? '' : was[k]) !== String(entry[k] === undefined ? '' : entry[k]));
      ['createdAt', 'status', 'void', 'awarded', 'reviewedAt', 'reviewedBy', 'reviewNote', 'src', 'importKey', 'verifiedAt', 'movedFrom', 'acctName', 'copies', 'copyTotal'].forEach((k) => { if (old[k] !== undefined) entry[k] = old[k]; });
      if (keyChanged && entryStatus(old) !== 'pending') { entry.status = 'pending'; entry.void = false; delete entry.awarded; delete entry.reviewedAt; delete entry.reviewedBy; delete entry.reviewNote; entry.reopened = true; }
      entry.editedAt = new Date().toISOString();
    }
    await saveEntry(uid, entry);
    await logActivity(s.user, { type: 'journal', key: entry.id, date: entry.date, label: (old ? 'Edited · ' : '') + entryLabel(entry) });
    return json(res, 200, { saved: true, entry: Object.assign({}, entry, { points: entryPoints(entry), worth: basePoints(entry) }) });
  }
  // many trades at once from a broker / platform CSV (the page parses the file; each row is checked like a normal entry)
  if (action === 'journal-import') {
    const j = await loadJournal(uid);
    if (!j) return json(res, 409, { error: 'no_journal' });
    const rows = (Array.isArray(body.entries) ? body.entries : []).slice(0, 200);
    const entries = await loadEntries(uid), seen = new Set(Object.values(entries).map((x) => x.importKey).filter(Boolean));
    let added = 0, dupes = 0, bad = 0, verified = 0, moved = 0, copied = 0, room = MAX_ENTRIES - Object.keys(entries).length; const writes = new Map(), upgraded = new Set();
    if (room <= 0) return json(res, 409, { error: 'journal_full' });
    for (const r of rows) {
      const built = buildEntry(Object.assign({}, r, { kind: 'trade' }), uid, null);
      if (built.error) { bad++; continue; }
      const e = built.entry; e.src = 'csv'; delete e.calDate; delete e.asia;
      e.importKey = [e.date, e.time || '', e.exitTime || '', (e.pair || '').toUpperCase(), e.pnl, e.contracts || ''].join('|');
      // copy trading: the same trade on another account (same day, times, instrument and side) is added to that trade as a copy,
      // not a new entry. Stats and points count the trade once (its first account's P&L); copyTotal is the money across all accounts.
      const an = str(r.acctName, 40); if (an) e.acctName = an;
      if (an) {
        const sig = (x) => [x.date, x.time || '', x.exitTime || '', String(x.pair || '').toUpperCase(), x.dir || ''].join('|');
        const mate = Object.values(entries).find((x) => x.kind === 'trade' && x.src === 'csv' && sig(x) === sig(e));
        if (mate) {
          const up = Object.assign({}, mate);
          if (!up.acctName) up.acctName = an;   // imported before accounts were read: that copy was this account
          const list = Array.isArray(up.copies) && up.copies.length ? up.copies.slice() : [{ a: up.acctName, pnl: +up.pnl || 0, q: up.contracts || 0 }];
          if (list.some((c) => c.a === an)) { if (up.acctName !== mate.acctName) { entries[up.id] = up; writes.set(up.id, up); } dupes++; continue; }
          if (list.length >= 30) { bad++; continue; }
          list.push({ a: an, pnl: +e.pnl || 0, q: e.contracts || 0 });
          up.copies = list; up.copyTotal = Math.round(list.reduce((t, c) => t + (+c.pnl || 0), 0) * 100) / 100;
          entries[up.id] = up; writes.set(up.id, up); seen.add(e.importKey); copied++; continue;
        }
      }
      if (seen.has(e.importKey)) { dupes++; continue; }
      // an Asia-session trade imported before this rule sits on its calendar day: move that entry to the trading day it belongs to
      // (everything else about it, notes and review included, stays exactly as it is) instead of adding a second copy
      const cal = /^\d{4}-\d{2}-\d{2}$/.test(String(r.calDate || '')) ? String(r.calDate) : '';
      if (cal && cal !== e.date) {
        const legacy = [cal].concat(e.importKey.split('|').slice(1)).join('|');
        const prev = Object.values(entries).find((x) => x.importKey === legacy && !upgraded.has(x.id));
        if (prev) {
          const up = Object.assign({}, prev, { date: e.date, importKey: e.importKey, movedFrom: cal }); delete up.sunday;
          if (an && !up.acctName) up.acctName = an;
          upgraded.add(prev.id); seen.add(e.importKey); entries[up.id] = up; writes.set(up.id, up); moved++; continue;
        }
      }
      // already logged by hand: verify that entry instead of adding a second copy. Notes, screenshots, tags and review are kept;
      // only blanks are filled from the CSV
      const hand = Object.values(entries).find((x) => !upgraded.has(x.id) && csvMatches(x, e));
      if (hand) {
        const up = Object.assign({}, hand, { src: 'csv', importKey: e.importKey, verifiedAt: new Date().toISOString() });
        ['dir', 'time', 'exitTime', 'contracts', 'pEntry', 'pExit'].forEach((k) => { if ((up[k] === undefined || up[k] === '') && e[k] !== undefined) up[k] = e[k]; });
        if (an) up.acctName = an;
        upgraded.add(hand.id); seen.add(e.importKey); entries[up.id] = up; writes.set(up.id, up); verified++; continue;
      }
      if (added >= room) { bad++; continue; }
      seen.add(e.importKey); entries[e.id] = e; writes.set(e.id, e); added++;
    }
    const fields = []; writes.forEach((v, k) => fields.push(k, JSON.stringify(v)));
    if (fields.length) await kv(['HSET', 'jentries:' + uid].concat(fields));   // one write for the whole file
    if (added || verified || moved || copied) await logActivity(s.user, { type: 'journal', key: 'import', label: 'Imported ' + added + (added === 1 ? ' trade' : ' trades') + ' from a CSV' + (verified ? ' · verified ' + verified + ' logged by hand' : '') + (copied ? ' · ' + copied + ' copy-trade ' + (copied === 1 ? 'account' : 'accounts') : '') });
    return json(res, 200, { saved: true, added, dupes, bad, verified, moved, copied });
  }
  // a note for one day: the plan before the session and the recap after (TradeZella-style daily journal)
  if (action === 'feed-post') {
    const kind = FEED_KINDS.includes(body.kind) ? body.kind : 'note', text = str(body.text, 1500);
    const p = { id: 'f' + crypto.randomBytes(6).toString('hex'), uid, name: s.user.displayName || s.user.username, avatar: s.user.avatar || null,
      kind, text, at: new Date().toISOString(), reactions: {}, replies: [], seen: {} };
    if (kind === 'trade' || kind === 'win') {
      const e = (await loadEntries(uid))[str(body.entryId, 40)];
      if (e && e.kind === 'trade') p.snap = { date: e.date, pair: String(e.pair || '').toUpperCase().slice(0, 12), dir: e.dir || '', outcome: e.outcome || '', pnl: e.noPnl ? null : (+e.pnl || 0), verified: e.src === 'csv', account: String(e.account || '').slice(0, 30) };
      else if (kind === 'trade') return json(res, 404, { error: 'no_entry' });
    }
    if (kind === 'recap' || kind === 'plan') {
      const d = tradeDay(str(body.date, 10)); const n = (await loadDayNotes(uid))[d];
      const t = n && String(kind === 'recap' ? n.recap : n.plan || '').trim(); if (!t) return json(res, 404, { error: 'nothing_written' });
      p.text = (text ? text + '\n\n' : '') + t.slice(0, 1500); p.snap = { date: d };
      const tr = Object.values(await loadEntries(uid)).filter((e) => e.date === d && e.kind === 'trade' && entryStatus(e) !== 'denied' && /^(funded|evaluation)$/i.test(String(e.account || '').trim()));   // same rule as the stats
      if (kind === 'recap' && tr.length) { p.snap.n = tr.length; p.snap.pnl = tr.reduce((a, e) => a + (+e.pnl || 0), 0); }
    }
    if (!p.text && !p.snap) return json(res, 400, { error: 'empty' });
    if (p.text.length < 2 && kind === 'note') return json(res, 400, { error: 'empty' });
    await feedPut(p); await kv(['LPUSH', 'feed:order', p.id]); await kv(['LTRIM', 'feed:order', '0', '499']);
    return json(res, 200, { saved: true, post: p });
  }
  if (action === 'feed-react' || action === 'feed-reply' || action === 'feed-delete') {
    const p = await feedGet(str(body.id, 20)); if (!p) return json(res, 404, { error: 'no_post' });
    if (action === 'feed-delete') {
      if (p.uid !== uid && !isAdmin(s)) return json(res, 403, { error: 'not_yours' });
      await kv(['HDEL', 'feed:posts', p.id]); await kv(['LREM', 'feed:order', '0', p.id]); return json(res, 200, { saved: true });
    }
    if (action === 'feed-react') {
      const em = FEED_EMOJI.includes(body.emoji) ? body.emoji : null; if (!em) return json(res, 400, { error: 'bad_emoji' });
      const list = (p.reactions[em] || []).slice(); const i = list.indexOf(uid); if (i >= 0) list.splice(i, 1); else list.push(uid);
      if (list.length) p.reactions[em] = list; else delete p.reactions[em];
    } else {
      const t = str(body.text, 600); if (!t) return json(res, 400, { error: 'empty' });
      if ((p.replies || []).length >= 60) return json(res, 409, { error: 'too_many' });
      p.replies = (p.replies || []).concat([{ id: 'r' + crypto.randomBytes(4).toString('hex'), uid, name: s.user.displayName || s.user.username, avatar: s.user.avatar || null, text: t, at: new Date().toISOString(), staff: isAdmin(s) }]);
    }
    await feedPut(p); return json(res, 200, { saved: true, post: p });
  }
  if (action === 'page-save') {
    const p = body.page || {}, id = typeof p.id === 'string' && /^pg[0-9a-f]{12}$/.test(p.id) ? p.id : '';
    let old = null; if (id) { try { old = JSON.parse((await kv(['HGET', 'pages:' + uid, id])) || 'null'); } catch (e) {} if (!old) return json(res, 404, { error: 'no_page' }); }
    if (!old && Number(await kv(['HLEN', 'pages:' + uid])) >= MAX_PAGES) return json(res, 409, { error: 'too_many' });
    const page = cleanPage(p, old), raw = JSON.stringify(page);
    if (raw.length > 120000) return json(res, 413, { error: 'too_big' });
    await kv(['HSET', 'pages:' + uid, page.id, raw]);
    return json(res, 200, { saved: true, page });
  }
  if (action === 'page-delete') {
    const id = String(body.id || ''); if (!/^pg[0-9a-f]{12}$/.test(id)) return json(res, 400, { error: 'bad_id' });
    await kv(['HDEL', 'pages:' + uid, id]);
    return json(res, 200, { saved: true });
  }
  if (action === 'week-save') {
    const d = str(body.week, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return json(res, 400, { error: 'bad_date' });
    const wk = mondayOfDay(d), r = { went: str(body.went, 3000), didnt: str(body.didnt, 3000), fix: str(body.fix, 1000), updatedAt: new Date().toISOString() };
    if (!r.went && !r.didnt && !r.fix) await kv(['HDEL', 'weekrev:' + uid, wk]);
    else await kv(['HSET', 'weekrev:' + uid, wk, JSON.stringify(r)]);
    return json(res, 200, { saved: true, week: wk, review: r });
  }
  if (action === 'daynote-save') {
    const date = tradeDay(str(body.date, 10));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: 'bad_date' });
    // an older Sunday note was shown merged into this Monday, so what's saved now replaces both
    const sun = new Date(date + 'T12:00:00Z'); sun.setUTCDate(sun.getUTCDate() - 1);
    if (sun.getUTCDay() === 0) await kv(['HDEL', 'daynotes:' + uid, sun.toISOString().slice(0, 10)]);
    const note = { plan: str(body.plan, 3000), recap: str(body.recap, 3000), mood: ['great', 'good', 'ok', 'rough', 'bad'].includes(body.mood) ? body.mood : '', updatedAt: new Date().toISOString() };
    if (note.plan || note.recap || note.mood) { const [n, has] = await Promise.all([kv(['HLEN', 'daynotes:' + uid]), kv(['HEXISTS', 'daynotes:' + uid, date])]);
      if (!Number(has) && Number(n) >= 3000) return json(res, 409, { error: 'too_many' }); }
    if (!note.plan && !note.recap && !note.mood) await kv(['HDEL', 'daynotes:' + uid, date]);
    else await kv(['HSET', 'daynotes:' + uid, date, JSON.stringify(note)]);
    return json(res, 200, { saved: true, note });
  }
  if (action === 'journal-delete') {
    const entries = await loadEntries(uid);
    const e = entries[String(body.id || '')];
    if (!e) return json(res, 404, { error: 'no_entry' });
    if (entryStatus(e) === 'approved') return json(res, 409, { error: 'approved' });                    // approved entries stay on the record
    if (Date.now() - Date.parse(e.createdAt) > 7 * 864e5) return json(res, 409, { error: 'too_old' });   // a week to fix mistakes
    await deleteEntry(uid, e.id);
    try { await kv(['DEL', 'stats-cache']); } catch (err) {}
    return json(res, 200, { saved: true });
  }

  /* ---------- certificates ---------- */
  if (action === 'testimonial-add') {
    const rating = Math.round(Number(body.rating));
    const text = str(body.text, 1200), result = str(body.result, 120);
    if (!(rating >= 1 && rating <= 5)) return json(res, 400, { error: 'need_rating' });
    if (text.length < 30) return json(res, 400, { error: 'too_short' });
    const mineT = Object.values(await loadTestimonials()).filter((t) => t.uid === uid);
    if (mineT.some((t) => t.status === 'pending')) return json(res, 409, { error: 'pending_exists' });
    if (mineT.length >= 5) return json(res, 409, { error: 'too_many' });
    const t = { id: 't' + crypto.randomBytes(6).toString('hex'), uid, name: s.user.displayName || s.user.username, avatar: s.user.avatar || null,
      rating, text, result, status: 'pending', createdAt: new Date().toISOString() };
    await saveTestimonial(t);
    await logActivity(s.user, { type: 'review', key: t.id, label: 'Testimonial ' + '★'.repeat(rating) });
    return json(res, 200, { saved: true, testimonial: t });
  }
  if (action === 'testimonial-delete') {
    const t = (await loadTestimonials())[String(body.id || '')];
    if (!t || t.uid !== uid) return json(res, 404, { error: 'not_found' });
    await deleteTestimonial(t.id);
    return json(res, 200, { saved: true });
  }
  if (action === 'cert-add') {
    const kind = body.kind === 'funded' ? 'funded' : body.kind === 'payout' ? 'payout' : null;
    const file = cleanFile(body.file, uid, 'certs');
    if (!kind) return json(res, 400, { error: 'bad_kind' });
    if (!file) return json(res, 400, { error: 'bad_file' });
    const certs = await loadCerts(uid);
    if (Object.keys(certs).length >= 60) return json(res, 409, { error: 'too_many' });
    const cert = { id: 'c' + crypto.randomBytes(6).toString('hex'), kind, file, note: str(body.note, 300), uploadedAt: new Date().toISOString(),
      // payouts: shared on the Wins tab and in the Discord payouts channel once certified, unless the member says no;
      // the certificate image is only posted if they tick that box (certificates can show account details)
      share: body.share !== false, shareImage: body.shareImage === true };
    if (kind === 'payout') {
      // the amount and day of the payout; an admin certifies it before it counts on the payout leaderboard
      const amount = Math.round(Number(body.amount) * 100) / 100;
      if (!(amount > 0 && amount < 10000000)) return json(res, 400, { error: 'need_amount' });
      const paidAt = /^\d{4}-\d{2}-\d{2}$/.test(str(body.paidAt, 10)) ? str(body.paidAt, 10) : nyToday();
      Object.assign(cert, { amount, paidAt, review: { status: 'pending' } });
    }
    await saveCert(uid, cert);
    await logActivity(s.user, { type: 'cert', key: cert.id, kind, label: kind === 'payout' ? 'Payout $' + cert.amount.toLocaleString('en-US') : 'Funded certificate' });
    return json(res, 200, { saved: true, cert });
  }
  if (action === 'cert-delete') {
    const id = String(body.id || '');
    if (!(await loadCerts(uid))[id]) return json(res, 404, { error: 'not_found' });   // only your own certificates exist here
    const promo = await loadPromo(uid);
    if (promo && promo.certId === id && promo.status !== 'declined') return json(res, 409, { error: 'in_use' });
    const mine = (await loadCerts(uid))[id];
    if (mine && mine.review && mine.review.status === 'approved') return json(res, 409, { error: 'certified' });   // certified payouts stay on the record
    await deleteCert(uid, id);
    return json(res, 200, { saved: true });
  }

  /* ---------- promotion ---------- */
  if (action === 'promote-request') {
    const { access } = await gateFor(s, false);
    if (!access.canPromote) return json(res, 403, { error: 'not_ready' });
    const certs = await loadCerts(uid);
    const cert = certs[String(body.certId || '')];
    if (!cert || cert.kind !== 'payout') return json(res, 400, { error: 'need_payout' });
    const prev = await loadPromo(uid);
    if (prev && prev.status === 'requested') return json(res, 409, { error: 'already_requested' });
    const promo = { status: 'requested', certId: cert.id, requestedAt: new Date().toISOString(), decidedAt: null, decidedBy: null, note: '' };
    await savePromo(uid, promo);
    await logActivity(s.user, { type: 'promo', key: cert.id, label: 'Promotion request' });
    return json(res, 200, { saved: true, promo });
  }

  json(res, 400, { error: 'bad_action' });
};

module.exports = require('./_lib').guard(module.exports, 'json');
