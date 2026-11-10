// Vercel Blob helpers shared by the routes that hand out files.
// Files in a private Blob store are only reachable through signed links that expire after a few hours,
// so videos, homework uploads and certificates can't be shared around by copying the address.
const { issueSignedToken, presignUrl } = require('@vercel/blob');

const PRIVATE_HOST = /^https:\/\/[a-z0-9]+\.private\.blob\.vercel-storage\.com\//i;
const BLOB_HOST = /^https:\/\/[a-z0-9]+\.(private\.|public\.)?blob\.vercel-storage\.com\//i;
const LINK_HOURS = 6;

function storeId() {
  if (process.env.BLOB_STORE_ID) return process.env.BLOB_STORE_ID;
  const k = Object.keys(process.env).find((n) => /_STORE_ID$/.test(n) && /^store_/.test(process.env[n] || ''));
  return k ? process.env[k] : '';
}
function rwToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const k = Object.keys(process.env).find((n) => /READ_WRITE_TOKEN$/.test(n) && /^vercel_blob_rw_/.test(process.env[n] || ''));
  return k ? process.env[k] : '';
}
function oidcToken(req) { return (req.headers && req.headers['x-vercel-oidc-token']) || process.env.VERCEL_OIDC_TOKEN || ''; }

// Returns a function that turns a private Blob URL into a signed, expiring one (or null if Blob isn't set up).
async function makeSigner(req) {
  const sid = storeId(), oidc = oidcToken(req), rw = rwToken();
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

// Signs `field` on every object in `items` that points at a private Blob file. Never throws.
async function signAll(req, items, field) {
  const todo = (items || []).filter((it) => it && typeof it[field] === 'string' && PRIVATE_HOST.test(it[field]));
  if (!todo.length) return;
  try {
    const sign = await makeSigner(req);
    if (sign) await Promise.all(todo.map(async (it) => { it[field] = await sign(it[field]); }));
  } catch (e) { console.error('blob signing failed:', e); }   // shows in Vercel → Logs
}

// A file a member uploaded: must be in their own folder in this site's Blob store.
const EXT_TYPE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf' };
function cleanFile(f, userId, folder) {
  if (!f || typeof f.url !== 'string') return null;
  const url = f.url.trim().slice(0, 2000).split('?')[0];
  if (!BLOB_HOST.test(url)) return null;
  let path;
  try { path = decodeURIComponent(new URL(url).pathname); } catch (e) { return null; }
  if (path.indexOf('/members/' + userId + '/' + folder + '/') === -1) return null;
  // the type: what the browser said, or worked out from the file name (some browsers send none, or "image/jpg")
  let type = typeof f.type === 'string' ? f.type.toLowerCase().slice(0, 80) : '';
  if (type === 'image/jpg' || type === 'image/pjpeg') type = 'image/jpeg';
  if (!/^(image\/(png|jpeg|webp|gif|heic|heif)|application\/pdf)$/.test(type)) {
    const ext = (/\.([a-z0-9]{2,5})$/i.exec(String(f.name || '')) || /\.([a-z0-9]{2,5})$/i.exec(path) || [])[1];
    type = EXT_TYPE[String(ext || '').toLowerCase()] || '';
  }
  if (!type) return null;
  return { url, name: String(f.name || 'file').slice(0, 140), type, size: Math.max(0, Math.min(+f.size || 0, 50 * 1024 * 1024)) };
}

module.exports = { PRIVATE_HOST, storeId, rwToken, oidcToken, makeSigner, signAll, cleanFile };
