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
const { readSession, isAdmin, json } = require('./_lib');
const { storeId, rwToken, oidcToken } = require('./_blob');

const VIDEO = { types: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'], max: 5 * 1024 * 1024 * 1024 };      // 5 GB
const FILE = { types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'application/pdf'], max: 25 * 1024 * 1024 }; // 25 MB
const VIDEO_PATH = /^(lessons|breakdowns)\/[\w.\-]{1,120}$/;
const MEMBER_PATH = /^members\/(\d{5,25})\/(homework|certs|journal)\/[\w.\-]{1,120}$/;

function rulesFor(pathname, s) {
  if (VIDEO_PATH.test(pathname)) return isAdmin(s) ? VIDEO : null;
  const m = MEMBER_PATH.exec(pathname);
  if (m && m[1] === s.user.id) return FILE;
  return null;
}
function mode(req) {
  if (storeId() && oidcToken(req)) return 'presigned';
  if (rwToken()) return 'token';
  return '';
}

module.exports = async (req, res) => {
  // GET: health check the page runs before each upload
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
