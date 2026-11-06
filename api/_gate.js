// Who can open what. Every route that hands out lessons or breakdowns, saves progress or takes a
// hand-in asks this file, so the rules live in one place and are enforced on the server.
//
// LESSONS. Chapters run in order (Awakened, Illuminated, Enlightened). A member's level is:
//   - the highest chapter whose Discord role they hold, or the promotion chapter if an admin promoted them
//   - then, on the site: finishing every lesson in their chapter opens the next chapter, unless the next
//     chapter needs a promotion (Enlightened). That one opens when an admin approves a payout certificate.
// Chapters below their level are fully open. Chapters above it aren't sent at all.
// In their own chapter, lessons open one at a time. A lesson with parts (Liquidity part 1, part 2…) opens
// part by part; each part, or each single lesson, needs its notes and homework handed in (or approved,
// if the admin chose "After I approve") before the next one opens.
//
// BREAKDOWNS run every week, oldest first: Weekly Outlook → Monday → … → Friday → Weekly Breakdown → next
// week. Each needs notes and mark-ups handed in before the next opens. Any signed-in level gets them;
// Advanced Breakdowns are their own chain for the top level (Enlightened).
//
// Admins can unlock, lock, or mark done any single item for any member, and that beats the rules above.
const { kv, kvConfigured, loadContent } = require('./_lib');
const { CURRICULUM, DEFAULT_SETTINGS, ROLES, SESSIONS_NOTICE } = require('./_curriculum');

/* ---------- content with built-in defaults ---------- */
async function contentWithDefaults() {
  let c = await loadContent();
  c = c ? Object.assign({}, c) : { homework: [], breakdowns: [], announcements: [] };
  if (!Array.isArray(c.curriculum) || !c.curriculum.length) c.curriculum = JSON.parse(JSON.stringify(CURRICULUM));
  else {
    // lessons saved before parts existed pick up the built-in parts (and the promotion flag)
    const byId = {};
    CURRICULUM.forEach((ch) => { byId[ch.id] = ch; ch.lessons.forEach((l) => { byId[l.id] = l; }); });
    c.curriculum = c.curriculum.map((ch) => Object.assign({}, ch, {
      promotion: ch.promotion !== undefined ? ch.promotion : !!(byId[ch.id] && byId[ch.id].promotion),
      lessons: (ch.lessons || []).map((l) => {
        // Sessions used to be split into "Sessions" + "Indicator Announcement": now it's one video with an announcement banner
        if (Array.isArray(l.parts) && l.parts.length === 2 && l.parts[1].title === 'Indicator Announcement') {
          const p = l.parts[0];
          l = Object.assign({}, l, { video: l.video || p.video || '', summary: l.summary || p.summary || '', homework: l.homework || p.homework || '',
            notice: l.notice || Object.assign({}, SESSIONS_NOTICE, { link: l.parts[1].video || '' }) });
          delete l.parts;
          return l;
        }
        if (l.parts === undefined && byId[l.id] && byId[l.id].parts && byId[l.id].title === l.title) return Object.assign({}, l, { parts: JSON.parse(JSON.stringify(byId[l.id].parts)) });
        if (l.notice === undefined && byId[l.id] && byId[l.id].notice && byId[l.id].title === l.title) return Object.assign({}, l, { notice: Object.assign({}, byId[l.id].notice) });
        return l;
      }),
    }));
  }
  c.settings = Object.assign({}, DEFAULT_SETTINGS, c.settings || {});
  if (!Array.isArray(c.breakdowns)) c.breakdowns = [];
  return c;
}

/* ---------- storage ---------- */
function hashToObj(flat, parse) {
  const out = {};
  if (Array.isArray(flat)) for (let i = 0; i < flat.length; i += 2) {
    if (!parse) { out[flat[i]] = flat[i + 1]; continue; }
    try { out[flat[i]] = JSON.parse(flat[i + 1]); } catch (e) {}
  }
  return out;
}
async function loadSubs(userId) { return kvConfigured() ? hashToObj(await kv(['HGETALL', 'subs:' + userId]), true) : {}; }
async function saveSub(userId, key, sub) { await kv(['HSET', 'subs:' + userId, key, JSON.stringify(sub)]); }
async function deleteSub(userId, key) { await kv(['HDEL', 'subs:' + userId, key]); }
async function loadOverrides(userId) { return kvConfigured() ? hashToObj(await kv(['HGETALL', 'unlocks:' + userId]), false) : {}; }
async function setOverride(userId, key, mode) {
  if (mode === 'unlock' || mode === 'lock') await kv(['HSET', 'unlocks:' + userId, key, mode]);
  else await kv(['HDEL', 'unlocks:' + userId, key]);
}
// promotion: { status:'requested'|'approved'|'declined', certId, requestedAt, decidedAt, decidedBy, note }
async function loadPromo(userId) {
  if (!kvConfigured()) return null;
  const raw = await kv(['GET', 'promo:' + userId]);
  try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
async function savePromo(userId, promo) {
  if (promo) await kv(['SET', 'promo:' + userId, JSON.stringify(promo)]);
  else await kv(['DEL', 'promo:' + userId]);
}
// certificates on a member's profile: { id, kind:'payout'|'funded', file:{url,name,type,size}, note, uploadedAt }
async function loadCerts(userId) { return kvConfigured() ? hashToObj(await kv(['HGETALL', 'certs:' + userId]), true) : {}; }
async function saveCert(userId, cert) { await kv(['HSET', 'certs:' + userId, cert.id, JSON.stringify(cert)]); }
async function deleteCert(userId, id) { await kv(['HDEL', 'certs:' + userId, id]); }

/* ---------- lessons: units are what unlock one at a time (a lesson, or each part of a lesson) ---------- */
function unitsOf(lesson) {
  return Array.isArray(lesson.parts) && lesson.parts.length ? lesson.parts : [lesson];
}
function passes(sub, settings) {
  if (!sub) return false;
  if (sub.status === 'approved') return true;
  return sub.status === 'submitted' && (settings.unlockMode || 'submit') === 'submit';
}
function chapterRoles(curriculum) { return (curriculum || []).map((ch) => ch.role).filter(Boolean); }
// the level the member's Discord role alone gives (0 = none of the chapter roles)
function roleLevel(curriculum, roles) {
  let lvl = 0;
  (curriculum || []).forEach((ch, i) => { if (ch.role && (roles || []).includes(ch.role)) lvl = i + 1; });
  return lvl;
}
function promotionStep(curriculum) {
  const i = (curriculum || []).findIndex((ch) => ch.promotion);
  return i === -1 ? 0 : i + 1;
}
function chapterDone(ch, subs, overrides, settings) {
  return (ch.lessons || []).every((l) => unitsOf(l).every((u) => overrides[u.id] !== 'lock' && passes(subs[u.id], settings)));
}
// level = role (or promotion), then any chapters finished on the site, stopping before a promotion chapter
function levelFor({ curriculum, roles, promo, subs, overrides, settings }) {
  let lvl = roleLevel(curriculum, roles);
  const pStep = promotionStep(curriculum);
  if (promo && promo.status === 'approved' && pStep) lvl = Math.max(lvl, pStep);
  if (lvl < 1) return 0;                                   // no chapter role: nothing (Grounded can't sign in anyway)
  while (lvl < curriculum.length) {
    const next = curriculum[lvl];
    if (next.promotion && !(promo && promo.status === 'approved')) break;
    if (!chapterDone(curriculum[lvl - 1], subs, overrides, settings)) break;
    lvl += 1;
  }
  return lvl;
}

// { level, canPromote, lessons: { [unitId or lessonId]: { open, passed, reason } } }
// reason: 'hidden' (chapter above their level, not sent), 'order' (finish the previous one first), 'admin' (locked by an admin)
function accessFor({ curriculum, settings, roles, subs, overrides, promo, admin }) {
  const level = admin ? curriculum.length : levelFor({ curriculum, roles, promo, subs, overrides, settings });
  const out = {};
  (curriculum || []).forEach((ch, ci) => {
    const step = ci + 1;
    let prevPassed = true;
    (ch.lessons || []).forEach((l) => {
      const us = unitsOf(l);
      us.forEach((u) => {
        const ov = overrides[u.id];
        let open, passed, reason = null;
        if (admin || step < level) { open = true; passed = true; }
        else if (step > level) { open = false; passed = false; reason = 'hidden'; }
        else { open = prevPassed; if (!open) reason = 'order'; passed = passes(subs[u.id], settings); }
        if (!admin && ov === 'unlock' && !open) { open = true; reason = null; }
        if (!admin && ov === 'lock') { open = false; reason = 'admin'; }
        out[u.id] = { open, passed: open && passed, reason, override: ov || null };
        prevPassed = open && passed;
      });
      if (us[0] !== l) {   // the parent row of a lesson with parts
        const ps = us.map((u) => out[u.id]);
        out[l.id] = { open: ps.some((p) => p.open), passed: ps.every((p) => p.passed), reason: ps.some((p) => p.open) ? null : ps[0].reason, parent: true };
      }
    });
  });
  const pStep = promotionStep(curriculum);
  const promoted = !!(promo && promo.status === 'approved');
  const canPromote = !admin && pStep > 1 && !promoted && level === pStep - 1
    && chapterDone(curriculum[pStep - 2], subs, overrides, settings);
  return { level, canPromote, promotionStep: pStep, lessons: out };
}

/* ---------- breakdowns ---------- */
const DAY_RANK = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5 };
const KIND_RANK = { outlook: 0, weekly: 6 };   // the Weekly Outlook opens the week, before Monday
const BD_TASK = {
  daily: 'Mark up today\'s chart the way it was broken down: the range, the liquidity taken, your entry, stop and target. Upload a screenshot of your mark-up.',
  weekly: 'Mark up the week: the weekly range, the key highs and lows, and what each day did. Upload a screenshot of your mark-up.',
  outlook: 'Mark up your plan for next week: key levels, your bias, and what you need to see before you take a trade. Upload a screenshot of your mark-up.',
  advanced: 'Mark up the chart from this breakdown and explain each step in your own words. Upload a screenshot of your mark-up.',
};
function bdKind(b) { return ['daily', 'weekly', 'outlook', 'advanced'].includes(b && b.kind) ? b.kind : 'daily'; }
function bdOrderKey(b) {
  const k = bdKind(b);
  const rank = k === 'daily' ? (DAY_RANK[b.day] || 1) : (k in KIND_RANK ? KIND_RANK[k] : 8);
  return String(b.week || (b.createdAt || '').slice(0, 10) || '0000-00-00') + '|' + rank + '|' + String(b.createdAt || '');
}
function bdChains(breakdowns) {
  const list = (breakdowns || []).slice().sort((a, b) => bdOrderKey(a).localeCompare(bdOrderKey(b)));
  return { main: list.filter((b) => bdKind(b) !== 'advanced'), advanced: list.filter((b) => bdKind(b) === 'advanced') };
}
function bdKey(b) { return 'bd:' + b.id; }
function accessForBreakdowns({ breakdowns, level, top, settings, subs, overrides, admin }) {
  const out = {};
  const chains = bdChains(breakdowns);
  [['main', level >= 1], ['advanced', level >= top]].forEach(([name, allowed]) => {
    let prevPassed = true;
    chains[name].forEach((b, i) => {
      const key = bdKey(b), ov = overrides[key];
      let open, passed, reason = null;
      if (admin) { open = true; passed = true; }
      else if (!allowed) { open = false; passed = false; reason = name === 'advanced' ? 'hidden' : 'level'; }
      else { open = i === 0 || prevPassed; if (!open) reason = 'order'; passed = passes(subs[key], settings); }
      if (!admin && ov === 'unlock' && !open) { open = true; reason = null; }
      if (!admin && ov === 'lock') { open = false; reason = 'admin'; }
      out[key] = { open, passed: open && passed, reason, override: ov || null };
      prevPassed = open && passed;
    });
  });
  return out;
}

/* ---------- homework assignments ----------
   An assignment can be linked to lectures. Members only see it once one of those lectures is open for them
   (no lectures linked = everyone sees it). Handing it in works like a lesson hand-in, under the key 'hw:<id>'. */
function accessForHomework({ homework, lessons, settings, subs, admin }) {
  const out = {};
  (homework || []).forEach((h) => {
    const links = Array.isArray(h.lessons) ? h.lessons : [];
    const open = !!admin || !links.length || links.some((id) => lessons[id] && lessons[id].open);
    const key = 'hw:' + h.id;
    out[key] = { open, passed: open && passes(subs[key], settings), reason: open ? null : 'hidden' };
  });
  return out;
}

/* ---------- journal + psych leaderboard ----------
   journal:<id>  → { rules:[{ id, text }], createdAt, updatedAt }
   jentries:<id> → hash entryId → { id, kind:'trade'|'none', date, time, pair, account, session, contracts, outcome:'tp'|'sl'|'be',
                                    pnl, overview, model, files:[…], followed, createdAt, void }
   Points (the psych leaderboard):
     rules followed + TP                 → 3
     rules followed + SL or BE           → 1
     rules followed + no trades that day → 1
     rules not followed                  → 0   (voided by an admin → 0) */
async function loadJournal(userId) {
  if (!kvConfigured()) return null;
  const raw = await kv(['GET', 'journal:' + userId]);
  try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
async function saveJournal(userId, j) { await kv(['SET', 'journal:' + userId, JSON.stringify(j)]); }
async function loadEntries(userId) { return kvConfigured() ? hashToObj(await kv(['HGETALL', 'jentries:' + userId]), true) : {}; }
async function saveEntry(userId, e) { await kv(['HSET', 'jentries:' + userId, e.id, JSON.stringify(e)]); }
async function deleteEntry(userId, id) { await kv(['HDEL', 'jentries:' + userId, id]); }
function entryPoints(e) {
  if (!e || e.void || !e.followed) return 0;
  if (e.kind === 'none') return 1;
  return e.outcome === 'tp' ? 3 : 1;
}

/* ---------- everything for one member ---------- */
async function memberState(userId, roles, admin, content) {
  content = content || await contentWithDefaults();
  const [subs, overrides, promo] = await Promise.all([loadSubs(userId), loadOverrides(userId), loadPromo(userId)]);
  const args = { curriculum: content.curriculum, settings: content.settings, roles: roles || [], subs, overrides, promo, admin };
  const access = accessFor(args);
  access.breakdowns = accessForBreakdowns({ breakdowns: content.breakdowns, level: access.level, top: content.curriculum.length,
    settings: content.settings, subs, overrides, admin });
  access.homework = accessForHomework({ homework: content.homework, lessons: access.lessons, settings: content.settings, subs, admin });
  access.all = Object.assign({}, access.lessons, access.breakdowns, access.homework);
  return { content, subs, overrides, promo, access };
}
async function gateFor(session, admin) { return memberState(session.user.id, session.roles || [], admin); }

// a lesson ('ch1-3'), a lesson part ('ch1-7p2') or a breakdown ('bd:abc'), by its key
function findItem(content, key) {
  if (/^hw:/.test(key)) {
    const h = (content.homework || []).find((x) => 'hw:' + x.id === key);
    return h ? { kind: 'homework', item: h, video: '' } : null;
  }
  if (/^bd:/.test(key)) {
    const b = (content.breakdowns || []).find((x) => bdKey(x) === key);
    return b ? { kind: 'breakdown', item: b, video: b.video || '' } : null;
  }
  for (const ch of content.curriculum || []) for (const l of ch.lessons || []) {
    if (l.id === key && !(l.parts && l.parts.length)) return { kind: 'lesson', item: l, video: l.video || '' };
    for (const p of l.parts || []) if (p.id === key) return { kind: 'part', item: p, lesson: l, video: p.video || '' };
  }
  return null;
}
// Can this Discord account use the site? Admins always; members need a chapter role
// (Awakened, Illuminated or Enlightened). Grounded is free Discord access only.
// Returns null when they're allowed, or the reason they're not: 'grounded' or 'no_access'.
async function signInBlock(userId, roles, admin) {
  if (admin) return null;
  let curriculum = CURRICULUM;
  try { curriculum = (await contentWithDefaults()).curriculum; } catch (e) {}
  const allowed = chapterRoles(curriculum).concat([ROLES.awakened, ROLES.illuminated, ROLES.enlightened]);
  if ((roles || []).some((r) => allowed.includes(r))) return null;
  return (roles || []).includes(ROLES.grounded) ? 'grounded' : 'no_access';
}

// every unit and breakdown key in order (for admin panels)
function allKeys(content) {
  const keys = [];
  (content.curriculum || []).forEach((ch) => ch.lessons.forEach((l) => unitsOf(l).forEach((u) => keys.push(u.id))));
  const c = bdChains(content.breakdowns);
  c.main.concat(c.advanced).forEach((b) => keys.push(bdKey(b)));
  return keys;
}

module.exports = {
  ROLES, contentWithDefaults,
  loadSubs, saveSub, deleteSub, loadOverrides, setOverride, loadPromo, savePromo, loadCerts, saveCert, deleteCert,
  unitsOf, passes, chapterRoles, roleLevel, promotionStep, levelFor, accessFor,
  bdKind, bdChains, bdKey, bdOrderKey, accessForBreakdowns, BD_TASK,
  memberState, gateFor, findItem, allKeys, signInBlock, accessForHomework,
  loadJournal, saveJournal, loadEntries, saveEntry, deleteEntry, entryPoints,
};
