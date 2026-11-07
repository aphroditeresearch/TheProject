// Admin only.
// GET  /api/admin/members → everyone who has signed in: roles, level, completions, flags, hand-ins,
//                           items unlocked/locked by hand, certificates and promotion requests.
// POST { action:'review', userId, lessonId, status:'approved'|'returned', feedback }
//      → approve a hand-in, or send it back with feedback (sent-back work doesn't unlock the next item)
// POST { action:'override', userId, lessonId, mode:'unlock'|'lock'|null }
//      → open or close one lesson part / lesson / breakdown for one member (null = back to the usual rules)
// POST { action:'complete', userId, keys:[…], done:true|false }
//      → mark items done for a member (work done off site), or undo that
// POST { action:'promote', userId, promote:true|false, note }
//      → promote a member to the next level (Enlightened), or decline / take back a promotion
// POST { action:'bulk', userIds:[…], keys:[…], op:'unlock'|'lock'|'reset'|'done'|'undone'|'unlock-done' }
//      → the same change for many members and many items at once
// POST { action:'clear-handins' } → delete every hand-in members submitted (items an admin marked done are kept)
// POST { action:'cert-review', userId, certId, status:'approved'|'denied'|'pending', amount, note } → certify a payout (it then
//      counts on the payout leaderboard, with the amount you confirm), or deny it
// POST { action:'journal-review', userId, entryId, status:'approved'|'denied'|'pending', note } → approve a journal entry for the
//      leaderboard, deny it (0 points), or put it back to pending
const { readSession, isAdmin, adminIds, kvConfigured, kv, listMembers, loadProgress, saveProgress, loadFlags, json } = require('../_lib');
const { loadActivity, saveCert, contentWithDefaults, memberState, loadSubs, saveSub, deleteSub, setOverride, loadCerts, loadPromo, savePromo, findItem, loadJournal, loadEntries, saveEntry, entryPoints, entryStatus, basePoints } = require('../_gate');
const { signAll } = require('../_blob');

const ID = /^\d{5,25}$/;
const KEY = /^(bd:|hw:)?[\w-]{1,64}$/;

// mark done / undo for one member (shared by 'complete' and 'bulk')
async function setDone(userId, keys, done, who) {
  const now = new Date().toISOString();
  const subs = await loadSubs(userId);
  for (const k of keys) {
    if (done) {
      const prev = subs[k];
      if (!prev || prev.status !== 'approved') {
        await saveSub(userId, k, Object.assign({ notes: '', homework: '', files: [], attempts: 0, submittedAt: now }, prev || {},
          { status: 'approved', offsite: !prev, reviewedAt: now, reviewer: who, feedback: prev ? prev.feedback || '' : 'Marked done by an admin.' }));
      }
      await saveProgress(userId, k, now);
    } else {
      await deleteSub(userId, k);
      await saveProgress(userId, k, null);
    }
  }
}
// delete every hand-in members submitted; keep the ones an admin marked done
async function clearHandins() {
  let n = 0;
  for (const m of await listMembers()) {
    const subs = await loadSubs(m.id);
    for (const [k, sb] of Object.entries(subs)) { if (!sb || !sb.offsite) { await deleteSub(m.id, k); n++; } }
  }
  return n;
}

module.exports = async (req, res) => {
  const s = readSession(req);
  if (!s) return json(res, 401, { error: 'signed_out' });
  if (!isAdmin(s)) return json(res, 403, { error: 'not_admin' });
  if (!kvConfigured()) return json(res, 503, { error: 'no_storage' });
  const who = s.user.displayName || s.user.username || s.user.id;

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body !== 'object') return json(res, 400, { error: 'bad_body' });
    try { await kv(['DEL', 'waiting-cache']); } catch (e) {}   // counts change after any admin action
    const userId = body && body.userId, lessonId = body && body.lessonId;
    const content = await contentWithDefaults();

    if (body.action === 'clear-handins') return json(res, 200, { saved: true, cleared: await clearHandins() });

    if (body.action === 'bulk') {
      const users = (Array.isArray(body.userIds) ? body.userIds : []).filter((u) => ID.test(String(u))).slice(0, 500);
      const keys = (Array.isArray(body.keys) ? body.keys : []).filter((k) => KEY.test(String(k)) && findItem(content, k)).slice(0, 500);
      const op = body.op;
      if (!users.length || !keys.length) return json(res, 400, { error: 'pick_both' });
      if (!['unlock', 'lock', 'reset', 'done', 'undone', 'unlock-done'].includes(op)) return json(res, 400, { error: 'bad_op' });
      for (const u of users) {
        if (op === 'unlock' || op === 'lock' || op === 'unlock-done') for (const k of keys) await setOverride(u, k, op === 'lock' ? 'lock' : 'unlock');
        if (op === 'reset') for (const k of keys) await setOverride(u, k, null);
        if (op === 'done' || op === 'unlock-done') await setDone(u, keys, true, who);
        if (op === 'undone') await setDone(u, keys, false, who);
      }
      return json(res, 200, { saved: true, members: users.length, items: keys.length });
    }

    if (!ID.test(String(userId || ''))) return json(res, 400, { error: 'bad_target' });

    if (body.action === 'cert-review') {
      const certs = await loadCerts(userId);
      const c = certs[String(body.certId || '')];
      if (!c || c.kind !== 'payout') return json(res, 404, { error: 'no_cert' });
      const status = body.status;
      if (!['approved', 'denied', 'pending'].includes(status)) return json(res, 400, { error: 'bad_status' });
      const amount = Math.round(Number(body.amount !== undefined && body.amount !== '' ? body.amount : c.amount) * 100) / 100;
      if (status === 'approved' && !(amount > 0 && amount < 10000000)) return json(res, 400, { error: 'need_amount' });
      c.review = { status, amount: status === 'approved' ? amount : (c.review && c.review.amount) || null, by: status === 'pending' ? null : who,
        at: status === 'pending' ? null : new Date().toISOString(), note: typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '' };
      await saveCert(userId, c);
      return json(res, 200, { saved: true, cert: c });
    }
    if (body.action === 'journal-review' || body.action === 'journal-void') {
      const entries = await loadEntries(userId);
      const e = entries[String(body.entryId || '')];
      if (!e) return json(res, 404, { error: 'no_entry' });
      const status = body.action === 'journal-void' ? (body.void ? 'denied' : 'approved') : body.status;
      if (!['approved', 'denied', 'pending'].includes(status)) return json(res, 400, { error: 'bad_status' });
      e.status = status; e.void = status === 'denied';
      // approving: the points to give (an admin can give less than it's worth, e.g. 1 for a paper trade); otherwise none
      if (status === 'approved') { const p = Number(body.points); e.awarded = isFinite(p) && body.points !== undefined && body.points !== null && body.points !== '' ? Math.max(0, Math.min(10, Math.round(p * 2) / 2)) : basePoints(e); }
      else delete e.awarded;
      e.reviewedBy = status === 'pending' ? null : who; e.reviewedAt = status === 'pending' ? null : new Date().toISOString();
      e.reviewNote = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
      await saveEntry(userId, e);
      return json(res, 200, { saved: true, status });
    }

    if (body.action === 'promote') {
      const prev = await loadPromo(userId);
      const now = new Date().toISOString();
      const promo = Object.assign({ certId: null, requestedAt: null }, prev || {},
        { status: body.promote ? 'approved' : 'declined', decidedAt: now, decidedBy: who, note: typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '' });
      await savePromo(userId, promo);
      return json(res, 200, { saved: true, promo });
    }

    if (body.action === 'complete') {
      const keys = (Array.isArray(body.keys) ? body.keys : []).filter((k) => KEY.test(String(k)) && findItem(content, k)).slice(0, 500);
      if (!keys.length) return json(res, 400, { error: 'no_keys' });
      await setDone(userId, keys, !!body.done, who);
      return json(res, 200, { saved: true, count: keys.length });
    }

    if (!KEY.test(String(lessonId || ''))) return json(res, 400, { error: 'bad_target' });

    // reviewing only needs the hand-in itself: it still works if the lesson was renamed, split or removed since
    if (body.action === 'review') {
      if (body.status !== 'approved' && body.status !== 'returned') return json(res, 400, { error: 'bad_status' });
      const subs = await loadSubs(userId);
      const sub = subs[lessonId];
      if (!sub) return json(res, 404, { error: 'no_submission' });
      sub.status = body.status;
      sub.feedback = typeof body.feedback === 'string' ? body.feedback.trim().slice(0, 4000) : '';
      sub.reviewedAt = new Date().toISOString();
      sub.reviewer = who;
      await saveSub(userId, lessonId, sub);
      return json(res, 200, { saved: true, sub });
    }
    if (!findItem(content, lessonId)) return json(res, 404, { error: 'no_lesson' });
    if (body.action === 'override') {
      const mode = body.mode === 'unlock' || body.mode === 'lock' ? body.mode : null;
      await setOverride(userId, lessonId, mode);
      return json(res, 200, { saved: true, mode });
    }
    return json(res, 400, { error: 'bad_action' });
  }

  if (req.method !== 'GET') { res.setHeader('Allow', 'GET, POST'); return json(res, 405, { error: 'method' }); }
  // notifications: the latest things members handed in, and how much is waiting in each admin section
  if (/[?&]activity=1/.test(req.url || '')) {
    try {
      const events = await loadActivity(80);
      // the waiting counts read every member, so they're worked out at most once a minute and shared by all admins
      const cached = await kv(['GET', 'waiting-cache']);
      if (cached) { try { return json(res, 200, { events, waiting: JSON.parse(cached) }); } catch (e) {} }
      const waiting = { handins: 0, journal: 0, payouts: 0, promotions: 0 };
      await Promise.all((await listMembers()).map(async (m) => {
        const [subs, entries, certs, promo] = await Promise.all([loadSubs(m.id), loadEntries(m.id), loadCerts(m.id), loadPromo(m.id)]);
        waiting.handins += Object.values(subs).filter((x) => x && x.status === 'submitted').length;
        waiting.journal += Object.values(entries).filter((e) => entryStatus(e) === 'pending').length;
        waiting.payouts += Object.values(certs).filter((c) => c.kind === 'payout' && !(c.review && c.review.status !== 'pending')).length;
        if (promo && promo.status === 'requested') waiting.promotions++;
      }));
      await kv(['SET', 'waiting-cache', JSON.stringify(waiting), 'EX', 60]);
      return json(res, 200, { events, waiting });
    } catch (e) { return json(res, 502, { error: 'storage' }); }
  }
  try {
    const content = await contentWithDefaults();
    const members = await listMembers();
    const files = [];
    const rows = await Promise.all(members.map(async (m) => {
      let journal = null, entries = {};
      try { journal = await loadJournal(m.id); entries = await loadEntries(m.id); } catch (e) {}
      let progress = {}, flags = {}, certs = {}, st = { subs: {}, overrides: {}, promo: null, access: { level: 0, lessons: {}, breakdowns: {}, canPromote: false } };
      try { progress = await loadProgress(m.id); } catch (e) {}
      try { flags = await loadFlags(m.id); } catch (e) {}
      try { certs = await loadCerts(m.id); } catch (e) {}
      try { st = await memberState(m.id, m.roles || [], false, content); } catch (e) {}
      Object.values(st.subs).forEach((sb) => (sb.files || []).forEach((f) => files.push(f)));
      Object.values(certs).forEach((c) => files.push(c.file));
      const ents = Object.values(entries).sort((a, b) => (String(b.date) + (b.time || '')).localeCompare(String(a.date) + (a.time || ''))).map((e) => Object.assign({}, e, { status: entryStatus(e), points: entryPoints(e), worth: basePoints(e) }));
      ents.forEach((e) => (e.files || []).forEach((f) => files.push(f)));
      return Object.assign({}, m, {
        progress, flags, subs: st.subs, overrides: st.overrides, promo: st.promo,
        certs: Object.values(certs).sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt))),
        level: st.access.level, canPromote: st.access.canPromote,
        access: Object.assign({}, st.access.lessons, st.access.breakdowns, st.access.homework || {}), isAdmin: adminIds().includes(m.id),
        journal, entries: ents,
      });
    }));
    await signAll(req, files, 'url');
    rows.sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
    json(res, 200, { members: rows });
  } catch (e) {
    json(res, 502, { error: 'storage' });
  }
};

module.exports = require('../_lib').guard(module.exports, 'json');
