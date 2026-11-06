// Admin only.
// GET /api/admin/content → everything (built-in lessons until you first save), including locked lessons and expired announcements
// PUT /api/admin/content { content } → replace it (the admin panel sends the whole thing on each save)
const { readSession, isAdmin, kvConfigured, saveContent, json } = require('../_lib');
const { contentWithDefaults } = require('../_gate');

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const id = (v) => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : null);
const url = (v) => { const s = str(v, 2000); return /^https:\/\/[^\s"'<>]+$/.test(s) ? s : ''; };
const date = (v) => { const s = str(v, 40); return s && !isNaN(Date.parse(s)) ? s : ''; };
// any date → the Monday of its week (YYYY-MM-DD)
const monday = (d) => { const t = new Date(d + 'T12:00:00Z'); const back = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - back); return t.toISOString().slice(0, 10); };
const role = (v) => (typeof v === 'string' && /^\d{5,25}$/.test(v.trim()) ? v.trim() : null);

function clean(c) {
  c = c && typeof c === 'object' ? c : {};
  const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  return {
    curriculum: arr(c.curriculum, 30).map((ch) => ({
      id: id(ch && ch.id), name: str(ch && ch.name, 80), role: role(ch && ch.role), promotion: !!(ch && ch.promotion),
      lessons: arr(ch && ch.lessons, 80).map((l) => {
        const out = { id: id(l && l.id), title: str(l && l.title, 140), video: url(l && l.video), summary: str(l && l.summary, 2000), homework: str(l && l.homework, 4000) };
        // a lesson can branch into parts (Liquidity part 1, part 2…); each part unlocks on its own
        if (l && Array.isArray(l.parts)) out.parts = arr(l.parts, 12).map((p) => ({
          id: /^ch\w{1,24}-\w{1,40}$/.test(String(p && p.id)) ? p.id : null,
          title: str(p && p.title, 140), video: url(p && p.video), summary: str(p && p.summary, 2000), homework: str(p && p.homework, 4000),
        })).filter((p) => p.id && p.title);
        return out;
      }).filter((l) => l.id && l.title),
    })).filter((ch) => ch.id && ch.name),
    homework: arr(c.homework, 300).map((h) => ({
      id: id(h && h.id), title: str(h && h.title, 160), chapter: str(h && h.chapter, 80),
      due: str(h && h.due, 40), details: str(h && h.details, 4000), createdAt: date(h && h.createdAt),
    })).filter((h) => h.id && h.title),
    breakdowns: arr(c.breakdowns, 500).map((b) => ({
      id: id(b && b.id), title: str(b && b.title, 160), date: str(b && b.date, 40), summary: str(b && b.summary, 4000),
      video: url(b && b.video), link: url(b && b.link), createdAt: date(b && b.createdAt),
      kind: ['daily', 'weekly', 'outlook', 'advanced'].includes(b && b.kind) ? b.kind : 'daily',
      week: /^\d{4}-\d{2}-\d{2}$/.test(str(b && b.week, 10)) ? monday(str(b && b.week, 10)) : '',
      day: ['mon', 'tue', 'wed', 'thu', 'fri'].includes(b && b.day) ? b.day : '',
      homework: str(b && b.homework, 4000),
    })).filter((b) => b.id && b.title),
    announcements: arr(c.announcements, 100).map((a) => ({
      id: id(a && a.id), title: str(a && a.title, 140), body: str(a && a.body, 2000),
      createdAt: date(a && a.createdAt), expires: date(a && a.expires),
    })).filter((a) => a.id && (a.title || a.body)),
    settings: { unlockMode: c.settings && c.settings.unlockMode === 'approve' ? 'approve' : 'submit' },
    updatedAt: new Date().toISOString(),
  };
}

module.exports = async (req, res) => {
  const s = readSession(req);
  if (!s) return json(res, 401, { error: 'signed_out' });
  if (!isAdmin(s)) return json(res, 403, { error: 'not_admin' });
  if (!kvConfigured()) return json(res, 503, { error: 'no_storage' });

  if (req.method === 'GET') {
    try { return json(res, 200, { content: await contentWithDefaults() }); }
    catch (e) { return json(res, 502, { error: 'storage' }); }
  }
  if (req.method === 'PUT' || req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body.content !== 'object') return json(res, 400, { error: 'bad_body' });
    const content = clean(body.content);
    try { await saveContent(content); } catch (e) { return json(res, 502, { error: 'storage' }); }
    return json(res, 200, { saved: true, content });
  }
  res.setHeader('Allow', 'GET, PUT');
  json(res, 405, { error: 'method' });
};

module.exports.clean = clean;

module.exports = require('../_lib').guard(module.exports, 'json');
