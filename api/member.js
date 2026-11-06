// The signed-in member's own things.
// GET  /api/member → their certificates and promotion status
// POST /api/member { action:'submit', lessonId, notes, homework, files:[…] }
//      → hand in notes + homework for a lesson or lesson part, or notes + mark-ups for a breakdown ('bd:<id>').
//        The item has to be unlocked for them, and its video (if any) watched to the end first.
// POST /api/member { action:'cert-add', kind:'payout'|'funded', file, note } → add a certificate to their profile
// POST /api/member { action:'cert-delete', id }                            → remove one (not while it's being used for promotion)
// POST /api/member { action:'promote-request', certId }                     → ask to be promoted to the next level with a payout certificate
// Files are uploaded straight from the browser to Vercel Blob first (see /api/upload), into members/<their id>/…
const crypto = require('crypto');
const { readSession, isAdmin, kvConfigured, loadProgress, json } = require('./_lib');
const { gateFor, saveSub, findItem, loadCerts, saveCert, deleteCert, loadPromo, savePromo } = require('./_gate');
const { signAll, cleanFile } = require('./_blob');

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

module.exports = async (req, res) => {
  const s = readSession(req);
  if (!s) return json(res, 401, { error: 'signed_out' });
  if (!kvConfigured()) return json(res, 503, { error: 'no_storage' });
  const uid = s.user.id;

  if (req.method === 'GET') {
    const [certs, promo] = await Promise.all([loadCerts(uid), loadPromo(uid)]);
    const list = Object.values(certs).sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
    await signAll(req, list.map((c) => c.file), 'url');
    return json(res, 200, { certs: list, promo });
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return json(res, 405, { error: 'method' }); }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const action = body && body.action;

  /* ---------- hand-in ---------- */
  if (action === 'submit') {
    const lessonId = typeof body.lessonId === 'string' ? body.lessonId : '';
    const notes = str(body.notes, 8000), homework = str(body.homework, 8000);
    const files = (Array.isArray(body.files) ? body.files : []).slice(0, 8).map((f) => cleanFile(f, uid, 'homework'));
    if (files.some((f) => !f)) return json(res, 400, { error: 'bad_file' });
    if (notes.length < 20) return json(res, 400, { error: 'notes_short' });
    if (homework.length < 20 && !files.length) return json(res, 400, { error: 'homework_short' });

    const admin = isAdmin(s);
    const { content, subs, access } = await gateFor(s, admin);
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
