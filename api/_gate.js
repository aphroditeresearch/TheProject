// Who can open which lesson. Every route that hands out lessons, saves progress or takes a
// submission asks this file, so the rules live in one place and are enforced on the server.
//
// The ladder: chapters run in order (Awakened, Illuminated, Enlightened). A member's level is the
// highest chapter whose Discord role they hold. Members hold one role, so:
//   - chapters below their level are fully open (they've already been through them)
//   - chapters above their level are locked, titles and all
//   - in their own chapter, lessons open one at a time: the next one opens once this one's notes
//     and homework are handed in (or approved, if the admin chose "after I approve")
// Admins can unlock or lock any single lesson for any member, and that beats the rules above.
//
// Breakdowns are a second chain that runs every week, oldest first:
//   Monday → Tuesday → … → Friday (daily breakdowns) → Weekly Breakdown (recap) → Weekly Outlook → next week's Monday
// Each one opens once the previous one's notes and mark-ups are handed in. Any chapter role gets the chain.
// Advanced Breakdowns are their own chain, only for the top role (Enlightened), and work the same way.
const { kv, kvConfigured, loadContent } = require('./_lib');
const { CURRICULUM, DEFAULT_SETTINGS } = require('./_curriculum');

/* ---------- content with built-in defaults ---------- */
async function contentWithDefaults() {
  let c = null;
  try { c = await loadContent(); } catch (e) { throw e; }
  c = c ? Object.assign({}, c) : { homework: [], breakdowns: [], announcements: [] };
  if (!Array.isArray(c.curriculum) || !c.curriculum.length) c.curriculum = JSON.parse(JSON.stringify(CURRICULUM));
  c.settings = Object.assign({}, DEFAULT_SETTINGS, c.settings || {});
  return c;
}

/* ---------- storage: submissions and admin overrides ---------- */
function hashToObj(flat, parse) {
  const out = {};
  if (Array.isArray(flat)) for (let i = 0; i < flat.length; i += 2) {
    if (!parse) { out[flat[i]] = flat[i + 1]; continue; }
    try { out[flat[i]] = JSON.parse(flat[i + 1]); } catch (e) {}
  }
  return out;
}
async function loadSubs(userId) {
  if (!kvConfigured()) return {};
  return hashToObj(await kv(['HGETALL', 'subs:' + userId]), true);
}
async function saveSub(userId, lessonId, sub) {
  await kv(['HSET', 'subs:' + userId, lessonId, JSON.stringify(sub)]);
}
async function loadOverrides(userId) {
  if (!kvConfigured()) return {};
  return hashToObj(await kv(['HGETALL', 'unlocks:' + userId]), false);
}
async function deleteSub(userId, key) {
  await kv(['HDEL', 'subs:' + userId, key]);
}
async function setOverride(userId, lessonId, mode) {
  if (mode === 'unlock' || mode === 'lock') await kv(['HSET', 'unlocks:' + userId, lessonId, mode]);
  else await kv(['HDEL', 'unlocks:' + userId, lessonId]);
}

/* ---------- the rules ---------- */
// 0 = no chapter role, 1 = first chapter's role, ... (the highest role held wins)
function levelOf(curriculum, roles) {
  let lvl = 0;
  (curriculum || []).forEach((ch, i) => { if (ch.role && (roles || []).includes(ch.role)) lvl = i + 1; });
  return lvl;
}

function passes(sub, settings) {
  if (!sub) return false;
  if (sub.status === 'approved') return true;
  return sub.status === 'submitted' && (settings.unlockMode || 'submit') === 'submit';
}

// Returns { level, lessons: { [lessonId]: { open, passed, reason } } }
// reason (when locked): 'level' (chapter above their role), 'order' (finish the previous lesson), 'admin' (locked by an admin)
function accessFor({ curriculum, settings, roles, subs, overrides, admin }) {
  const level = levelOf(curriculum, roles);
  const out = {};
  (curriculum || []).forEach((ch, ci) => {
    const chLevel = ci + 1;
    let prevPassed = true;
    (ch.lessons || []).forEach((l, li) => {
      const sub = subs[l.id];
      const ov = overrides[l.id];
      let open, reason = null, passed;
      if (admin) { open = true; passed = true; }
      else if (chLevel < level) { open = true; passed = true; }                       // already through this chapter
      else if (chLevel > level) { open = false; reason = 'level'; passed = false; }
      else {                                                                           // their current chapter
        open = li === 0 || prevPassed;
        if (!open) reason = 'order';
        passed = passes(sub, settings);
      }
      if (!admin && ov === 'unlock' && !open) { open = true; reason = null; }
      if (!admin && ov === 'lock') { open = false; reason = 'admin'; }
      out[l.id] = { open, passed: open && passed, reason, override: ov || null };
      prevPassed = open && passed;
    });
  });
  return { level, lessons: out };
}

// Everything the gate needs for one member, in one go.
async function gateFor(session, admin) {
  const content = await contentWithDefaults();
  const [subs, overrides] = await Promise.all([loadSubs(session.user.id), loadOverrides(session.user.id)]);
  const args = { curriculum: content.curriculum, settings: content.settings, roles: session.roles || [], subs, overrides, admin };
  const access = accessFor(args);
  access.breakdowns = accessForBreakdowns(Object.assign({ breakdowns: content.breakdowns }, args));
  // one lookup for anything with a key: lessons and breakdowns
  access.all = Object.assign({}, access.lessons, access.breakdowns);
  return { content, subs, overrides, access };
}

function findLesson(curriculum, lessonId) {
  for (const ch of curriculum || []) for (const l of ch.lessons || []) if (l.id === lessonId) return { ch, l };
  return null;
}

/* ---------- breakdowns ---------- */
const DAY_RANK = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5 };
const KIND_RANK = { weekly: 6, outlook: 7 };
const BD_TASK = {
  daily: 'Mark up today\'s chart the way it was broken down: the range, the liquidity taken, your entry, stop and target. Add a screenshot or chart link.',
  weekly: 'Mark up the week: the weekly range, the key highs and lows, and what each day did. Add a screenshot or chart link.',
  outlook: 'Mark up your plan for next week: key levels, your bias, and what you need to see before you take a trade. Add a screenshot or chart link.',
  advanced: 'Mark up the chart from this breakdown and explain each step in your own words. Add a screenshot or chart link.',
};
function bdKind(b) { return ['daily', 'weekly', 'outlook', 'advanced'].includes(b && b.kind) ? b.kind : 'daily'; }
function bdOrderKey(b) {
  const k = bdKind(b);
  const rank = k === 'daily' ? (DAY_RANK[b.day] || 1) : (KIND_RANK[k] || 8);
  return String(b.week || (b.createdAt || '').slice(0, 10) || '0000-00-00') + '|' + rank + '|' + String(b.createdAt || '');
}
// the two chains, each in the order members work through them
function bdChains(breakdowns) {
  const list = (breakdowns || []).slice().sort((a, b) => bdOrderKey(a).localeCompare(bdOrderKey(b)));
  return { main: list.filter((b) => bdKind(b) !== 'advanced'), advanced: list.filter((b) => bdKind(b) === 'advanced') };
}
function bdKey(b) { return 'bd:' + b.id; }

// { [ 'bd:'+id ]: { open, passed, reason } } for both chains
function accessForBreakdowns({ breakdowns, curriculum, settings, roles, subs, overrides, admin }) {
  const level = levelOf(curriculum, roles);
  const top = (curriculum || []).length || 3;
  const out = {};
  const chains = bdChains(breakdowns);
  [['main', level >= 1], ['advanced', level >= top]].forEach(([name, allowed]) => {
    let prevPassed = true;
    chains[name].forEach((b, i) => {
      const key = bdKey(b), sub = subs[key], ov = overrides[key];
      let open, passed, reason = null;
      if (admin) { open = true; passed = true; }
      else if (!allowed) { open = false; passed = false; reason = 'level'; }
      else { open = i === 0 || prevPassed; if (!open) reason = 'order'; passed = passes(sub, settings); }
      if (!admin && ov === 'unlock' && !open) { open = true; reason = null; }
      if (!admin && ov === 'lock') { open = false; reason = 'admin'; }
      out[key] = { open, passed: open && passed, reason, override: ov || null };
      prevPassed = open && passed;
    });
  });
  return out;
}

// a lesson ('ch1-3') or a breakdown ('bd:abc') by its key
function findItem(content, key) {
  if (/^bd:/.test(key)) {
    const b = (content.breakdowns || []).find((x) => bdKey(x) === key);
    return b ? { kind: 'breakdown', item: b, video: b.video || '' } : null;
  }
  const f = findLesson(content.curriculum, key);
  return f ? { kind: 'lesson', item: f.l, video: f.l.video || '' } : null;
}

module.exports = {
  contentWithDefaults, loadSubs, saveSub, deleteSub, loadOverrides, setOverride,
  levelOf, accessFor, gateFor, findLesson, passes,
  bdKind, bdChains, bdKey, accessForBreakdowns, findItem, BD_TASK,
};
