// GET /api/callback → Discord sends the member back here after they approve.
// Swaps the one-time code for a token, reads their profile and server roles, and starts a session.
const {
  env, parseCookies, clearCookie, STATE_COOKIE, SESSION_DAYS,
  redirectUri, discord, profileFrom, writeSession, redirect, recordMember,
} = require('./_lib');

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const fail = (reason) => redirect(res, '/?error=' + reason, [clearCookie(STATE_COOKIE)]);

  if (url.searchParams.get('error')) return fail('denied');               // they pressed Cancel on Discord
  if (!code || !state || parseCookies(req)[STATE_COOKIE] !== state) return fail('expired');

  // 1. code → access token
  let token;
  try {
    const r = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env('DISCORD_CLIENT_ID'),
        client_secret: env('DISCORD_CLIENT_SECRET'),
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(req),
      }),
    });
    if (!r.ok) return fail('discord');
    token = await r.json();
  } catch (e) { return fail('discord'); }

  // 2. who they are, and their membership in your server
  const guildId = env('DISCORD_GUILD_ID');
  const [me, member] = await Promise.all([
    discord('/users/@me', token.access_token),
    discord('/users/@me/guilds/' + guildId + '/member', token.access_token),
  ]);
  if (me.status !== 200) return fail('discord');
  if (member.status === 404) return fail('not_member');                     // not in the server
  if (member.status !== 200) return fail('discord');

  // 3. optional gate: require a base member role to get in at all
  const required = env('MEMBER_ROLE_ID', true);
  if (required && !(member.data.roles || []).includes(required)) return fail('no_access');

  // 4. start the session (signed, HttpOnly cookie)
  const expiresMs = Math.min((token.expires_in || SESSION_DAYS * 86400) * 1000, SESSION_DAYS * 864e5);
  const session = {
    user: profileFrom(me.data, member.data, guildId),
    roles: member.data.roles || [],
    rolesAt: Date.now(),
    at: token.access_token,
    exp: Date.now() + expiresMs,
  };
  try { await recordMember(session.user, session.roles); } catch (e) {}
  redirect(res, '/?signedin=1', [writeSession(res, session), clearCookie(STATE_COOKIE)]);
};

module.exports = require('./_lib').guard(module.exports, 'page');
