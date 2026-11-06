// Admin only. GET /api/admin/members → everyone who has signed in, with their roles and completions.
const { readSession, isAdmin, kvConfigured, listMembers, loadProgress, loadFlags, json } = require('../_lib');

module.exports = async (req, res) => {
  const s = readSession(req);
  if (!s) return json(res, 401, { error: 'signed_out' });
  if (!isAdmin(s)) return json(res, 403, { error: 'not_admin' });
  if (!kvConfigured()) return json(res, 503, { error: 'no_storage' });

  try {
    const members = await listMembers();
    const rows = await Promise.all(members.map(async (m) => {
      let progress = {}, flags = {};
      try { progress = await loadProgress(m.id); } catch (e) {}
      try { flags = await loadFlags(m.id); } catch (e) {}
      return Object.assign({}, m, { progress, flags });
    }));
    rows.sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
    json(res, 200, { members: rows });
  } catch (e) {
    json(res, 502, { error: 'storage' });
  }
};
