// GET /api/content → announcements, homework, breakdowns and lessons for the signed-in member.
// Locked lessons come back as an id and a padlock only: no title, video, notes or homework,
// so nothing behind a lock ever reaches the member's browser (see _gate.js for the rules). Videos in a private Blob store are handed
// out as signed links that stop working after a few hours.
const { issueSignedToken, presignUrl } = require('@vercel/blob');
const { readSession, isAdmin, json } = require('./_lib');
const { gateFor, bdChains, bdKind, bdKey, BD_TASK } = require('./_gate');

const PRIVATE_HOST = /^https:\/\/[a-z0-9]+\.private\.blob\.vercel-storage\.com\//i;
const LINK_HOURS = 6;

function storeId() {
  if (process.env.BLOB_STORE_ID) return process.env.BLOB_STORE_ID;
  const k = Object.keys(process.env).find((n) => /_STORE_ID$/.test(n) && /^store_/.test(process.env[n] || ''));
  return k ? process.env[k] : '';
}

// Returns a function that turns a private Blob URL into a signed, expiring one.
async function makeSigner(req) {
  const sid = storeId();
  const oidc = (req.headers && req.headers['x-vercel-oidc-token']) || process.env.VERCEL_OIDC_TOKEN || '';
  const rw = process.env.BLOB_READ_WRITE_TOKEN || '';
  if (!sid && !rw) return null;
  const validUntil = Date.now() + LINK_HOURS * 3600 * 1000;
  const opts = { pathname: '*', operations: ['get', 'head'], validUntil };
  if (sid && oidc) Object.assign(opts, { oidcToken: oidc, storeId: sid }); else Object.assign(opts, { token: rw });
  const token = await issueSignedToken(opts);
  return async (url) => {
    const pathname = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
    const r = await presignUrl(token, { operation: 'get', pathname, access: 'private', validUntil });
    return r.presignedUrl;
  };
}

module.exports = async (req, res) => {
  const s = readSession(req);
  if (!s) return json(res, 401, { error: 'signed_out' });

  const admin = isAdmin(s);
  let gate;
  try { gate = await gateFor(s, admin); } catch (e) { return json(res, 502, { error: 'storage' }); }
  const { content, subs, access } = gate;
  const now = Date.now();
  const out = { homework: content.homework || [], announcements: [], breakdowns: [] };

  out.level = access.level;
  out.settings = { unlockMode: content.settings.unlockMode };
  out.curriculum = (content.curriculum || []).map((ch, ci) => {
    const lessons = (ch.lessons || []).map((l) => {
      const a = access.lessons[l.id] || { open: false, reason: 'level' };
      if (!a.open) return { id: l.id, open: false, reason: a.reason };               // padlock only
      return { id: l.id, title: l.title, video: l.video || '', summary: l.summary || '', homework: l.homework || '',
        open: true, passed: a.passed, sub: subs[l.id] || null };
    });
    return { id: ch.id, name: ch.name, role: ch.role || null, step: ci + 1,
      locked: lessons.every((l) => !l.open), lessons };
  });
  // breakdowns, in the order members work through them. Locked ones keep only their slot (type, week, day)
  const chains = bdChains(content.breakdowns);
  out.breakdowns = chains.main.concat(chains.advanced).map((b) => {
    const key = bdKey(b), a = access.breakdowns[key] || { open: false, reason: 'level' };
    const slot = { id: b.id, kind: bdKind(b), week: b.week || '', day: b.day || '' };
    if (!a.open) return Object.assign(slot, { open: false, reason: a.reason });
    return Object.assign(slot, { title: b.title, date: b.date || '', summary: b.summary || '', video: b.video || '', link: b.link || '',
      homework: b.homework || BD_TASK[slot.kind], createdAt: b.createdAt || '', open: true, passed: a.passed, sub: subs[key] || null });
  });
  out.announcements = (content.announcements || []).filter((a) => !a.expires || Date.parse(a.expires) > now);

  // sign private video links (only for the lessons this member can open)
  const items = [];
  out.curriculum.forEach((ch) => ch.lessons.forEach((l) => { if (l.video && PRIVATE_HOST.test(l.video)) items.push(l); }));
  out.breakdowns.forEach((b) => { if (b.video && PRIVATE_HOST.test(b.video)) items.push(b); });
  if (items.length) {
    try {
      const sign = await makeSigner(req);
      if (sign) await Promise.all(items.map(async (it) => { it.video = await sign(it.video); }));
    } catch (e) {
      console.error('video signing failed:', e);   // shows in Vercel → Logs; members see a playback message
    }
  }

  json(res, 200, { content: out });
};

module.exports = require('./_lib').guard(module.exports, 'json');
