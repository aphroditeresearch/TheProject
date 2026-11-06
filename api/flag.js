// POST /api/flag { kind } → records a blocked action (right-click, developer tools, save…) against
// the signed-in member, so it shows in the admin Members view. Signed-out visitors aren't recorded.
const { readSession, kvConfigured, kv, json, clientIp } = require('./_lib');

const KINDS = ['right-click', 'devtools-keys', 'devtools-open', 'save', 'view-source', 'print', 'screenshot'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, { error: 'method' }); }
  const s = readSession(req);
  if (!s) return json(res, 401, { error: 'signed_out' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const kind = body && body.kind;
  if (!KINDS.includes(kind)) return json(res, 400, { error: 'bad_kind' });
  const ip = clientIp(req);
  if (!kvConfigured()) return json(res, 202, { recorded: false, ip });

  try {
    const key = 'flags:' + s.user.id;
    await kv(['HINCRBY', key, kind, 1]);
    await kv(['HINCRBY', key, 'total', 1]);
    await kv(['HSET', key, 'last', new Date().toISOString(), 'lastKind', kind, 'lastIp', ip || '']);
    json(res, 200, { recorded: true, ip });
  } catch (e) {
    json(res, 502, { error: 'storage' });
  }
};

module.exports = require('./_lib').guard(module.exports, 'json');
