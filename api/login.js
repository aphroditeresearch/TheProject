// GET /api/login → sends the member to Discord to approve sign-in.  GET /api/login?out=1 → signs out.
const crypto = require('crypto');
const { env, cookie, STATE_COOKIE, redirectUri, redirect, clearCookie, SESSION_COOKIE } = require('./_lib');

// Chrome only. Browsers can fake this header, so it's a second line behind the page's own check.
function isChrome(ua) {
  if (/CriOS\//.test(ua)) return true;
  return /Chrome\//.test(ua) && !/(Edg|EdgA|OPR|Opera|SamsungBrowser|YaBrowser|Vivaldi|DuckDuckGo|Brave|UCBrowser|Silk)\//.test(ua);
}

module.exports = async (req, res) => {
  // GET /api/login?out=1 → sign out: end the session and go back to the sign-in page
  if (/[?&]out=1/.test(req.url || '')) return redirect(res, '/', [clearCookie(SESSION_COOKIE)]);
  if (!isChrome(req.headers['user-agent'] || '')) return redirect(res, '/?error=browser');
  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: env('DISCORD_CLIENT_ID'),
    response_type: 'code',
    redirect_uri: redirectUri(req),
    scope: 'identify email guilds.members.read',
    state,
    prompt: 'none', // skip the approval screen for members who already approved
  });
  redirect(res, 'https://discord.com/oauth2/authorize?' + params.toString(), [cookie(STATE_COOKIE, state, 600)]);
};

module.exports = require('./_lib').guard(module.exports, 'page');
