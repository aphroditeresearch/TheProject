// Lets the browser upload a file straight to Vercel Blob (large files never pass through this function).
//   - admins: lesson and breakdown videos, into lessons/ or breakdowns/
//   - every signed-in member: homework / mark-up images and PDFs into members/<their id>/homework/,
//     certificates into members/<their id>/certs/, and journal screenshots into members/<their id>/journal/
//
// Works with both kinds of Blob connection Vercel creates:
//   - newer stores: BLOB_STORE_ID + a short-lived key Vercel gives each request (presigned uploads)
//   - older stores: BLOB_READ_WRITE_TOKEN (client-token uploads)
const { handleUpload, handleUploadPresigned } = require('@vercel/blob/client');
const { issueSignedToken } = require('@vercel/blob');
const { readSession, isAdmin, json, rateLimit, staffAlert, clientIp, timeoutUser } = require('./_lib');
const { storeId, rwToken, oidcToken } = require('./_blob');

const VIDEO = { types: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'], max: 5 * 1024 * 1024 * 1024 };      // 5 GB
const FILE = { types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'application/pdf'], max: 25 * 1024 * 1024 }; // 25 MB
const VIDEO_PATH = /^(lessons|breakdowns)\/[\w.\-]{1,120}$/;
const MEMBER_PATH = /^members\/(\d{5,25})\/(homework|certs|journal|thread)\/[\w.\-]{1,120}$/;
// conversation threads: screenshots, drawings on a screenshot, and voice notes
const THREAD = { types: FILE.types.concat(['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav']), max: 25 * 1024 * 1024 };

function rulesFor(pathname, s) {
  if (VIDEO_PATH.test(pathname)) return isAdmin(s) ? VIDEO : null;
  const m = MEMBER_PATH.exec(pathname);
  if (m && m[1] === s.user.id) return m[2] === 'thread' ? THREAD : FILE;
  return null;
}
const TV_IMG = /^https:\/\/s3\.tradingview\.com\/snapshots\/[a-z0-9]\/[A-Za-z0-9]{4,16}\.png$/;
async function tvFetchPng(url) {
  if (!TV_IMG.test(url)) return null;
  try {
    const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    // a real PNG, under 10 MB
    if (buf.length > 10 * 1024 * 1024 || buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    return buf;
  } catch (e) { return null; }
}
async function tvImage(id) {
  // usual address: snapshots/<first letter, lower case>/<id>.png
  const direct = await tvFetchPng('https://s3.tradingview.com/snapshots/' + id[0].toLowerCase() + '/' + id + '.png');
  if (direct) return direct;
  // otherwise read it from the snapshot page
  try {
    const r = await fetch('https://www.tradingview.com/x/' + id + '/', { signal: AbortSignal.timeout(8000) });
    const html = r.ok ? (await r.text()).slice(0, 500000) : '';
    const u = /https:\/\/s3\.tradingview\.com\/snapshots\/[a-z0-9]\/[A-Za-z0-9]{4,16}\.png/.exec(html);
    return u ? await tvFetchPng(u[0]) : null;
  } catch (e) { return null; }
}
function mode(req) {
  if (storeId() && oidcToken(req)) return 'presigned';
  if (rwToken()) return 'token';
  return '';
}

module.exports = async (req, res) => {
  // GET: health check the page runs before each upload
  // GET ?tv=<id>: a TradingView snapshot link (tradingview.com/x/<id>/) pasted into an upload box. The image is fetched
  // here (TradingView doesn't let other sites read it) and handed back, so the page uploads it like any other screenshot.
  if (req.method === 'GET' && /[?&]tv=/.test(req.url || '')) {
    const s = readSession(req);
    if (!s) return json(res, 401, { error: 'signed_out' });
    const m = /[?&]tv=([A-Za-z0-9]{4,16})(?:&|$)/.exec(req.url || '');
    if (!m) return json(res, 400, { error: 'bad link' });
    if (!isAdmin(s) && !(await rateLimit('tv:' + s.user.id, 40, 600))) return json(res, 429, { error: 'too many in a row' });
    const img = await tvImage(m[1]);
    if (!img) return json(res, 404, { error: 'snapshot not found' });
    res.statusCode = 200; res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'private, no-store');
    return res.end(img);
  }
  if (req.method === 'GET') {
    const s = readSession(req);
    if (!s) return json(res, 401, { ready: false, reason: 'Sign in again, your session ended.' });
    const m = mode(req);
    if (m) return json(res, 200, { ready: true, mode: m });
    if (storeId()) return json(res, 200, { ready: false, reason: 'The Blob store is connected, but Vercel didn\'t pass its access key. In Vercel → Settings → Security, make sure OIDC Federation is on for Production, then redeploy.' });
    return json(res, 200, { ready: false, reason: isAdmin(s) ? 'No Blob store is connected. In Vercel: Storage → your Blob store → Projects → connect this project, then redeploy.' : 'Uploads aren\'t switched on yet. Let your mentor know.' });
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return json(res, 405, { error: 'method' }); }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || !body.type) return json(res, 400, { error: 'bad_body' });

  // Only signed-in people may ask to upload, and only into a folder they're allowed to use.
  // (Completion notices come from Vercel Blob, are signed by it, and are checked inside the handlers.)
  let rules = null;
  if (body.type === 'blob.generate-client-token' || body.type === 'blob.generate-presigned-url') {
    const s = readSession(req);
    if (!s) return json(res, 401, { error: 'signed_out' });
    const p = body.payload && body.payload.pathname;
    rules = typeof p === 'string' ? rulesFor(p, s) : null;
    if (!rules) return json(res, 403, { error: 'You can\'t upload there.' });
    if (!isAdmin(s) && !(await rateLimit('upload:' + s.user.id, 60, 600))) return (await staffAlert('upload-limit', { id: s.user.id, name: s.user.displayName || s.user.username, ip: clientIp(req) }, 'Over 60 uploads in 10 minutes.'), await timeoutUser({ id: s.user.id, name: s.user.displayName || s.user.username, ip: clientIp(req) }, 'Uploaded too many files too fast (60+ in 10 minutes)'), json(res, 429, { error: 'Too many uploads in a row. Wait a few minutes and try again.' }));
  }
  const r = rules || FILE;

  try {
    if (body.type === 'blob.generate-presigned-url' || (body.type === 'blob.upload-completed' && storeId())) {
      const sid = storeId(), oidc = oidcToken(req);
      if (!sid || !oidc) return json(res, 503, { error: 'no_blob_store' });
      const result = await handleUploadPresigned({
        body, request: req,
        getSignedToken: async () => ({
          token: await issueSignedToken({
            oidcToken: oidc, storeId: sid, pathname: '*', operations: ['put'],
            allowedContentTypes: r.types, maximumSizeInBytes: r.max, validUntil: Date.now() + 30 * 60 * 1000,
          }),
          urlOptions: { allowedContentTypes: r.types, maximumSizeInBytes: r.max, addRandomSuffix: true },
        }),
      });
      return json(res, 200, result);
    }
    const token = rwToken();
    if (!token) return json(res, 503, { error: 'no_blob_store' });
    const result = await handleUpload({
      token, body, request: req,
      onBeforeGenerateToken: async () => ({ allowedContentTypes: r.types, maximumSizeInBytes: r.max, addRandomSuffix: true }),
    });
    json(res, 200, result);
  } catch (e) {
    console.error('upload error:', e);   // shows in Vercel → Logs
    json(res, 400, { error: String((e && e.message) || e) });
  }
};

module.exports = require('./_lib').guard(module.exports, 'json');
