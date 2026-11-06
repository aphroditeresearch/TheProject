// POST /api/submit { lessonId, notes, homework, link } → hand in notes and homework for a lesson,
// or notes and mark-ups for a breakdown (lessonId 'bd:<id>').
// The lesson has to be unlocked for this member, and its video watched to the end first.
// Depending on the admin's setting, the next lesson opens straight away or once an admin approves.
const { readSession, isAdmin, kvConfigured, loadProgress, json } = require('./_lib');
const { gateFor, saveSub, findItem } = require('./_gate');

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

module.exports = async (req, res) => {
  const s = readSession(req);
  if (!s) return json(res, 401, { error: 'signed_out' });
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, { error: 'method' }); }
  if (!kvConfigured()) return json(res, 503, { error: 'no_storage' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const lessonId = body && typeof body.lessonId === 'string' ? body.lessonId : '';
  const notes = str(body && body.notes, 8000);
  const homework = str(body && body.homework, 8000);
  let link = str(body && body.link, 2000);
  if (link && !/^https:\/\/[^\s"'<>]+$/.test(link)) return json(res, 400, { error: 'bad_link' });
  if (notes.length < 20) return json(res, 400, { error: 'notes_short' });
  if (homework.length < 20 && !link) return json(res, 400, { error: 'homework_short' });

  const admin = isAdmin(s);
  const { content, subs, access } = await gateFor(s, admin);
  const found = findItem(content, lessonId);
  if (!found) return json(res, 404, { error: 'no_lesson' });
  if (!access.all[lessonId] || !access.all[lessonId].open) return json(res, 403, { error: 'locked' });

  // the video (if there is one) has to be finished first
  if (found.video && !admin) {
    const prog = await loadProgress(s.user.id);
    if (!prog[lessonId]) return json(res, 409, { error: 'watch_first' });
  }

  const prev = subs[lessonId];
  if (prev && prev.status === 'approved') return json(res, 409, { error: 'already_approved' });

  const now = new Date().toISOString();
  const sub = {
    notes, homework, link,
    status: 'submitted',
    submittedAt: now,
    firstSubmittedAt: (prev && prev.firstSubmittedAt) || now,
    attempts: ((prev && prev.attempts) || 0) + 1,
    feedback: prev && prev.status === 'returned' ? prev.feedback || '' : '',
    reviewedAt: null, reviewer: null,
  };
  await saveSub(s.user.id, lessonId, sub);
  json(res, 200, { saved: true, sub, unlockMode: content.settings.unlockMode });
};

module.exports = require('./_lib').guard(module.exports, 'json');
