// Admin only. Lets the admin panel upload a video straight from the browser to Vercel Blob
// (large files never pass through this function).
//
// Works with both kinds of Blob connection Vercel creates:
//   - newer stores: BLOB_STORE_ID + a short-lived key Vercel gives each request (presigned uploads)
//   - older stores: BLOB_READ_WRITE_TOKEN (client-token uploads)
const { handleUpload, handleUploadPresigned } = require('@vercel/blob/client');
const { issueSignedToken } = require('@vercel/blob');
const { readSession, isAdmin, json } = require('../_lib');

const MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB per file
const TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'];
const PATH_OK = /^(lessons|breakdowns)\/[\w.\-]{1,120}$/;

// A store connected with a custom prefix gets a differently named key (e.g. VIDEOS_READ_WRITE_TOKEN).
function rwToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const k = Object.keys(process.env).find((n) => /READ_WRITE_TOKEN$/.test(n) && /^vercel_blob_rw_/.test(process.env[n] || ''));
  return k ? process.env[k] : '';
}
function storeId() {
  if (process.env.BLOB_STORE_ID) return process.env.BLOB_STORE_ID;
  const k = Object.keys(process.env).find((n) => /_STORE_ID$/.test(n) && /^store_/.test(process.env[n] || ''));
  return k ? process.env[k] : '';
}
function oidcToken(req) {
  return (req.headers && req.headers['x-vercel-oidc-token']) || process.env.VERCEL_OIDC_TOKEN || '';
}
function mode(req) {
  if (storeId() && oidcToken(req)) return 'presigned';
  if (rwToken()) return 'token';
  return '';
}

module.exports = async (req, res) => {
  // GET: health check the admin panel runs before each upload
  if (req.method === 'GET') {
    const s = readSession(req);
    if (!s) return json(res, 401, { ready: false, reason: 'Sign in again, your session ended.' });
    if (!isAdmin(s)) return json(res, 403, { ready: false, reason: 'Only admins can upload.' });
    const m = mode(req);
    if (m) return json(res, 200, { ready: true, mode: m });
    if (storeId()) return json(res, 200, { ready: false, reason: 'The Blob store is connected, but Vercel didn\'t pass its access key. In Vercel → Settings → Security, make sure OIDC Federation is on for Production, then redeploy.' });
    return json(res, 200, { ready: false, reason: 'No Blob store is connected. In Vercel: Storage → your Blob store → Projects → connect this project, then redeploy.' });
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return json(res, 405, { error: 'method' }); }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || !body.type) return json(res, 400, { error: 'bad_body' });

  // Only a signed-in admin may ask to upload. (Completion notices come from Vercel Blob,
  // are signed by it, and are checked inside the handlers.)
  if (body.type === 'blob.generate-client-token' || body.type === 'blob.generate-presigned-url') {
    const s = readSession(req);
    if (!s) return json(res, 401, { error: 'signed_out' });
    if (!isAdmin(s)) return json(res, 403, { error: 'not_admin' });
    const p = body.payload && body.payload.pathname;
    if (typeof p !== 'string' || !PATH_OK.test(p)) return json(res, 400, { error: 'Uploads go in lessons/ or breakdowns/' });
  }

  try {
    if (body.type === 'blob.generate-presigned-url' || (body.type === 'blob.upload-completed' && storeId())) {
      const sid = storeId(), oidc = oidcToken(req);
      if (!sid || !oidc) return json(res, 503, { error: 'no_blob_store' });
      const result = await handleUploadPresigned({
        body,
        request: req,
        getSignedToken: async (pathname) => ({
          token: await issueSignedToken({
            oidcToken: oidc, storeId: sid, pathname: '*', operations: ['put'],
            allowedContentTypes: TYPES, maximumSizeInBytes: MAX_BYTES, validUntil: Date.now() + 60 * 60 * 1000,
          }),
          urlOptions: { allowedContentTypes: TYPES, maximumSizeInBytes: MAX_BYTES, addRandomSuffix: true },
        }),
      });
      return json(res, 200, result);
    }

    const token = rwToken();
    if (!token) return json(res, 503, { error: 'no_blob_store' });
    const result = await handleUpload({
      token, body, request: req,
      onBeforeGenerateToken: async () => ({ allowedContentTypes: TYPES, maximumSizeInBytes: MAX_BYTES, addRandomSuffix: true }),
    });
    json(res, 200, result);
  } catch (e) {
    console.error('upload error:', e);   // shows in Vercel → Logs
    json(res, 400, { error: String((e && e.message) || e) });
  }
};

module.exports = require('../_lib').guard(module.exports, 'json');
