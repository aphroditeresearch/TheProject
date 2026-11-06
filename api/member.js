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
// Files are uploaded straight from the browser to Vercel Blob first (see /api/upload), into members/<their id>/…
const crypto = require('crypto');
const { readSession, isAdmin, kvConfigured, loadProgress, json, kv, clientIp } = require('./_lib');
const { gateFor, saveSub, findItem, loadCerts, saveCert, deleteCert, loadPromo, savePromo, loadJournal, saveJournal, loadEntries, saveEntry, deleteEntry, entryPoints } = require('./_gate');
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
    const ents = Object.values(await loadEntries(m.id)).filter((e) => e.date >= from && !e.void);
    const points = ents.reduce((t, e) => t + entryPoints(e), 0);
    const trades = ents.filter((e) => e.kind === 'trade');
    rows.push({ id: m.id, name: m.displayName || m.username, username: m.username, avatar: m.avatar || null, points,
      entries: ents.length, followedPct: ents.length ? Math.round(ents.filter((e) => e.followed).length / ents.length * 100) : 0,
      tps: trades.filter((e) => e.outcome === 'tp').length, trades: trades.length, me: m.id === me });
  }));
  rows.sort((a, b) => b.points - a.points || b.followedPct - a.followedPct || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return { period, from, rows };
}
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
    if (board) return json(res, 200, await leaderboard(board[1], uid));
    const [certs, promo, journal, entries] = await Promise.all([loadCerts(uid), loadPromo(uid), loadJournal(uid), loadEntries(uid)]);
    const list = Object.values(certs).sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
    const ents = Object.values(entries).sort(byEntry).map((e) => Object.assign({}, e, { points: entryPoints(e) }));
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
    (Array.isArray(body.files) ? body.files : []).slice(0, 8).forEach((f) => {
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
    if (found.video && !admin) {
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
    const entry = { id: 'j' + crypto.randomBytes(6).toString('hex'), kind, date, followed: e.followed, overview, session: str(e.session, 40), createdAt: new Date().toISOString(), void: false };
    const entries = await loadEntries(uid);
    if (kind === 'none') {
      if (overview.length < 10) return json(res, 400, { error: 'overview_short' });
      if (!entry.session) return json(res, 400, { error: 'need_session' });
      if (Object.values(entries).some((x) => x.kind === 'none' && x.date === date)) return json(res, 409, { error: 'none_exists' });
    } else {
      Object.assign(entry, {
        time: /^\d{2}:\d{2}$/.test(str(e.time, 5)) ? str(e.time, 5) : '', pair: str(e.pair, 40), account: str(e.account, 40),
        contracts: Number(e.contracts), outcome: ['tp', 'sl', 'be'].includes(e.outcome) ? e.outcome : '', pnl: Number(e.pnl), model: ['BOS', 'MITIGATION', 'Chained OBs', 'DIV + OB'].includes(e.model) ? e.model : '',
        files: (Array.isArray(e.files) ? e.files : []).slice(0, 4).map((f) => cleanFile(f, uid, 'journal')),
      });
      const missing = ['time', 'pair', 'account', 'session', 'outcome', 'model'].filter((k) => !entry[k]);
      if (!(entry.contracts > 0 && entry.contracts <= 10000)) missing.push('contracts');
      if (!isFinite(entry.pnl) || e.pnl === '' || e.pnl === null) missing.push('pnl');
      if (overview.length < 20) missing.push('overview');
      if (missing.length) return json(res, 400, { error: 'missing', fields: missing });
      if (!entry.files.length || entry.files.some((f) => !f)) return json(res, 400, { error: 'need_files' });
    }
    await saveEntry(uid, entry);
    return json(res, 200, { saved: true, entry: Object.assign({}, entry, { points: entryPoints(entry) }) });
  }
  if (action === 'journal-delete') {
    const entries = await loadEntries(uid);
    const e = entries[String(body.id || '')];
    if (!e) return json(res, 404, { error: 'no_entry' });
    if (Date.now() - Date.parse(e.createdAt) > 7 * 864e5) return json(res, 409, { error: 'too_old' });   // a week to fix mistakes
    await deleteEntry(uid, e.id);
    return json(res, 200, { saved: true });
  }

  /* ---------- certificates ---------- */
  if (action === 'cert-add') {
    const kind = body.kind === 'funded' ? 'funded' : body.kind === 'payout' ? 'payout' : null;
    const file = cleanFile(body.file, uid, 'certs');
    if (!kind) return json(res, 400, { error: 'bad_kind' });
    if (!file) return json(res, 400, { error: 'bad_file' });
    const certs = await loadCerts(uid);
    if (Object.keys(certs).length >= 60) return json(res, 409, { error: 'too_many' });
    const cert = { id: 'c' + crypto.randomBytes(6).toString('hex'), kind, file, note: str(body.note, 300), uploadedAt: new Date().toISOString() };
    await saveCert(uid, cert);
    return json(res, 200, { saved: true, cert });
  }
  if (action === 'cert-delete') {
    const id = String(body.id || '');
    const promo = await loadPromo(uid);
    if (promo && promo.certId === id && promo.status !== 'declined') return json(res, 409, { error: 'in_use' });
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
    return json(res, 200, { saved: true, promo });
  }

  json(res, 400, { error: 'bad_action' });
};

module.exports = require('./_lib').guard(module.exports, 'json');
