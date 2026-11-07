// Shared helpers for the Discord sign-in functions.
// Files in /api that start with "_" are not exposed as routes on Vercel.

const crypto = require('crypto');

const DISCORD_API = 'https://discord.com/api/v10';
const SESSION_COOKIE = 'theproject_session';
const STATE_COOKIE = 'theproject_oauth_state';
const SESSION_DAYS = 7;
const ROLE_REFRESH_MS = 5 * 60 * 1000; // re-check Discord roles at most every 5 minutes

// Values are trimmed: a tab or space pasted along with a value in Vercel would otherwise break sign-in.
function env(name, optional) {
  const v = (process.env[name] || '').trim();
  if (!v && !optional) throw new Error('Missing environment variable ' + name);
  return v || '';
}

/* ---------- cookies ---------- */
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function cookie(name, value, maxAgeSec) {
  const parts = [name + '=' + encodeURIComponent(value), 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + maxAgeSec];
  if (process.env.NODE_ENV !== 'development') parts.push('Secure');
  return parts.join('; ');
}

function clearCookie(name) {
  return cookie(name, '', 0);
}

/* ---------- signed session token (HMAC-SHA256) ---------- */
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(crypto.createHmac('sha256', env('SESSION_SECRET')).update(body).digest());
  return body + '.' + mac;
}

function verify(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, mac] = token.split('.');
  const expect = b64url(crypto.createHmac('sha256', env('SESSION_SECRET')).update(body).digest());
  const a = Buffer.from(mac || ''), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
  catch (e) { return null; }
  if (!data || !data.exp || Date.now() > data.exp) return null;
  return data;
}

function readSession(req) {
  const s = verify(parseCookies(req)[SESSION_COOKIE]);
  return s && s.user && s.user.id ? s : null;   // only real sessions (not other signed tokens)
}

function writeSession(res, data) {
  const exp = data.exp || Date.now() + SESSION_DAYS * 864e5;
  const token = sign(Object.assign({}, data, { exp }));
  return cookie(SESSION_COOKIE, token, Math.max(0, Math.floor((exp - Date.now()) / 1000)));
}

/* ---------- Discord ---------- */
function redirectUri(req) {
  const fixed = env('DISCORD_REDIRECT_URI', true).replace(/\/+$/, '');
  if (fixed) return /\/api\/callback$/.test(fixed) ? fixed : fixed + '/api/callback';   // "https://site.com" works too
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  return proto + '://' + req.headers.host + '/api/callback';
}

async function discord(path, accessToken) {
  const r = await fetch(DISCORD_API + path, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (r.status === 404) return { status: 404 };
  if (!r.ok) return { status: r.status, error: await r.text() };
  return { status: 200, data: await r.json() };
}

function avatarUrl(user, member, guildId) {
  if (member && member.avatar) {
    const ext = member.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/guilds/${guildId}/users/${user.id}/avatars/${member.avatar}.${ext}?size=256`;
  }
  if (user.avatar) {
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=256`;
  }
  return null;
}

function bannerUrl(user) {
  if (!user.banner) return null;
  const ext = user.banner.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/banners/${user.id}/${user.banner}.${ext}?size=600`;
}

// Build the profile the page shows from Discord's user + server-member objects.
function profileFrom(user, member, guildId) {
  return {
    id: user.id,
    username: user.username,
    displayName: (member && member.nick) || user.global_name || user.username,
    avatar: avatarUrl(user, member, guildId),
    banner: bannerUrl(user),
    joinedAt: (member && member.joined_at) || null,
    email: (user.email && user.verified !== false) ? user.email : null,
  };
}

/* ---------- optional progress storage (Upstash Redis / Vercel KV REST API) ---------- */
function kvConfigured() {
  return !!((process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
            (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN));
}

// Every key this site writes starts with "theproject:", so it never reads or overwrites 00 Cleared's
// data (lessons, members, progress), even if both sites end up on the same Upstash database.
const KEY_PREFIX = 'theproject:';
async function kv(command) {
  command = [command[0], KEY_PREFIX + command[1]].concat(command.slice(2));
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
  if (!r.ok) throw new Error('KV error ' + r.status);
  return (await r.json()).result;
}

// Raw Redis access for backups: several commands in one request, keys passed exactly as given (no prefix added).
async function kvPipeline(commands) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  const r = await fetch(url.replace(/\/$/, '') + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(commands) });
  if (!r.ok) throw new Error('KV error ' + r.status);
  return (await r.json()).map((x) => { if (x && x.error) throw new Error(x.error); return x && x.result; });
}

async function loadProgress(userId) {
  if (!kvConfigured()) return {};
  const flat = await kv(['HGETALL', 'progress:' + userId]);
  const out = {};
  if (Array.isArray(flat)) for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  else if (flat && typeof flat === 'object') Object.assign(out, flat);
  return out;
}

async function saveProgress(userId, key, completedAt) {
  if (!kvConfigured()) return false;
  if (completedAt) await kv(['HSET', 'progress:' + userId, key, completedAt]);
  else await kv(['HDEL', 'progress:' + userId, key]);
  return true;
}

/* ---------- client IP (first address Vercel's proxy forwarded) ---------- */
function clientIp(req) {
  const h = req.headers || {};
  const fwd = String(h['x-forwarded-for'] || h['x-real-ip'] || h['x-vercel-forwarded-for'] || '').split(',')[0].trim();
  return /^[0-9a-fA-F:.]{3,45}$/.test(fwd) ? fwd : null;
}

/* ---------- admins + members ---------- */
// Discord user IDs allowed into the admin panel (comma-separated in ADMIN_DISCORD_IDS).
function adminIds() {
  return (env('ADMIN_DISCORD_IDS', true) || '1313595031466021026,484654761757507584,1195730656043487295').split(',').map((x) => x.trim()).filter(Boolean);
}
function isAdmin(session) { return !!(session && session.user && adminIds().includes(session.user.id)); }

// Remember who has signed in, for the admin Members view.
async function recordMember(profile, roles) {
  if (!kvConfigured()) return;
  const row = Object.assign({}, profile, { roles: roles || [], lastSeen: new Date().toISOString() });
  await kv(['HSET', 'members', profile.id, JSON.stringify(row)]);
}
async function listMembers() {
  if (!kvConfigured()) return [];
  const flat = await kv(['HGETALL', 'members']);
  const out = [];
  if (Array.isArray(flat)) for (let i = 0; i < flat.length; i += 2) { try { out.push(JSON.parse(flat[i + 1])); } catch (e) {} }
  return out;
}

async function loadFlags(userId) {
  if (!kvConfigured()) return {};
  const flat = await kv(['HGETALL', 'flags:' + userId]);
  const out = {};
  if (Array.isArray(flat)) for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

/* ---------- site content (announcements, homework, breakdowns, lessons) ---------- */
// Which Discord role unlocks each chapter. Chapters added in the admin panel carry their own role.
const CHAPTER_ROLES = { ch2: '1554996401979654165' /* Illuminated */, ch3: '1546326926099222538' /* Enlightened */ };

async function loadContent() {
  if (!kvConfigured()) return null;
  const raw = await kv(['GET', 'content']);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
async function saveContent(content) {
  await kv(['SET', 'content', JSON.stringify(content)]);
}

/* ---------- responses ---------- */
function redirect(res, location, cookies) {
  if (cookies && cookies.length) res.setHeader('Set-Cookie', cookies);
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

function json(res, status, body, cookies) {
  if (cookies && cookies.length) res.setHeader('Set-Cookie', cookies);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

// Wraps a route so a missing Vercel setting or an unexpected error never shows Vercel's
// "500 FUNCTION_INVOCATION_FAILED" page. Page routes send the member back to the site with a
// message; data routes answer with JSON. The full error goes to Vercel → Logs.
function guard(handler, kind) {
  return async (req, res) => {
    try {
      return await handler(req, res);
    } catch (e) {
      console.error('[the-project]', req.url, (e && e.stack) || e);
      const m = /Missing environment variable (\w+)/.exec((e && e.message) || '');
      if (res.headersSent) { try { res.end(); } catch (_) {} return; }
      if (kind === 'page') return redirect(res, m ? '/?error=setup&missing=' + m[1] : '/?error=server');
      return json(res, 500, m ? { error: 'setup', missing: m[1] } : { error: 'server' });
    }
  };
}

module.exports = {
  guard,
  DISCORD_API, SESSION_COOKIE, STATE_COOKIE, ROLE_REFRESH_MS, SESSION_DAYS,
  env, parseCookies, cookie, clearCookie, sign, verify, readSession, writeSession, kvPipeline, KEY_PREFIX,
  redirectUri, discord, profileFrom, kvConfigured, kv, loadProgress, saveProgress, redirect, json,
  adminIds, isAdmin, recordMember, listMembers, CHAPTER_ROLES, loadContent, saveContent, clientIp, loadFlags,
};
