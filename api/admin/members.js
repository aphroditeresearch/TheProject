// Admin only.
// GET  /api/admin/members → everyone who has signed in: roles, level, completions, flags,
//                           notes/homework hand-ins and any lessons unlocked or locked by hand.
// POST /api/admin/members { action:'review', userId, lessonId, status:'approved'|'returned', feedback }
//      → approve a hand-in, or send it back with feedback (sent-back work doesn't unlock the next lesson)
// POST /api/admin/members { action:'override', userId, lessonId, mode:'unlock'|'lock'|null }
//      → open or close one lesson for one member, whatever the usual rules say (null = back to normal)
const { readSession, isAdmin, adminIds, kvConfigured, listMembers, loadProgress, loadFlags, json } = require('../_lib');
const { contentWithDefaults, loadSubs, saveSub, loadOverrides, setOverride, levelOf, accessFor, findLesson } = require('../_gate');

const ID = /^\d{5,25}$/;
const LESSON = /^[\w-]{1,64}$/;

module.exports = async (req, res) => {
  const s = readSession(req);
  if (!s) return json(res, 401, { error: 'signed_out' });
  if (!isAdmin(s)) return json(res, 403, { error: 'not_admin' });
  if (!kvConfigured()) return json(res, 503, { error: 'no_storage' });

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    const userId = body && body.userId, lessonId = body && body.lessonId;
    if (!ID.test(String(userId || '')) || !LESSON.test(String(lessonId || ''))) return json(res, 400, { error: 'bad_target' });
    const content = await contentWithDefaults();
    if (!findLesson(content.curriculum, lessonId)) return json(res, 404, { error: 'no_lesson' });

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
      const access = accessFor({ curriculum: content.curriculum, settings: content.settings, roles: m.roles || [], subs, overrides, admin: false });
      return Object.assign({}, m, { progress, flags, subs, overrides, level: levelOf(content.curriculum, m.roles || []), access: access.lessons, isAdmin: adminIds().includes(m.id) });
    }));
    rows.sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
    json(res, 200, { members: rows });
  } catch (e) {
    json(res, 502, { error: 'storage' });
  }
};

module.exports = require('../_lib').guard(module.exports, 'json');
