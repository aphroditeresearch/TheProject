// Coaching data shared by /api/coach, /api/member and /api/admin/members:
//   - conversation threads on a journal entry (j:<entryId>), a hand-in (h:<lesson key>) or a trading day (d:<YYYY-MM-DD>)
//   - who has unread messages, per reader
//   - weekly focus goals, prop accounts, and which mentor a student is assigned to
const { kv } = require('./_lib');

const ITEM = /^(j:[A-Za-z0-9]{1,40}|h:(bd:|hw:)?[\w-]{1,64}|d:\d{4}-\d{2}-\d{2})$/;
const MAX_MSGS = 300;          // per thread (oldest dropped)
const parse = (x) => { try { return JSON.parse(x); } catch (e) { return null; } };
function flatToObj(flat, json) {
  const o = {}; if (Array.isArray(flat)) for (let i = 0; i < flat.length; i += 2) { const v = json ? parse(flat[i + 1]) : flat[i + 1]; if (v !== null && v !== undefined) o[flat[i]] = v; }
  return o;
}

// ---------- threads ----------
const tKey = (owner, item) => 'thread:' + owner + ':' + item;
async function loadThread(owner, item) { const r = await kv(['LRANGE', tKey(owner, item), 0, -1]); return (Array.isArray(r) ? r : []).map(parse).filter(Boolean); }
// per student: one line per thread (how many messages, and the latest) so lists can show "3 replies" without reading every thread
async function threadMeta(owner) { return flatToObj(await kv(['HGETALL', 'tmeta:' + owner]), true); }
async function addMessage(owner, item, msg) {
  await kv(['RPUSH', tKey(owner, item), JSON.stringify(msg)]);
  await kv(['LTRIM', tKey(owner, item), -MAX_MSGS, -1]);
  const meta = (await threadMeta(owner))[item] || { n: 0 };
  meta.n = (meta.n || 0) + 1;
  meta.last = { by: msg.by, name: msg.name, staff: !!msg.staff, at: msg.at, text: String(msg.text || (msg.audio ? '🎙 Voice note' : msg.mark ? '✎ Marked up a screenshot' : msg.files && msg.files.length ? '📎 Attachment' : '')).slice(0, 140) };
  if (msg.staff) meta.staffAt = msg.at; else meta.studentAt = msg.at;
  await kv(['HSET', 'tmeta:' + owner, item, JSON.stringify(meta)]);
  return meta;
}
// unread: a hash per reader, field "<owner>|<item>" = how many new messages
async function bumpUnread(readers, owner, item) { for (const r of readers) await kv(['HINCRBY', 'tunread:' + r, owner + '|' + item, 1]); }
async function clearUnread(reader, owner, item) { await kv(['HDEL', 'tunread:' + reader, owner + '|' + item]); }
async function unreadOf(reader) {
  const o = flatToObj(await kv(['HGETALL', 'tunread:' + reader]), false), out = [];
  Object.keys(o).forEach((k) => { const i = k.indexOf('|'); const n = +o[k] || 0; if (i > 0 && n > 0) out.push({ owner: k.slice(0, i), item: k.slice(i + 1), n }); });
  return out;
}

// ---------- mentors ----------
async function mentorMap() { return flatToObj(await kv(['HGETALL', 'mentors']), false); }
async function setMentor(student, staffId) { if (staffId) await kv(['HSET', 'mentors', student, staffId]); else await kv(['HDEL', 'mentors', student]); }

// ---------- weekly focus goals (week = the Monday of the trading week, New York) ----------
function weekOf(ymd) {
  const d = new Date(String(ymd).slice(0, 10) + 'T12:00:00Z'); if (isNaN(d)) return '';
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10);
}
async function loadGoals(uid) { return flatToObj(await kv(['HGETALL', 'goals:' + uid]), true); }
async function saveGoal(uid, week, goal) { if (goal) await kv(['HSET', 'goals:' + uid, week, JSON.stringify(goal)]); else await kv(['HDEL', 'goals:' + uid, week]); }

// ---------- prop accounts ----------
async function loadAccounts(uid) { return flatToObj(await kv(['HGETALL', 'paccts:' + uid]), true); }
async function saveAccount(uid, a) { await kv(['HSET', 'paccts:' + uid, a.id, JSON.stringify(a)]); }
async function deleteAccount(uid, id) { await kv(['HDEL', 'paccts:' + uid, id]); }

module.exports = { ITEM, loadThread, threadMeta, addMessage, bumpUnread, clearUnread, unreadOf, mentorMap, setMentor, weekOf, loadGoals, saveGoal, loadAccounts, saveAccount, deleteAccount };
