// GET /api/content → announcements, homework, breakdowns and lessons for the signed-in member.
// Videos and notes for chapters the member's roles don't unlock are left out, so a locked
// lesson's video link never reaches their browser. Videos in a private Blob store are handed
// out as signed links that stop working after a few hours.
const { issueSignedToken, presignUrl } = require('@vercel/blob');
const { readSession, isAdmin, loadContent, CHAPTER_ROLES, json } = require('./_lib');

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

  let content = null;
  try { content = await loadContent(); } catch (e) { return json(res, 502, { error: 'storage' }); }
  if (!content) return json(res, 200, { content: null });   // nothing saved yet: the page uses its built-in defaults

  const admin = isAdmin(s);
  const roles = s.roles || [];
  const now = Date.now();
  const out = Object.assign({}, content);

  out.curriculum = (content.curriculum || []).map((ch) => {
    const role = ch.role || CHAPTER_ROLES[ch.id] || null;
    const open = admin || !role || roles.includes(role);
    return Object.assign({}, ch, {
      role,
      lessons: (ch.lessons || []).map((l) => (open ? Object.assign({}, l) : { id: l.id, title: l.title })),
    });
  });
  out.breakdowns = (content.breakdowns || []).map((b) => Object.assign({}, b));
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
