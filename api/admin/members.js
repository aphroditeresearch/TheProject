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
const { readSession, isAdmin, adminIds, kvConfigured, listMembers, loadProgress, saveProgress, loadFlags, json } = require('../_lib');
const { contentWithDefaults, memberState, loadSubs, saveSub, deleteSub, setOverride, loadCerts, loadPromo, savePromo, findItem } = require('../_gate');
const { signAll } = require('../_blob');

const ID = /^\d{5,25}$/;
const KEY = /^(bd:)?[\w-]{1,64}$/;

module.exports = async (req, res) => {
  const s = readSession(req);
  if (!s) return json(res, 401, { error: 'signed_out' });
  if (!isAdmin(s)) return json(res, 403, { error: 'not_admin' });
  if (!kvConfigured()) return json(res, 503, { error: 'no_storage' });
  const who = s.user.displayName || s.user.username || s.user.id;

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    const userId = body && body.userId, lessonId = body && body.lessonId;
    if (!ID.test(String(userId || ''))) return json(res, 400, { error: 'bad_target' });
    const content = await contentWithDefaults();

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
      const now = new Date().toISOString();
      const subs = await loadSubs(userId);
      for (const k of keys) {
        if (body.done) {
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
      return json(res, 200, { saved: true, count: keys.length });
    }

    if (!KEY.test(String(lessonId || ''))) return json(res, 400, { error: 'bad_target' });
    if (!findItem(content, lessonId)) return json(res, 404, { error: 'no_lesson' });

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
    if (body.action === 'override') {
      const mode = body.mode === 'unlock' || body.mode === 'lock' ? body.mode : null;
      await setOverride(userId, lessonId, mode);
      return json(res, 200, { saved: true, mode });
    }
    return json(res, 400, { error: 'bad_action' });
  }

  if (req.method !== 'GET') { res.setHeader('Allow', 'GET, POST'); return json(res, 405, { error: 'method' }); }
  try {
    const content = await contentWithDefaults();
    const members = await listMembers();
    const files = [];
    const rows = await Promise.all(members.map(async (m) => {
      let progress = {}, flags = {}, certs = {}, st = { subs: {}, overrides: {}, promo: null, access: { level: 0, lessons: {}, breakdowns: {}, canPromote: false } };
      try { progress = await loadProgress(m.id); } catch (e) {}
      try { flags = await loadFlags(m.id); } catch (e) {}
      try { certs = await loadCerts(m.id); } catch (e) {}
      try { st = await memberState(m.id, m.roles || [], false, content); } catch (e) {}
      Object.values(st.subs).forEach((sb) => (sb.files || []).forEach((f) => files.push(f)));
      Object.values(certs).forEach((c) => files.push(c.file));
      return Object.assign({}, m, {
        progress, flags, subs: st.subs, overrides: st.overrides, promo: st.promo,
        certs: Object.values(certs).sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt))),
        level: st.access.level, canPromote: st.access.canPromote,
        access: Object.assign({}, st.access.lessons, st.access.breakdowns), isAdmin: adminIds().includes(m.id),
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
