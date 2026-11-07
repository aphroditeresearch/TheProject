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
// Files are uploaded straight from the browser to Vercel Blob first (see /api/upload), into members/<their id>/…
const crypto = require('crypto');
const { readSession, isAdmin, kvConfigured, loadProgress, json, kv, clientIp } = require('./_lib');
const { logActivity, gateFor, saveSub, findItem, loadCerts, saveCert, deleteCert, loadPromo, savePromo, loadJournal, saveJournal, loadEntries, saveEntry, deleteEntry, entryPoints, entryStatus, basePoints, streakOf, loadTestimonials, saveTestimonial, deleteTestimonial } = require('./_gate');
const { listMembers } = require('./_lib');
const { signAll, cleanFile } = require('./_blob');

const FLAG_KINDS = ['right-click', 'devtools-keys', 'devtools-open', 'save', 'view-source', 'print', 'screenshot'];
function byEntry(a, b) { return (String(b.date) + String(b.time || '') + b.createdAt).localeCompare(String(a.date) + String(a.time || '') + a.createdAt); }
// The psych leaderboard: points from journal entries in the period (dates are the trade dates members enter)
async function leaderboard(period, me) {
  const today = new Date(); const ymd = (d) => d.toISOString().slice(0, 10);
  let from = '0000-00-00';
  if (period === 'week') { const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); from = ymd(d); }
  if (period === 'month') from = ymd(today).slice(0, 8) + '01';
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
  const today = new Date(); const ymd = (d) => d.toISOString().slice(0, 10);
  let from = '0000-00-00';
  if (period === 'week') { const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); from = ymd(d); }
  if (period === 'month') from = ymd(today).slice(0, 8) + '01';
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
const ENTRY_TYPES = ['Limit', 'Market', 'Stop'];
const EMOTIONS = ['Calm', 'Confident', 'Hesitant', 'FOMO', 'Frustrated', 'Tired'];
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
    payouts.sort((a, b) => String(b.at).localeCompare(String(a.at))); payouts = payouts.slice(0, 60);
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
// screenshots / files per hand-in or journal entry (index.html uses the same number)
const MAX_FILES = 12;
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
      return json(res, 200, { recorded: true, ip });
    }
  }
  if (!kvConfigured()) return json(res, 503, { error: 'no_storage' });

  if (req.method === 'GET') {
    const board = /[?&]board=(week|month|all)/.exec(req.url || '');
    if (board && /[?&]kind=payout/.test(req.url || '')) return json(res, 200, await payoutBoard(board[1], uid));
    if (board) return json(res, 200, await leaderboard(board[1], uid));
    if (/[?&]stats=1/.test(req.url || '')) return json(res, 200, await communityStats());
    if (/[?&]wins=1/.test(req.url || '')) return json(res, 200, await wins(uid));
    const [certs, promo, journal, entries] = await Promise.all([loadCerts(uid), loadPromo(uid), loadJournal(uid), loadEntries(uid)]);
    const list = Object.values(certs).sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
    const ents = Object.values(entries).sort(byEntry).map((e) => Object.assign({}, e, { status: entryStatus(e), points: entryPoints(e), worth: basePoints(e) }));
    await signAll(req, list.map((c) => c.file).concat(...ents.map((e) => e.files || [])), 'url');
    return json(res, 200, { certs: list, promo, journal, entries: ents });
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return json(res, 405, { error: 'method' }); }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const action = body && body.action;

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
    (Array.isArray(body.files) ? body.files : []).slice(0, MAX_FILES).forEach((f) => {
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
  if (action === 'journal-add') {
    const j = await loadJournal(uid);
    if (!j) return json(res, 409, { error: 'no_journal' });
    const e = body.entry || {};
    const kind = e.kind === 'none' ? 'none' : 'trade';
    const date = str(e.date, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date)) || Date.parse(date) > Date.now() + 36 * 3600 * 1000) return json(res, 400, { error: 'bad_date' });
    if (typeof e.followed !== 'boolean') return json(res, 400, { error: 'need_followed' });
    const overview = str(e.overview, 4000);
    const entry = { id: 'j' + crypto.randomBytes(6).toString('hex'), kind, date, followed: e.followed, overview, session: str(e.session, 40), createdAt: new Date().toISOString(), void: false, status: 'pending',
      news: ['yes', 'no'].includes(e.news) ? e.news : '', newsWhat: e.news === 'yes' ? str(e.newsWhat, 60) : '' };   // high-impact news that day (for the stats)
    const entries = await loadEntries(uid);
    if (kind === 'none') {
      if (overview.length < 10) return json(res, 400, { error: 'overview_short' });
      if (!entry.session) return json(res, 400, { error: 'need_session' });
      if (Object.values(entries).some((x) => x.kind === 'none' && x.date === date)) return json(res, 409, { error: 'none_exists' });
      // screenshots are optional on a no-trade day (mark-ups / price action)
      entry.files = (Array.isArray(e.files) ? e.files : []).slice(0, MAX_FILES).map((f) => cleanFile(f, uid, 'journal'));
      if (entry.files.some((f) => !f)) return json(res, 400, { error: 'bad_file' });
    } else {
      Object.assign(entry, {
        time: /^\d{2}:\d{2}$/.test(str(e.time, 5)) ? str(e.time, 5) : '', pair: str(e.pair, 40), account: str(e.account, 40),
        contracts: Number(e.contracts), outcome: ['tp', 'sl', 'be'].includes(e.outcome) ? e.outcome : '', pnl: Number(e.pnl), model: ['BOS', 'MITIGATION', 'Chained OBs', 'DIV + OB'].includes(e.model) ? e.model : '',
        files: (Array.isArray(e.files) ? e.files : []).slice(0, MAX_FILES).map((f) => cleanFile(f, uid, 'journal')),
      });
      // optional trade data (for the stats and the research export); anything left blank is simply not stored
      const num = (v) => { if (v === '' || v === null || v === undefined) return undefined; const n = Number(v); return isFinite(n) && Math.abs(n) < 1e9 ? n : undefined; };
      const pick = (v, list) => (list.includes(v) ? v : undefined);
      const many = (v, list) => { const a = Array.isArray(v) ? [...new Set(v.filter((x) => list.includes(x)))] : []; return a.length ? a : undefined; };
      const extra = {
        dir: pick(e.dir, ['long', 'short']),
        exitTime: /^\d{2}:\d{2}$/.test(str(e.exitTime, 5)) ? str(e.exitTime, 5) : undefined,
        tz: /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(str(e.tz, 60)) ? str(e.tz, 60) : undefined,
        pEntry: num(e.pEntry), pStop: num(e.pStop), pTarget: num(e.pTarget), pExit: num(e.pExit),
        risk: num(e.risk) > 0 ? num(e.risk) : undefined,
        mae: num(e.mae) >= 0 ? num(e.mae) : undefined, mfe: num(e.mfe) >= 0 ? num(e.mfe) : undefined,
        htf: pick(e.htf, HTFS), bias: pick(e.bias, ['bullish', 'bearish', 'neutral']), ltf: pick(e.ltf, LTFS),
        swept: many(e.swept, SWEPT), confl: many(e.confl, CONFL), manage: many(e.manage, MANAGE), mistakes: many(e.mistakes, MISTAKES),
        grade: pick(e.grade, GRADES), entryType: pick(e.entryType, ENTRY_TYPES), emotion: pick(e.emotion, EMOTIONS),
      };
      Object.keys(extra).forEach((k) => { if (extra[k] !== undefined) entry[k] = extra[k]; });
      const missing = ['time', 'pair', 'account', 'session', 'outcome', 'model'].filter((k) => !entry[k]);
      if (!(entry.contracts > 0 && entry.contracts <= 10000)) missing.push('contracts');
      if (!isFinite(entry.pnl) || e.pnl === '' || e.pnl === null) missing.push('pnl');
      if (overview.length < 20) missing.push('overview');
      if (missing.length) return json(res, 400, { error: 'missing', fields: missing });
      if (!entry.files.length || entry.files.some((f) => !f)) return json(res, 400, { error: 'need_files' });
    }
    await saveEntry(uid, entry);
    await logActivity(s.user, { type: 'journal', key: entry.id, date: entry.date, label: kind === 'none' ? 'No-trade day' : entry.pair + ' ' + (entry.outcome || '').toUpperCase() + ' ' + (entry.pnl >= 0 ? '+$' : '−$') + Math.abs(entry.pnl) });
    return json(res, 200, { saved: true, entry: Object.assign({}, entry, { points: entryPoints(entry), worth: basePoints(entry) }) });
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
      const paidAt = /^\d{4}-\d{2}-\d{2}$/.test(str(body.paidAt, 10)) ? str(body.paidAt, 10) : new Date().toISOString().slice(0, 10);
      Object.assign(cert, { amount, paidAt, review: { status: 'pending' } });
    }
    await saveCert(uid, cert);
    await logActivity(s.user, { type: 'cert', key: cert.id, kind, label: kind === 'payout' ? 'Payout $' + cert.amount.toLocaleString('en-US') : 'Funded certificate' });
    return json(res, 200, { saved: true, cert });
  }
  if (action === 'cert-delete') {
    const id = String(body.id || '');
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
