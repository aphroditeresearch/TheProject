// Admin only.
// GET  /api/admin/members → everyone who has signed in: roles, level, completions, flags, hand-ins,
//                           items unlocked/locked by hand, certificates and promotion requests.
// POST { action:'review', userId, lessonId, status:'approved'|'returned', feedback }
//      → approve a hand-in, or send it back with feedback (sent-back work doesn't unlock the next item)
// POST { action:'override', userId, lessonId, mode:'unlock'|'lock'|null }
//      → open or close one lesson part / lesson / breakdown for one member (null = back to the usual rules)
// POST { action:'complete', userId, keys:[…], done:true|false }
//      → mark items done for a member (work done off site), or undo that
// POST { action:'promote', userId, promote:true|false, note }
//      → promote a member to the next level (Enlightened), or decline / take back a promotion
// POST { action:'bulk', userIds:[…], keys:[…], op:'unlock'|'lock'|'reset'|'done'|'undone'|'unlock-done' }
//      → the same change for many members and many items at once
// POST { action:'clear-handins' } → delete every hand-in members submitted (items an admin marked done are kept)
// POST { action:'cert-review', userId, certId, status:'approved'|'denied'|'pending', amount, note } → certify a payout (it then
//      counts on the payout leaderboard, with the amount you confirm), or deny it
// POST { action:'journal-review', userId, entryId, status:'approved'|'denied'|'pending', note } → approve a journal entry for the
//      leaderboard, deny it (0 points), or put it back to pending
// GET  ?backup=1 → download everything in the database as one JSON file (admins)
// GET  ?alerts=1      → recent staff alerts (suspicious activity), and whether DISCORD_STAFF_WEBHOOK is set
// POST { action:'staff-test' } → post a test alert to the staff channel
// GET  ?backup=status → when the last automatic backup ran, and whether a Discord backup channel is set up
// GET  ?cron=backup → the daily automatic backup (Vercel Cron, needs CRON_SECRET): posts a compressed copy to the private
//                     Discord channel in DISCORD_BACKUP_WEBHOOK
// GET  ?testimonials=1 → every testimonial (any status) + whether the Discord channels are connected
// POST { action:'testimonial-review', id, status:'approved'|'denied'|'pending', post:true|false, note } → approve (shows on the
//      Wins tab; posts to DISCORD_TESTIMONIAL_WEBHOOK unless post is false) or deny. Admins can't edit what a member wrote.
// POST { action:'testimonial-remove', id } → take a testimonial down
// Certifying a payout (cert-review approved) posts it to DISCORD_PAYOUT_WEBHOOK when the member allowed sharing (post:false skips)
// GET  ?snippets=1 / POST { action:'snippets', snippets:[…] } → the saved feedback lines admins tap into reviews
// POST { action:'restore', keys:{…}, mode:'missing'|'all', confirm:'RESTORE' } → put keys from a backup file back
const { kvPipeline, KEY_PREFIX, staffAlert, clientIp, loadAlerts, staffHook } = require('../_lib');
const zlib = require('zlib');
const { readSession, isAdmin, adminIds, kvConfigured, kv, listMembers, loadProgress, saveProgress, loadFlags, json } = require('../_lib');
const { nyToday, loadActivity, saveCert, contentWithDefaults, memberState, loadSubs, saveSub, deleteSub, setOverride, loadCerts, loadPromo, savePromo, findItem, loadJournal, loadEntries, saveEntry, entryPoints, lastWorkOf, loadDayNotes, loadTestimonials, saveTestimonial, deleteTestimonial, hookReady, discordPost, testimonialPayload, payoutPayload, loadFeedSettings, entryStatus, basePoints } = require('../_gate');
const { signAll, makeSigner } = require('../_blob');
const C = require('../_coach');

const ID = /^\d{5,25}$/;
const KEY = /^(bd:|hw:)?[\w-]{1,64}$/;

// mark done / undo for one member (shared by 'complete' and 'bulk')
async function setDone(userId, keys, done, who) {
  const now = new Date().toISOString();
  const subs = await loadSubs(userId);
  for (const k of keys) {
    if (done) {
      const prev = subs[k];
      if (!prev || prev.status !== 'approved') {
        await saveSub(userId, k, Object.assign({ notes: '', homework: '', files: [], attempts: 0, submittedAt: now }, prev || {},
          { status: 'approved', offsite: !prev, reviewedAt: now, reviewer: who, feedback: prev ? prev.feedback || '' : 'Marked done by an admin.' }));
      }
      await saveProgress(userId, k, now);
    } else {
      await deleteSub(userId, k);
      await saveProgress(userId, k, null);
    }
  }
}
// delete every hand-in members submitted; keep the ones an admin marked done
async function clearHandins() {
  let n = 0;
  for (const m of await listMembers()) {
    const subs = await loadSubs(m.id);
    for (const [k, sb] of Object.entries(subs)) { if (!sb || !sb.offsite) { await deleteSub(m.id, k); n++; } }
  }
  return n;
}


/* ---------- backups ----------
   Every key under this site's prefix, with its type and value. Caches (they rebuild themselves) are left out. */
const SKIP = /^(waiting-cache|stats-cache|wins-cache)$/;
// feedback lines an admin can drop into any review with one tap (until the admins save their own list)
const DEFAULT_SNIPPETS = [
  'Great work. Clean execution and you followed your rules.',
  'Add a screenshot of your entry timeframe with your mark-ups.',
  'Mark your HTF bias on the chart before you take the trade.',
  'Show what liquidity was swept before your entry.',
  'Good patience sitting this one out.',
  'This broke your rules. Re-read them before your next session.',
  'Log the news for the day and how price reacted to it.',
  'Rewatch the lecture and redo this with more detail.',
];
async function snapshot() {
  const names = []; let cursor = '0', guard = 0;
  do {
    const [r] = await kvPipeline([['SCAN', cursor, 'MATCH', KEY_PREFIX + '*', 'COUNT', '1000']]);
    cursor = String(r[0]); (r[1] || []).forEach((k) => names.push(k)); guard++;
  } while (cursor !== '0' && guard < 500);
  const keys = [...new Set(names)].filter((k) => !SKIP.test(k.slice(KEY_PREFIX.length))).sort();
  const out = {};
  for (let i = 0; i < keys.length; i += 200) {
    const part = keys.slice(i, i + 200);
    const types = await kvPipeline(part.map((k) => ['TYPE', k]));
    const reads = part.map((k, j) => {
      const t = types[j];
      if (t === 'string') return ['GET', k];
      if (t === 'hash') return ['HGETALL', k];
      if (t === 'list') return ['LRANGE', k, '0', '-1'];
      if (t === 'set') return ['SMEMBERS', k];
      if (t === 'zset') return ['ZRANGE', k, '0', '-1', 'WITHSCORES'];
      return ['TYPE', k];
    });
    const vals = await kvPipeline(reads);
    part.forEach((k, j) => {
      const t = types[j]; if (!['string', 'hash', 'list', 'set', 'zset'].includes(t)) return;
      let v = vals[j];
      if (t === 'hash' && Array.isArray(v)) { const o = {}; for (let n = 0; n < v.length; n += 2) o[v[n]] = v[n + 1]; v = o; }
      out[k.slice(KEY_PREFIX.length)] = { type: t, value: v };
    });
  }
  return { app: 'theproject', version: 1, at: new Date().toISOString(), count: Object.keys(out).length, keys: out };
}
// write keys back.
//   mode 'missing' (safe): adds back whatever is gone and changes nothing that exists: missing keys, plus missing
//                          fields inside hashes (e.g. one deleted journal entry or hand-in) and missing set members
//   mode 'all': the keys in the file replace the current ones (keys that aren't in the file are never touched)
async function restoreKeys(keys, mode) {
  const names = Object.keys(keys || {}).filter((k) => typeof k === 'string' && k.length < 300 && !SKIP.test(k));
  let written = 0, skipped = 0;
  for (let i = 0; i < names.length; i += 100) {
    const part = names.slice(i, i + 100);
    const exists = mode === 'missing' ? await kvPipeline(part.map((k) => ['EXISTS', KEY_PREFIX + k])) : part.map(() => 0);
    const cmds = [], counted = [];
    const push = (c, count) => { cmds.push(c); counted.push(count); };
    part.forEach((k, j) => {
      const e = keys[k], key = KEY_PREFIX + k, v = e && e.value, had = !!exists[j];
      if (!e) { skipped++; return; }
      if (e.type === 'string' && v !== null && v !== undefined) { if (had) { skipped++; return; } push(['SET', key, String(v)], 'one'); }
      else if (e.type === 'hash' && v && typeof v === 'object') {
        const f = Object.keys(v); if (!f.length) { skipped++; return; }
        if (had) f.forEach((x) => push(['HSETNX', key, x, String(v[x])], 'field'));          // only fields that are gone
        else { const all = []; f.forEach((x) => all.push(x, String(v[x]))); push(['DEL', key], 'none'); push(['HSET', key].concat(all), 'one'); }
      }
      else if (e.type === 'set' && Array.isArray(v) && v.length) { if (had) push(['SADD', key].concat(v.map(String)), 'field'); else { push(['DEL', key], 'none'); push(['SADD', key].concat(v.map(String)), 'one'); } }
      else if (e.type === 'list' && Array.isArray(v) && v.length) { if (had) { skipped++; return; } push(['DEL', key], 'none'); push(['RPUSH', key].concat(v.map(String)), 'one'); }
      else if (e.type === 'zset' && Array.isArray(v) && v.length) { if (had) { skipped++; return; } const z = []; for (let n = 0; n < v.length; n += 2) z.push(String(v[n + 1]), String(v[n])); push(['DEL', key], 'none'); push(['ZADD', key].concat(z), 'one'); }
      else skipped++;
    });
    if (!cmds.length) continue;
    const res = await kvPipeline(cmds);
    res.forEach((r, n) => { if (counted[n] === 'one') written++; else if (counted[n] === 'field') { if (+r > 0) written += +r; } });
  }
  return { written, skipped };
}
// daily: a compressed copy goes to a private Discord channel (outside Vercel and Upstash), and the result is noted
// End-of-day nudge in Discord (DISCORD_RECAP_WEBHOOK): who journaled, the group's P&L and rules kept, and an @mention for
// every student who hasn't journaled today. Runs from Vercel Cron on weekdays, or from Admin → Coaching → "Send today's now".
async function dailyNudge() {
  const hook = process.env.DISCORD_RECAP_WEBHOOK || '';
  if (!hookReady(hook)) return { ok: false, error: 'no_webhook' };
  const today = nyToday(), wd = new Date(today + 'T12:00:00Z').getUTCDay();
  if (wd === 0 || wd === 6) return { ok: true, skipped: 'weekend' };
  // students only: not admins, not moderators
  const mods = String(process.env.MOD_IDS || '505505326532132868').split(',').map((x) => x.trim());
  const admins = adminIds(), everyone = await listMembers(), members = everyone.filter((m) => !admins.includes(m.id) && !mods.includes(m.id));
  let journaled = 0, total = 0, pnl = 0, followed = 0, answered = 0; const missing = [], clean = [], warn = {};
  const content = await contentWithDefaults().catch(() => null), now = Date.now();
  const dayAgo = new Date(now - 864e5).toISOString(), quiet = new Date(now - 5 * 864e5).toISOString(), bdDue = new Date(now - 3 * 864e5).toISOString();
  await Promise.all(members.map(async (m) => {
    total++;   // every student, journal set up or not: everyone is expected to journal each trading day
    const why = [];
    const [j, all, tmeta, progress] = await Promise.all([loadJournal(m.id), loadEntries(m.id), C.threadMeta(m.id).catch(() => ({})), loadProgress(m.id).catch(() => ({}))]);
    const ents = j ? Object.values(all).filter((e) => e.date === today && entryStatus(e) !== 'denied') : [];
    if (!ents.length) { missing.push(m.id); why.push('lack of journals'); }
    else {
      journaled++;
      ents.forEach((e) => { if (typeof e.followed === 'boolean') { answered++; if (e.followed) followed++; } });
      if (ents.every((e) => e.followed === true)) clean.push(m.displayName || m.username || 'A student');
    }
    // the breakdown they're on (open, not handed in) has been out for 3+ days with no notes
    let st = null; try { if (content) st = await memberState(m.id, m.roles || [], false, content); } catch (e) {}
    if (st && content) {
      const late = (content.breakdowns || []).some((b) => { const k = 'bd:' + b.id, a = st.access.breakdowns[k];
        return a && a.open && !a.passed && !st.subs[k] && String(b.createdAt || '') && String(b.createdAt) < bdDue; });
      if (late) why.push('lack of breakdown notes');
    }
    // a mentor wrote to them over a day ago and they haven't answered
    if (Object.values(tmeta || {}).some((t) => t && t.last && t.last.staff && String(t.last.at || '') < dayAgo)) why.push('no response');
    // nothing on the site for 5+ days (not signed in and no work)
    const lastAny = [m.lastSeen || '', lastWorkOf(st ? st.subs : {}, all, progress) || ''].sort().pop();
    if (!lastAny || lastAny < quiet) why.push('inactivity');
    if (why.length) warn[m.id] = why;
  }));
  if (!total) return { ok: true, skipped: 'no_journals' };
  // group P&L: exactly what Stats → Everyone combined → Today shows (every journal, staff included, funded + evaluation, not denied)
  await Promise.all(everyone.map(async (m) => {
    Object.values(await loadEntries(m.id)).forEach((e) => {
      if (e.kind === 'trade' && e.date === today && entryStatus(e) !== 'denied' && /^(funded|evaluation)$/i.test(String(e.account || '').trim())) pnl += +e.pnl || 0; });
  }));
  pnl = Math.round(pnl * 100) / 100;
  const day = new Date(today + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const money = (n) => (n < 0 ? '−$' : '+$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const lines = ['📊 **Daily recap · ' + day + '**',
    '✅ ' + journaled + ' of ' + total + ' students journaled' + (answered ? ' · rules kept ' + Math.round(followed / answered * 100) + '%' : ''),
    '💰 Group P&L (funded + evaluation): ' + money(pnl)];
  if (clean.length) lines.push('🏆 Kept every rule today: ' + clean.slice(0, 15).map((n) => '**' + n.replace(/[*_`~|]/g, '') + '**').join(', '));
  // everyone with at least one reason gets a warning (most urgent first: the more reasons, the higher)
  const ping = Object.keys(warn).sort((a, b) => warn[b].length - warn[a].length).slice(0, 100);
  if (!missing.length) lines.push('🔥 Everyone journaled today. That\'s how it\'s done.');
  else lines.push('⏰ ' + missing.length + (missing.length === 1 ? ' student still has' : ' students still have') + ' to journal today.');
  if (ping.length) lines.push('⚠️ Warnings:');
  const r = await discordPost(hook, { content: lines.join('\n').slice(0, 1990), allowed_mentions: { parse: [] } });
  // one line per student, tagging them. The wording comes from NUDGE_MESSAGE: "@member" = the tag, "@reason" = why.
  const tpl = String(process.env.NUDGE_MESSAGE || "@member, you're on a warning. If you continue the lack of effort, you will be demoted. Reason why: @reason").slice(0, 300);
  const say = (id) => { const reason = warn[id].join(', '); let t = tpl.indexOf('@member') >= 0 ? tpl.split('@member').join('<@' + id + '>') : '<@' + id + '> ' + tpl;
    return t.indexOf('@reason') >= 0 ? t.split('@reason').join(reason) : t + ' Reason why: ' + reason; };
  let chunk = [], sent = 0;
  const flush = async () => {
    if (!chunk.length) return;
    const ids = chunk.map((x) => x.id);
    const rr = await discordPost(hook, { content: chunk.map((x) => x.line).join('\n'), allowed_mentions: { parse: [], users: ids } });
    if (rr.ok) sent += ids.length;
    chunk = []; await new Promise((ok) => setTimeout(ok, 600));   // stay under Discord's webhook rate limit
  };
  for (const id of ping) {
    const line = say(id);
    if (chunk.length >= 20 || chunk.reduce((t, x) => t + x.line.length + 1, 0) + line.length > 1900) await flush();
    chunk.push({ id, line });
  }
  await flush();
  await kv(['SET', 'nudge-last', JSON.stringify({ at: new Date().toISOString(), ok: r.ok, journaled, total, tagged: sent, warned: ping.length })]);
  return Object.assign({ journaled, total, missing: missing.length, tagged: sent, warned: ping.length }, r);
}
async function cronBackup() {
  const hook = process.env.DISCORD_BACKUP_WEBHOOK || '';
  const status = { at: new Date().toISOString(), ok: false };
  try {
    const snap = await snapshot();
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(snap)));
    status.count = snap.count; status.bytes = gz.length;
    if (!/^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\//.test(hook)) throw new Error('DISCORD_BACKUP_WEBHOOK is not set');
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(status.at));
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify({ content: '🗄️ Daily backup · ' + day + ' · ' + snap.count + ' records · ' + Math.ceil(gz.length / 1024) + ' KB' }));
    fd.append('files[0]', new Blob([gz], { type: 'application/gzip' }), 'theproject-backup-' + day + '.json.gz');
    const r = await fetch(hook, { method: 'POST', body: fd });
    if (!r.ok) throw new Error('Discord said ' + r.status);
    status.ok = true;
  } catch (e) { status.error = String((e && e.message) || e).slice(0, 200); }
  try { await kv(['SET', 'backup-status', JSON.stringify(status)]); } catch (e) {}
  return status;
}

module.exports = async (req, res) => {
  // the daily automatic backup comes from Vercel Cron, not a signed-in admin
  if (/[?&]cron=nudge\b/.test(req.url || '')) {
    const secret = process.env.CRON_SECRET || '';
    if (!secret || (req.headers.authorization || '') !== 'Bearer ' + secret) return json(res, 401, { error: 'not_cron' });
    if (!kvConfigured()) return json(res, 503, { error: 'no_storage' });
    const st = await dailyNudge();
    return json(res, st.ok ? 200 : 500, st);
  }
  if (/[?&]cron=backup\b/.test(req.url || '')) {
    const secret = process.env.CRON_SECRET || '';
    if (!secret || (req.headers.authorization || '') !== 'Bearer ' + secret) return json(res, 401, { error: 'not_cron' });
    if (!kvConfigured()) return json(res, 503, { error: 'no_storage' });
    const st = await cronBackup();
    return json(res, st.ok ? 200 : 500, st);
  }
  const s = readSession(req);
  if (!s) return json(res, 401, { error: 'signed_out' });
  if (!isAdmin(s)) { await staffAlert('admin-probe', { id: s.user.id, name: s.user.displayName || s.user.username, ip: clientIp(req) }, req.method + ' ' + String(req.url || '').slice(0, 120)); return json(res, 403, { error: 'not_admin' }); }
  if (!kvConfigured()) return json(res, 503, { error: 'no_storage' });
  const who = s.user.displayName || s.user.username || s.user.id;

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body !== 'object') return json(res, 400, { error: 'bad_body' });
    if (body.action === 'testimonial-review') {
      const t = (await loadTestimonials())[String(body.id || '')];
      if (!t) return json(res, 404, { error: 'not_found' });
      if (!['approved', 'denied', 'pending'].includes(body.status)) return json(res, 400, { error: 'bad_status' });
      t.status = body.status; t.reviewedAt = body.status === 'pending' ? null : new Date().toISOString(); t.reviewedBy = body.status === 'pending' ? null : who;
      t.note = body.status === 'denied' && typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';
      let discord = null;
      if (t.status === 'approved' && body.post !== false && !t.posted) {
        discord = await discordPost(process.env.DISCORD_TESTIMONIAL_WEBHOOK, testimonialPayload(t, (await loadFeedSettings()).testimonials));
        if (discord.ok) { t.posted = true; t.postedAt = new Date().toISOString(); }
      }
      await saveTestimonial(t);
      return json(res, 200, { saved: true, testimonial: t, discord });
    }
    if (body.action === 'feed-settings') {   // who the Discord feeds tag
      const ok = (v) => (['none', 'here', 'everyone'].includes(v) || /^\d{5,25}$/.test(String(v || '')) ? String(v) : 'none');
      const v = { testimonials: ok(body.testimonials), payouts: ok(body.payouts) };
      await kv(['SET', 'feed-settings', JSON.stringify(v)]);
      return json(res, 200, { saved: true, feeds: v });
    }
    if (body.action === 'testimonial-remove') { await deleteTestimonial(String(body.id || '')); return json(res, 200, { saved: true }); }
    if (body.action === 'snippets') {   // saved feedback lines, shared by every admin
      const list = (Array.isArray(body.snippets) ? body.snippets : []).map((x) => String(x || '').trim().slice(0, 300)).filter(Boolean).slice(0, 40);
      await kv(['SET', 'snippets', JSON.stringify(list)]);
      return json(res, 200, { saved: true, snippets: list });
    }
    if (body.action === 'nudge-now') return json(res, 200, await dailyNudge());
    if (body.action === 'staff-test') {   // "send a test alert" (not throttled per kind: a fresh key each time)
      if (!staffHook()) return json(res, 400, { error: 'no_webhook' });
      const ok = await staffAlert('test', { id: s.user.id, name: who }, 'If you can read this in your staff channel, alerts are working.', 1);
      return json(res, 200, { sent: ok });
    }
    if (body.action === 'backup-now') return json(res, 200, await cronBackup());   // "send a backup to Discord now"
    if (body.action === 'restore') {
      if (body.confirm !== 'RESTORE') return json(res, 400, { error: 'confirm' });
      if (!body.keys || typeof body.keys !== 'object') return json(res, 400, { error: 'bad_backup' });
      try { return json(res, 200, Object.assign({ saved: true }, await restoreKeys(body.keys, body.mode === 'all' ? 'all' : 'missing'))); }
      catch (e) { return json(res, 502, { error: 'storage', detail: String(e.message || e).slice(0, 200) }); }
    }
    try { await kv(['DEL', 'waiting-cache']); await kv(['DEL', 'stats-cache']); } catch (e) {}   // counts change after any admin action
    const userId = body && body.userId, lessonId = body && body.lessonId;
    const content = await contentWithDefaults();

    if (body.action === 'clear-handins') return json(res, 200, { saved: true, cleared: await clearHandins() });

    if (body.action === 'bulk') {
      const users = (Array.isArray(body.userIds) ? body.userIds : []).filter((u) => ID.test(String(u))).slice(0, 500);
      const keys = (Array.isArray(body.keys) ? body.keys : []).filter((k) => KEY.test(String(k)) && findItem(content, k)).slice(0, 500);
      const op = body.op;
      if (!users.length || !keys.length) return json(res, 400, { error: 'pick_both' });
      if (!['unlock', 'lock', 'reset', 'done', 'undone', 'unlock-done'].includes(op)) return json(res, 400, { error: 'bad_op' });
      for (const u of users) {
        if (op === 'unlock' || op === 'lock' || op === 'unlock-done') for (const k of keys) await setOverride(u, k, op === 'lock' ? 'lock' : 'unlock');
        if (op === 'reset') for (const k of keys) await setOverride(u, k, null);
        if (op === 'done' || op === 'unlock-done') await setDone(u, keys, true, who);
        if (op === 'undone') await setDone(u, keys, false, who);
      }
      return json(res, 200, { saved: true, members: users.length, items: keys.length });
    }

    if (!ID.test(String(userId || ''))) return json(res, 400, { error: 'bad_target' });

    if (body.action === 'cert-review') {
      const certs = await loadCerts(userId);
      const c = certs[String(body.certId || '')];
      if (!c || c.kind !== 'payout') return json(res, 404, { error: 'no_cert' });
      const status = body.status;
      if (!['approved', 'denied', 'pending'].includes(status)) return json(res, 400, { error: 'bad_status' });
      const amount = Math.round(Number(body.amount !== undefined && body.amount !== '' ? body.amount : c.amount) * 100) / 100;
      if (status === 'approved' && !(amount > 0 && amount < 10000000)) return json(res, 400, { error: 'need_amount' });
      c.review = { status, amount: status === 'approved' ? amount : (c.review && c.review.amount) || null, by: status === 'pending' ? null : who,
        at: status === 'pending' ? null : new Date().toISOString(), note: typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '' };
      // certified: post it to the Discord payouts channel (once), if the member allowed sharing
      let discord = null;
      if (status === 'approved' && body.post !== false && c.share !== false && !c.posted) {
        const ms = (await listMembers()).find((x) => x.id === userId) || {};
        let file = null, imgName = '';
        // the certificate itself: only if the member didn't say no; the admin can leave it out (body.image === false),
        // and can include it on certificates uploaded before members were asked (shareImage undefined)
        const withImage = c.shareImage === false ? false : body.image !== undefined ? !!body.image : !!c.shareImage;
        const kindOk = c.file && /^(image\/(png|jpeg|webp|gif)|application\/pdf)$/.test(c.file.type || '');
        if (withImage && kindOk && (c.file.size || 0) < 9.5 * 1024 * 1024) {
          try {
            const sign = await makeSigner(req); const url = sign ? await sign(c.file.url) : c.file.url;
            const r = await fetch(url);
            if (r.ok) { const buf = Buffer.from(await r.arrayBuffer());
              if (buf.length < 9.5 * 1024 * 1024) { const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' }[c.file.type];
                file = { buf, type: c.file.type, name: 'payout-certificate.' + ext }; if (ext !== 'pdf') imgName = file.name; } }
          } catch (e) {}
        }
        discord = await discordPost(process.env.DISCORD_PAYOUT_WEBHOOK, payoutPayload(ms.displayName || ms.username || 'A student', ms.avatar, c, imgName, (await loadFeedSettings()).payouts), file);
        if (discord && withImage && !file) discord.note = 'image_skipped';
        if (discord.ok) { c.posted = true; c.postedAt = new Date().toISOString(); }
      }
      await saveCert(userId, c);
      try { await kv(['DEL', 'wins-cache']); } catch (e) {}
      return json(res, 200, { saved: true, cert: c, discord });
    }
    if (body.action === 'journal-review' || body.action === 'journal-void') {
      const entries = await loadEntries(userId);
      const e = entries[String(body.entryId || '')];
      if (!e) return json(res, 404, { error: 'no_entry' });
      const status = body.action === 'journal-void' ? (body.void ? 'denied' : 'approved') : body.status;
      if (!['approved', 'denied', 'pending'].includes(status)) return json(res, 400, { error: 'bad_status' });
      e.status = status; e.void = status === 'denied';
      // approving: the points to give (an admin can give less than it's worth, e.g. 1 for a paper trade); otherwise none
      if (status === 'approved') { const p = Number(body.points); e.awarded = isFinite(p) && body.points !== undefined && body.points !== null && body.points !== '' ? Math.max(0, Math.min(10, Math.round(p * 2) / 2)) : basePoints(e); }
      else delete e.awarded;
      e.reviewedBy = status === 'pending' ? null : who; e.reviewedAt = status === 'pending' ? null : new Date().toISOString();
      e.reviewNote = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
      await saveEntry(userId, e);
      return json(res, 200, { saved: true, status });
    }

    if (body.action === 'promote') {
      const prev = await loadPromo(userId);
      const now = new Date().toISOString();
      const promo = Object.assign({ certId: null, requestedAt: null }, prev || {},
        { status: body.promote ? 'approved' : 'declined', decidedAt: now, decidedBy: who, note: typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '' });
      await savePromo(userId, promo);
      return json(res, 200, { saved: true, promo });
    }

    if (body.action === 'complete') {
      const keys = (Array.isArray(body.keys) ? body.keys : []).filter((k) => KEY.test(String(k)) && findItem(content, k)).slice(0, 500);
      if (!keys.length) return json(res, 400, { error: 'no_keys' });
      await setDone(userId, keys, !!body.done, who);
      return json(res, 200, { saved: true, count: keys.length });
    }

    if (!KEY.test(String(lessonId || ''))) return json(res, 400, { error: 'bad_target' });

    // reviewing only needs the hand-in itself: it still works if the lesson was renamed, split or removed since
    if (body.action === 'review') {
      if (body.status !== 'approved' && body.status !== 'returned') return json(res, 400, { error: 'bad_status' });
      const subs = await loadSubs(userId);
      const sub = subs[lessonId];
      if (!sub) return json(res, 404, { error: 'no_submission' });
      sub.status = body.status;
      sub.feedback = typeof body.feedback === 'string' ? body.feedback.trim().slice(0, 4000) : '';
      sub.reviewedAt = new Date().toISOString();
      sub.reviewer = who;
      await saveSub(userId, lessonId, sub);
      return json(res, 200, { saved: true, sub });
    }
    if (!findItem(content, lessonId)) return json(res, 404, { error: 'no_lesson' });
    if (body.action === 'override') {
      const mode = body.mode === 'unlock' || body.mode === 'lock' ? body.mode : null;
      await setOverride(userId, lessonId, mode);
      return json(res, 200, { saved: true, mode });
    }
    return json(res, 400, { error: 'bad_action' });
  }

  if (req.method !== 'GET') { res.setHeader('Allow', 'GET, POST'); return json(res, 405, { error: 'method' }); }

  if (/[?&]testimonials=1\b/.test(req.url || '')) {
    const list = Object.values(await loadTestimonials()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return json(res, 200, { testimonials: list, feeds: await loadFeedSettings(), hooks: { testimonials: hookReady(process.env.DISCORD_TESTIMONIAL_WEBHOOK), payouts: hookReady(process.env.DISCORD_PAYOUT_WEBHOOK) } });
  }
  if (/[?&]snippets=1\b/.test(req.url || '')) {
    let list = null; try { list = JSON.parse(await kv(['GET', 'snippets']) || 'null'); } catch (e) {}
    return json(res, 200, { snippets: Array.isArray(list) ? list : DEFAULT_SNIPPETS });
  }
  if (/[?&]alerts=1\b/.test(req.url || '')) return json(res, 200, { alerts: await loadAlerts(60), webhook: !!staffHook() });
  if (/[?&]backup=status\b/.test(req.url || '')) {
    let last = null; try { last = JSON.parse(await kv(['GET', 'backup-status']) || 'null'); } catch (e) {}
    return json(res, 200, { last, webhook: !!process.env.DISCORD_BACKUP_WEBHOOK, cron: !!process.env.CRON_SECRET });
  }
  if (/[?&]backup=1\b/.test(req.url || '')) {
    try {
      const snap = await snapshot();
      res.setHeader('Content-Disposition', 'attachment; filename="theproject-backup-' + snap.at.slice(0, 10) + '.json"');
      return json(res, 200, snap);
    } catch (e) { return json(res, 502, { error: 'storage', detail: String(e.message || e).slice(0, 200) }); }
  }
  // notifications: the latest things members handed in, and how much is waiting in each admin section
  if (/[?&]nudge=status/.test(req.url || '')) {
    let last = null; try { last = JSON.parse(await kv(['GET', 'nudge-last']) || 'null'); } catch (e) {}
    return json(res, 200, { webhook: hookReady(process.env.DISCORD_RECAP_WEBHOOK || ''), cron: !!process.env.CRON_SECRET, last });
  }
  if (/[?&]activity=1/.test(req.url || '')) {
    try {
      const events = await loadActivity(80);
      // the waiting counts read every member, so they're worked out at most once a minute and shared by all admins
      const cached = await kv(['GET', 'waiting-cache']);
      if (cached) { try { return json(res, 200, { events, waiting: JSON.parse(cached) }); } catch (e) {} }
      const waiting = { handins: 0, journal: 0, payouts: 0, promotions: 0, quiet: 0, testimonials: 0 };
      try { waiting.testimonials = Object.values(await loadTestimonials()).filter((t) => t.status === 'pending').length; } catch (e) {}
      const admins = adminIds(), quietBefore = new Date(Date.now() - 5 * 864e5).toISOString();
      await Promise.all((await listMembers()).map(async (m) => {
        const [subs, entries, certs, promo, progress] = await Promise.all([loadSubs(m.id), loadEntries(m.id), loadCerts(m.id), loadPromo(m.id), loadProgress(m.id)]);
        // students who haven't journaled, handed in or finished a lecture in 5+ days
        if (!admins.includes(m.id)) { const lw = lastWorkOf(subs, entries, progress) || m.lastSeen || ''; if (lw && lw < quietBefore) waiting.quiet++; }
        waiting.handins += Object.values(subs).filter((x) => x && x.status === 'submitted').length;
        waiting.journal += Object.values(entries).filter((e) => entryStatus(e) === 'pending').length;
        waiting.payouts += Object.values(certs).filter((c) => c.kind === 'payout' && !(c.review && c.review.status !== 'pending')).length;
        if (promo && promo.status === 'requested') waiting.promotions++;
      }));
      await kv(['SET', 'waiting-cache', JSON.stringify(waiting), 'EX', 60]);
      return json(res, 200, { events, waiting });
    } catch (e) { return json(res, 502, { error: 'storage' }); }
  }
  try {
    const content = await contentWithDefaults();
    const members = await listMembers();
    const files = [];
    const [mentors, myUnread] = await Promise.all([C.mentorMap(), C.unreadOf(s.user.id)]);
    const rows = await Promise.all(members.map(async (m) => {
      let journal = null, entries = {};
      let dayNotes = {}; try { journal = await loadJournal(m.id); entries = await loadEntries(m.id); dayNotes = await loadDayNotes(m.id); } catch (e) {}
      let goals = {}, accounts = {}, tmeta = {}; try { [goals, accounts, tmeta] = await Promise.all([C.loadGoals(m.id), C.loadAccounts(m.id), C.threadMeta(m.id)]); } catch (e) {}
      let progress = {}, flags = {}, certs = {}, st = { subs: {}, overrides: {}, promo: null, access: { level: 0, lessons: {}, breakdowns: {}, canPromote: false } };
      try { progress = await loadProgress(m.id); } catch (e) {}
      try { flags = await loadFlags(m.id); } catch (e) {}
      try { certs = await loadCerts(m.id); } catch (e) {}
      try { st = await memberState(m.id, m.roles || [], false, content); } catch (e) {}
      Object.values(st.subs).forEach((sb) => (sb.files || []).forEach((f) => files.push(f)));
      Object.values(certs).forEach((c) => files.push(c.file));
      const ents = Object.values(entries).sort((a, b) => (String(b.date) + (b.time || '')).localeCompare(String(a.date) + (a.time || ''))).map((e) => Object.assign({}, e, { status: entryStatus(e), points: entryPoints(e), worth: basePoints(e) }));
      ents.forEach((e) => (e.files || []).forEach((f) => files.push(f)));
      return Object.assign({}, m, {
        progress, flags, subs: st.subs, overrides: st.overrides, promo: st.promo,
        certs: Object.values(certs).sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt))),
        level: st.access.level, canPromote: st.access.canPromote,
        access: Object.assign({}, st.access.lessons, st.access.breakdowns, st.access.homework || {}), isAdmin: adminIds().includes(m.id),
        journal, entries: ents, dayNotes,
        goals, accounts: Object.values(accounts), tmeta, mentor: C.mentorOf(mentors, m.id),
      });
    }));
    await signAll(req, files, 'url');
    rows.sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
    json(res, 200, { members: rows, unread: myUnread });
  } catch (e) {
    json(res, 502, { error: 'storage' });
  }
};

module.exports = require('../_lib').guard(module.exports, 'json');
