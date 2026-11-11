// Mentor ↔ student coaching: conversations, weekly focus goals, prop accounts, mentor assignment.
// Staff = the site's admins. A student can only read and write their own; staff can for any student (uid).
//
// GET  /api/coach?me=1                     → { week, goals, accounts, meta, unread, mentor }   (the signed-in member's own)
// GET  /api/coach?thread=<item>[&uid=<id>] → { messages } (and marks them read for whoever is reading)
//        item: j:<journal entry id> · h:<hand-in key> · d:<YYYY-MM-DD> (a trading day)
// GET  /api/coach?inbox=1                  → { items:[{ owner, ownerName, item, n, last }] } unread conversations for the reader
// POST { action:'say', item, uid?, text, files?, audio?, mark? } → add a message (mark = a drawing over one of the student's screenshots)
// POST { action:'goal', uid?, text, week? }      → set (or clear, with empty text) the focus goal for a week (default: this week)
// POST { action:'acct-save', uid?, acct } / { action:'acct-delete', uid?, id } → a prop account (start, target, drawdown, daily loss, consistency %…)
// POST { action:'mentor', uid, mentorId }        → assign a student to a mentor (staff only; '' = nobody)
const crypto = require('crypto');
const { readSession, isAdmin, adminIds, kvConfigured, json, rateLimit, listMembers } = require('./_lib');
const { loadEntries, loadSubs, nyToday, logActivity } = require('./_gate');
const { signAll, cleanFile } = require('./_blob');
const C = require('./_coach');

const ID = /^\d{5,25}$/;
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => { if (v === '' || v === null || v === undefined) return undefined; const n = Number(v); return isFinite(n) && Math.abs(n) < 1e9 ? n : undefined; };
const nameOf = (u) => (u && (u.displayName || u.username)) || 'Member';

// every file in a list of messages, so they can be signed in one go
function filesIn(msgs) {
  const out = [];
  msgs.forEach((m) => { (m.files || []).forEach((f) => out.push(f)); if (m.audio) out.push(m.audio); if (m.mark) { out.push(m.mark.base); out.push(m.mark.overlay); } });
  return out.filter(Boolean);
}
async function itemExists(owner, item) {
  if (item.startsWith('d:')) return true;
  if (item.startsWith('j:')) return !!(await loadEntries(owner))[item.slice(2)];
  if (item.startsWith('h:')) return !!(await loadSubs(owner))[item.slice(2)];
  return false;
}
const KINDS = ['Evaluation', 'Funded', 'Personal / live'];
const DD = ['trailing', 'eod', 'static'];
const STATUS = ['active', 'passed', 'failed', 'paid', 'archived'];
function cleanAccount(a, old) {
  a = a || {};
  const out = { id: old ? old.id : 'a' + crypto.randomBytes(5).toString('hex'), name: str(a.name, 40) || 'Account', firm: str(a.firm, 40),
    kind: KINDS.includes(a.kind) ? a.kind : 'Evaluation', start: num(a.start), target: num(a.target), maxDD: num(a.maxDD), dailyLoss: num(a.dailyLoss),
    ddType: DD.includes(a.ddType) ? a.ddType : 'trailing', lockAtStart: a.lockAtStart !== false, status: STATUS.includes(a.status) ? a.status : 'active',
    pullOld: a.pullOld !== false, startDate: /^\d{4}-\d{2}-\d{2}$/.test(str(a.startDate, 10)) ? str(a.startDate, 10) : '', createdAt: old ? old.createdAt : new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (!(out.start > 0)) return { error: 'need_start' };
  if (out.maxDD !== undefined && !(out.maxDD > 0)) delete out.maxDD;
  if (out.target !== undefined && !(out.target > 0)) delete out.target;
  if (out.dailyLoss !== undefined && !(out.dailyLoss > 0)) delete out.dailyLoss;
  // consistency rule: the best day can't be more than this % of the total profit (e.g. 50 on a Topstep eval, 30 at Apex)
  const cons = num(a.consistency); if (cons > 0 && cons <= 100) out.consistency = Math.round(cons * 10) / 10;
  return { acct: out };
}

module.exports = async (req, res) => {
  const s = readSession(req);
  if (!s) return json(res, 401, { error: 'signed_out' });
  if (!kvConfigured()) return json(res, 503, { error: 'no_storage' });
  const me = s.user.id, staff = isAdmin(s);
  const q = new URL(req.url || '/', 'http://x').searchParams;
  // whose data: your own, or (staff) any student's
  const ownerOf = (uid) => { const u = String(uid || ''); if (!u || u === me) return me; return staff && ID.test(u) ? u : null; };

  if (req.method === 'GET') {
    if (q.get('me')) {
      const [goals, accounts, meta, unread, mentors] = await Promise.all([C.loadGoals(me), C.loadAccounts(me), C.threadMeta(me), C.unreadOf(me), C.mentorMap()]);
      let mentor = null;
      const mid = staff ? '' : C.mentorOf(mentors, me);
      if (mid) { const m = (await listMembers()).find((x) => x.id === mid); mentor = { id: mid, name: nameOf(m), avatar: (m && m.avatar) || null }; }
      return json(res, 200, { week: C.weekOf(nyToday()), goals, accounts: Object.values(accounts), meta, unread, mentor });
    }
    if (q.get('thread')) {
      const item = String(q.get('thread')), owner = ownerOf(q.get('uid'));
      if (!owner) return json(res, 403, { error: 'forbidden' });
      if (!C.ITEM.test(item)) return json(res, 400, { error: 'bad_item' });
      const messages = await C.loadThread(owner, item);
      await C.clearUnread(me, owner, item);
      await signAll(req, filesIn(messages), 'url');
      return json(res, 200, { messages });
    }
    if (q.get('inbox')) {
      const list = await C.unreadOf(me);
      const owners = [...new Set(list.map((x) => x.owner))], members = owners.length ? await listMembers() : [];
      const metas = {}; await Promise.all(owners.map(async (o) => { metas[o] = await C.threadMeta(o); }));
      const items = list.map((x) => { const m = members.find((y) => y.id === x.owner); return Object.assign({}, x, { ownerName: nameOf(m), avatar: (m && m.avatar) || null, last: ((metas[x.owner] || {})[x.item] || {}).last || null }); })
        .sort((a, b) => String((b.last && b.last.at) || '').localeCompare(String((a.last && a.last.at) || '')));
      return json(res, 200, { items });
    }
    return json(res, 400, { error: 'bad_request' });
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return json(res, 405, { error: 'method' }); }
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  body = body || {};
  const owner = ownerOf(body.uid);
  if (!owner) return json(res, 403, { error: 'forbidden' });

  if (body.action === 'say') {
    const item = String(body.item || '');
    if (!C.ITEM.test(item)) return json(res, 400, { error: 'bad_item' });
    if (!(await rateLimit('say:' + me, 60, 3600))) return json(res, 429, { error: 'slow_down' });
    if (!(await itemExists(owner, item))) return json(res, 404, { error: 'not_found' });
    const msg = { id: 'm' + crypto.randomBytes(5).toString('hex'), by: me, name: nameOf(s.user), avatar: s.user.avatar || null, staff, at: new Date().toISOString(), text: str(body.text, 2000) };
    const files = (Array.isArray(body.files) ? body.files : []).slice(0, 4).map((f) => cleanFile(f, me, 'thread'));
    if (files.some((f) => !f || /^audio\//.test(f.type))) return json(res, 400, { error: 'bad_file' });
    if (files.length) msg.files = files;
    if (body.audio) { const a = cleanFile(body.audio, me, 'thread'); if (!a || !/^audio\//.test(a.type)) return json(res, 400, { error: 'bad_file' }); a.secs = Math.max(0, Math.min(600, Math.round(+body.audio.secs || 0))); msg.audio = a; }
    if (body.mark) {
      // a drawing (transparent PNG) laid over one of the student's own screenshots
      const base = cleanFile(body.mark.base, owner, 'journal') || cleanFile(body.mark.base, owner, 'homework') || cleanFile(body.mark.base, owner, 'thread');
      const overlay = cleanFile(body.mark.overlay, me, 'thread');
      if (!base || !overlay || overlay.type !== 'image/png') return json(res, 400, { error: 'bad_file' });
      msg.mark = { base, overlay };
    }
    if (!msg.text && !msg.files && !msg.audio && !msg.mark) return json(res, 400, { error: 'empty' });
    const meta = await C.addMessage(owner, item, msg);
    await C.clearUnread(me, owner, item);   // writing in a conversation means you've read it
    // who gets told: the student when staff write; the student's mentor (or every admin if none) when the student writes
    let readers;
    if (staff && owner !== me) readers = [owner].concat(adminIds().filter((a) => a !== me));
    else { const mentors = await C.mentorMap(); const mid = C.mentorOf(mentors, owner); readers = mid && adminIds().includes(mid) ? [mid] : adminIds(); readers = readers.filter((r) => r !== me); }
    await C.bumpUnread(readers, owner, item);
    // a student's message shows in the admins' bell (staff replies don't, so the feed stays about students)
    if (!(staff && owner !== me)) await logActivity(s.user, { type: 'thread', owner, item, label: meta.last.text || 'New message' });
    await signAll(req, filesIn([msg]), 'url');
    return json(res, 200, { saved: true, message: msg, meta });
  }
  if (body.action === 'goal') {
    const text = str(body.text, 160);
    const week = /^\d{4}-\d{2}-\d{2}$/.test(String(body.week || '')) ? C.weekOf(body.week) : C.weekOf(nyToday());
    if (!(await rateLimit('goal:' + me, 40, 3600))) return json(res, 429, { error: 'slow_down' });
    const goal = text ? { text, by: me, byName: nameOf(s.user), staff, at: new Date().toISOString() } : null;
    await C.saveGoal(owner, week, goal);
    return json(res, 200, { saved: true, week, goal, goals: await C.loadGoals(owner) });
  }
  if (body.action === 'acct-save') {
    const all = await C.loadAccounts(owner), old = body.acct && body.acct.id ? all[String(body.acct.id)] : null;
    if (body.acct && body.acct.id && !old) return json(res, 404, { error: 'not_found' });
    if (!old && Object.keys(all).length >= 20) return json(res, 409, { error: 'too_many' });
    const r = cleanAccount(body.acct, old);
    if (r.error) return json(res, 400, r);
    await C.saveAccount(owner, r.acct);
    return json(res, 200, { saved: true, acct: r.acct });
  }
  if (body.action === 'acct-delete') {
    await C.deleteAccount(owner, String(body.id || ''));
    return json(res, 200, { deleted: true });
  }
  if (body.action === 'mentor') {
    if (!staff || owner === me) return json(res, 403, { error: 'forbidden' });
    const mid = String(body.mentorId || '');
    if (mid && !adminIds().includes(mid)) return json(res, 400, { error: 'not_staff' });
    await C.setMentor(owner, mid);
    return json(res, 200, { saved: true });
  }
  return json(res, 400, { error: 'bad_action' });
};

module.exports = require('./_lib').guard(module.exports, 'json');
