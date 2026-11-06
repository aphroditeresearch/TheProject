// GET  /api/progress → this member's completions { key: completedAt }
// POST /api/progress { key, completedAt } → save one (completedAt null clears it)
// Needs a Redis store (Upstash / Vercel KV). Without one, progress stays in each member's browser.
const { readSession, kvConfigured, loadProgress, saveProgress, json } = require('./_lib');

const KEY = /^(ch[\w]{1,24}-[\w]{1,40}|hw:[\w-]{1,64}|bd:[\w-]{1,64})$/;

module.exports = async (req, res) => {
  const s = readSession(req);
  if (!s) return json(res, 401, { error: 'signed_out' });

  if (req.method === 'GET') {
    try { return json(res, 200, { progress: await loadProgress(s.user.id) }); }
    catch (e) { return json(res, 502, { error: 'storage' }); }
  }

  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return json(res, 405, { error: 'method' }); }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const key = body && body.key;
  const at = body && body.completedAt;
  if (typeof key !== 'string' || !KEY.test(key)) return json(res, 400, { error: 'bad_key' });
  if (at !== null && (typeof at !== 'string' || isNaN(Date.parse(at)))) return json(res, 400, { error: 'bad_date' });

  if (!kvConfigured()) return json(res, 202, { saved: false, reason: 'no_storage' });
  try {
    // record the server's own clock for new completions so the date can't be backdated
    await saveProgress(s.user.id, key, at === null ? null : new Date().toISOString());
    return json(res, 200, { saved: true });
  } catch (e) { return json(res, 502, { error: 'storage' }); }
};
