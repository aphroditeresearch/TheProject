// GET /api/content → announcements, homework, breakdowns and lessons for the signed-in member.
// Only what the member has reached is sent (see _gate.js for the rules):
//   - chapters above their level aren't sent at all, just the name of the next one and how it opens
//   - locked lessons, lesson parts and breakdowns come back as an id and a padlock: no title, video,
//     notes or homework, so nothing behind a lock ever reaches the member's browser
// Videos and uploaded files in a private Blob store are handed out as signed links that expire.
const { readSession, isAdmin, json } = require('./_lib');
const { gateFor, bdChains, bdKind, bdKey, BD_TASK, unitsOf } = require('./_gate');
const { signAll } = require('./_blob');

module.exports = async (req, res) => {
  const s = readSession(req);
  if (!s) return json(res, 401, { error: 'signed_out' });

  const admin = isAdmin(s);
  let gate;
  try { gate = await gateFor(s, admin); } catch (e) { return json(res, 502, { error: 'storage' }); }
  const { content, subs, access, promo } = gate;
  const now = Date.now();
  const A = access.lessons;
  const toSign = [];
  const withSub = (key) => { const sb = subs[key] ? JSON.parse(JSON.stringify(subs[key])) : null; if (sb && sb.files) sb.files.forEach((f) => toSign.push(f)); return sb; };

  const out = { announcements: [], breakdowns: [] };
  // homework: only assignments whose lectures this member has reached, with their own hand-in
  const lessonTitles = {};
  (content.curriculum || []).forEach((ch) => (ch.lessons || []).forEach((l) => { lessonTitles[l.id] = l.title; (l.parts || []).forEach((p) => { lessonTitles[p.id] = l.title + ' · ' + p.title; }); }));
  out.homework = (content.homework || []).filter((h) => access.homework['hw:' + h.id] && access.homework['hw:' + h.id].open).map((h) => Object.assign({}, h, {
    lessonTitles: (h.lessons || []).filter((id) => A[id] && A[id].open).map((id) => lessonTitles[id]).filter(Boolean),
    passed: access.homework['hw:' + h.id].passed, sub: withSub('hw:' + h.id) }));
  out.level = access.level;
  out.settings = { unlockMode: content.settings.unlockMode };
  out.promotion = { canRequest: access.canPromote, status: promo ? promo.status : null, note: promo ? promo.note || '' : '' };

  out.curriculum = [];
  (content.curriculum || []).forEach((ch, ci) => {
    if (ci + 1 > access.level) return;                                   // not reached yet: not sent
    const lessons = (ch.lessons || []).map((l) => {
      const hasParts = unitsOf(l)[0] !== l;
      const a = A[l.id] || { open: false, reason: 'order' };
      const unit = (u) => {
        const ua = A[u.id] || { open: false, reason: 'order' };
        if (!ua.open) return { id: u.id, open: false, reason: ua.reason };
        return { id: u.id, title: u.title, video: u.video || '', summary: u.summary || '', homework: u.homework || '',
          notice: u.notice && (u.notice.title || u.notice.body) ? u.notice : null, open: true, passed: ua.passed, sub: withSub(u.id) };
      };
      if (!hasParts) return unit(l);
      const parts = l.parts.map(unit);
      if (!a.open) return { id: l.id, open: false, reason: a.reason };                 // locked: not even how many parts it has
      return { id: l.id, title: l.title, open: true, passed: a.passed, parts };
    });
    out.curriculum.push({ id: ch.id, name: ch.name, role: ch.role || null, step: ci + 1, promotion: !!ch.promotion, lessons });
  });
  // the next chapter's name, and how it opens
  const next = (content.curriculum || [])[access.level];
  if (next && !admin) out.next = { name: next.name, how: next.promotion ? 'promotion' : 'finish', after: (content.curriculum[access.level - 1] || {}).name || '' };

  // breakdowns, in the order members work through them. Locked ones keep only their slot (type, week, day);
  // Advanced ones aren't sent at all until the member reaches the top level.
  const chains = bdChains(content.breakdowns);
  chains.main.concat(chains.advanced).forEach((b) => {
    const key = bdKey(b), a = access.breakdowns[key] || { open: false, reason: 'level' };
    if (a.reason === 'hidden') return;
    const slot = { id: b.id, kind: bdKind(b), week: b.week || '', day: b.day || '' };
    if (!a.open) { out.breakdowns.push(Object.assign(slot, { open: false, reason: a.reason })); return; }
    out.breakdowns.push(Object.assign(slot, { title: b.title, date: b.date || '', summary: b.summary || '', video: b.video || '', link: b.link || '',
      homework: b.homework || BD_TASK[slot.kind], createdAt: b.createdAt || '', open: true, passed: a.passed, sub: withSub(key) }));
  });
  out.announcements = (content.announcements || []).filter((a) => !a.expires || Date.parse(a.expires) > now);

  // signed links for private videos and for the member's own uploads
  const vids = [];
  out.curriculum.forEach((ch) => ch.lessons.forEach((l) => { vids.push(l); (l.parts || []).forEach((p) => vids.push(p)); }));
  out.breakdowns.forEach((b) => vids.push(b));
  await signAll(req, vids, 'video');
  await signAll(req, toSign, 'url');

  json(res, 200, { content: out });
};

module.exports = require('./_lib').guard(module.exports, 'json');
