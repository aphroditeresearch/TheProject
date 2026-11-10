// GET /api/login → sends the member to Discord to approve sign-in.  GET /api/login?out=1 → signs out.
const crypto = require('crypto');
const { env, cookie, sign, STATE_COOKIE, redirectUri, redirect, clearCookie, SESSION_COOKIE, rateLimit, clientIp, staffAlert } = require('./_lib');

// Chrome only. Browsers can fake this header, so it's a second line behind the page's own check.
function isChrome(ua) {
  if (/CriOS\//.test(ua)) return true;
  return /Chrome\//.test(ua) && !/(Edg|EdgA|OPR|Opera|SamsungBrowser|YaBrowser|Vivaldi|DuckDuckGo|Brave|UCBrowser|Silk)\//.test(ua);
}

module.exports = async (req, res) => {
  // at most 20 sign-in starts per 10 minutes from one address
  if (!(await rateLimit('login:' + clientIp(req), 20, 600))) { await staffAlert('login-limit', { ip: clientIp(req) }, 'Over 20 sign-in attempts in 10 minutes from this address.'); res.statusCode = 302; res.setHeader('Location', '/?error=slow_down'); return res.end(); }
  // GET /api/login?out=1 → sign out: end the session and go back to the sign-in page
  if (/[?&]out=1/.test(req.url || '')) return redirect(res, '/', [clearCookie(SESSION_COOKIE)]);
  if (!isChrome(req.headers['user-agent'] || '')) return redirect(res, '/?error=browser');
  // The state is signed, so the callback can check it even when the phone drops the state cookie
  // (iPhone browsers can lose cookies set on a redirect, and a double tap on "Sign in" replaces it).
  const state = sign({ t: 'oauth', n: crypto.randomBytes(12).toString('hex'), exp: Date.now() + 15 * 60 * 1000 });
  const params = new URLSearchParams({
    client_id: env('DISCORD_CLIENT_ID'),
    response_type: 'code',
    redirect_uri: redirectUri(req),
    scope: 'identify email guilds.members.read',
    state,
    prompt: 'none', // skip the approval screen for members who already approved
  });
  redirect(res, 'https://discord.com/oauth2/authorize?' + params.toString(), [cookie(STATE_COOKIE, state, 900)]);
};

module.exports = require('./_lib').guard(module.exports, 'page');
