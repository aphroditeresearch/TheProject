// Admin only.
// GET  /api/admin/members → everyone who has signed in: roles, level, completions, flags,
//                           notes/homework hand-ins and any lessons unlocked or locked by hand.
// POST /api/admin/members { action:'review', userId, lessonId, status:'approved'|'returned', feedback }
//      → approve a hand-in, or send it back with feedback (sent-back work doesn't unlock the next lesson)
// POST /api/admin/members { action:'override', userId, lessonId, mode:'unlock'|'lock'|null }
//      → open or close one lesson or breakdown for one member, whatever the usual rules say (null = back to normal)
// POST /api/admin/members { action:'complete', userId, keys:[…], done:true|false }
//      → mark lessons/breakdowns as done for a member (work done off site), or undo that
const { readSession, isAdmin, adminIds, kvConfigured, listMembers, loadProgress, saveProgress, loadFlags, json } = require('../_lib');
const { contentWithDefaults, loadSubs, saveSub, deleteSub, loadOverrides, setOverride, levelOf, accessFor, accessForBreakdowns, findItem } = require('../_gate');

const ID = /^\d{5,25}$/;
const LESSON = /^(bd:)?[\w-]{1,64}$/;

module.exports = async (req, res) => {
  const s = readSession(req);
  if (!s) return json(res, 401, { error: 'signed_out' });
  if (!isAdmin(s)) return json(res, 403, { error: 'not_admin' });
  if (!kvConfigured()) return json(res, 503, { error: 'no_storage' });

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    const userId = body && body.userId, lessonId = body && body.lessonId;
    if (!ID.test(String(userId || ''))) return json(res, 400, { error: 'bad_target' });
    const content = await contentWithDefaults();

    if (body.action === 'complete') {
      const keys = (Array.isArray(body.keys) ? body.keys : []).filter((k) => LESSON.test(String(k)) && findItem(content, k)).slice(0, 500);
      if (!keys.length) return json(res, 400, { error: 'no_keys' });
      const now = new Date().toISOString(), who = s.user.displayName || s.user.username || s.user.id;
      const subs = await loadSubs(userId);
      for (const k of keys) {
        if (body.done) {
          const prev = subs[k];
          if (!prev || prev.status !== 'approved') {
            await saveSub(userId, k, Object.assign({ notes: '', homework: '', link: '', attempts: 0, submittedAt: now }, prev || {},
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

    if (!LESSON.test(String(lessonId || ''))) return json(res, 400, { error: 'bad_target' });
    if (!findItem(content, lessonId)) return json(res, 404, { error: 'no_lesson' });

    if (body.action === 'review') {
      if (body.status !== 'approved' && body.status !== 'returned') return json(res, 400, { error: 'bad_status' });
      const subs = await loadSubs(userId);
      const sub = subs[lessonId];
      if (!sub) return json(res, 404, { error: 'no_submission' });
      sub.status = body.status;
      sub.feedback = typeof body.feedback === 'string' ? body.feedback.trim().slice(0, 4000) : '';
      sub.reviewedAt = new Date().toISOString();
      sub.reviewer = s.user.displayName || s.user.username || s.user.id;
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
    const rows = await Promise.all(members.map(async (m) => {
      let progress = {}, flags = {}, subs = {}, overrides = {};
      try { progress = await loadProgress(m.id); } catch (e) {}
      try { flags = await loadFlags(m.id); } catch (e) {}
      try { subs = await loadSubs(m.id); } catch (e) {}
      try { overrides = await loadOverrides(m.id); } catch (e) {}
      const args = { curriculum: content.curriculum, settings: content.settings, roles: m.roles || [], subs, overrides, admin: false };
      const access = Object.assign({}, accessFor(args).lessons, accessForBreakdowns(Object.assign({ breakdowns: content.breakdowns }, args)));
      return Object.assign({}, m, { progress, flags, subs, overrides, level: levelOf(content.curriculum, m.roles || []), access, isAdmin: adminIds().includes(m.id) });
    }));
    rows.sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
    json(res, 200, { members: rows });
  } catch (e) {
    json(res, 502, { error: 'storage' });
  }
};

module.exports = require('../_lib').guard(module.exports, 'json');
