// GET /api/session → tells the page who is signed in, their roles and their saved progress.
// 401 means nobody is signed in. Roles are re-checked with Discord every few minutes,
// so giving or removing a role in Discord shows up on the site without signing out.
const {
  readSession, writeSession, clearCookie, SESSION_COOKIE, ROLE_REFRESH_MS,
  env, discord, profileFrom, loadProgress, json, isAdmin, recordMember, clientIp,
} = require('./_lib');

module.exports = async (req, res) => {
  const s = readSession(req);
  if (!s) return json(res, 401, { error: 'signed_out' });

  const cookies = [];
  if (Date.now() - (s.rolesAt || 0) > ROLE_REFRESH_MS && s.at) {
    const guildId = env('DISCORD_GUILD_ID');
    const member = await discord('/users/@me/guilds/' + guildId + '/member', s.at);
    if (member.status === 404) {                       // left or was removed from the server
      return json(res, 401, { error: 'not_member' }, [clearCookie(SESSION_COOKIE)]);
    }
    if (member.status === 200) {
      const required = env('MEMBER_ROLE_ID', true);
      if (required && !(member.data.roles || []).includes(required)) {
        return json(res, 401, { error: 'no_access' }, [clearCookie(SESSION_COOKIE)]);
      }
      const me = await discord('/users/@me', s.at);
      if (me.status === 200) s.user = profileFrom(me.data, member.data, guildId);
      s.roles = member.data.roles || [];
      s.rolesAt = Date.now();
      cookies.push(writeSession(res, s));
      try { await recordMember(s.user, s.roles); } catch (e) {}
    }
    // any other Discord hiccup: keep the last known roles and try again next time
  }

  let progress = {};
  try { progress = await loadProgress(s.user.id); } catch (e) { progress = {}; }

  json(res, 200, { user: s.user, roles: s.roles, progress, isAdmin: isAdmin(s), ip: clientIp(req) }, cookies);
};

module.exports = require('./_lib').guard(module.exports, 'json');
