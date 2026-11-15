// The economic calendar, from the free public feed ForexFactory's parent (Fair Economy) publishes for this week.
// Not an official API, so: one copy is kept in Redis and refreshed at most once an hour by whichever member asks
// first (no cron needed); members never contact ForexFactory themselves; every week is also kept so a member's
// record on past releases builds up over time. If the feed fails, the last good copy is served, marked stale.
// The free feed carries forecast and previous values only, no actual results.
const { kv, kvConfigured } = require('./_lib');

// the same feed is served from two hosts; the second is only tried if the first fails
const FEEDS = ['https://nfs.faireconomy.media/ff_calendar_thisweek.json', 'https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json'];
const FRESH_MS = 60 * 60 * 1000;
const IMPACTS = { High: 'high', Medium: 'medium', Low: 'low', Holiday: 'holiday' };

function clean(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((e) => {
    const t = Date.parse(e && e.date); if (!isFinite(t)) return null;
    const title = String(e.title || '').slice(0, 120), cur = String(e.country || '').toUpperCase().slice(0, 4);
    if (!title) return null;
    return { id: (cur + '|' + title + '|' + new Date(t).toISOString()).replace(/[^\w|:.\- ]/g, ''), t: new Date(t).toISOString(),
      title, cur, impact: IMPACTS[e.impact] || 'low', forecast: String(e.forecast || '').slice(0, 24), previous: String(e.previous || '').slice(0, 24) };
  }).filter(Boolean).sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
}
// the trading week a release belongs to, keyed by its Monday (US Eastern, the futures day)
function weekOf(iso) {
  const d = new Date(new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function fetchOne(url) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 7000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': '05project.com journal (calendar, cached hourly)', Accept: 'application/json' } });
    if (!r.ok) throw new Error('feed ' + r.status);
    const ev = clean(await r.json());            // a "too many requests" page is HTML, so this throws and we keep the last copy
    if (!ev.length) throw new Error('feed empty');
    return ev;
  } finally { clearTimeout(to); }
}
async function fetchFeed() {
  let last;
  for (const u of FEEDS) { try { return await fetchOne(u); } catch (e) { last = e; } }
  throw last;
}
// the week most of the releases fall in (a Sunday-evening release belongs to the coming week, not the last one)
function mainWeek(events) {
  const n = {}; events.forEach((e) => { const w = weekOf(e.t); n[w] = (n[w] || 0) + 1; });
  return Object.keys(n).sort((a, b) => n[b] - n[a])[0];
}

async function newsThisWeek() {
  if (!kvConfigured()) return { events: [], stale: true, updated: null };
  let cur = null; try { cur = JSON.parse((await kv(['GET', 'news:now'])) || 'null'); } catch (e) {}
  const age = cur && cur.at ? Date.now() - cur.at : Infinity;
  if (age < FRESH_MS) return { events: cur.events, updated: cur.at, stale: false };
  // one refresh at a time: whoever takes the lock fetches, everyone else gets the copy we have
  // after a failed fetch, wait 10 minutes before asking again (so a busy feed is never hammered)
  let cooling = false; try { cooling = !!(await kv(['GET', 'news:cool'])); } catch (e) {}
  let mine = false; if (!cooling) { try { mine = (await kv(['SET', 'news:lock', '1', 'NX', 'EX', '60'])) === 'OK'; } catch (e) {} }
  if (mine) {
    try {
      const events = await fetchFeed(), at = Date.now();
      await kv(['SET', 'news:now', JSON.stringify({ at, events })]);
      const wk = mainWeek(events);
      await kv(['SET', 'news:wk:' + wk, JSON.stringify(events)]);
      await kv(['SADD', 'news:weeks', wk]);
      return { events, updated: at, stale: false };
    } catch (e) { try { await kv(['SET', 'news:cool', '1', 'EX', '600']); } catch (e2) {} }   // keep the copy we have
  }
  return { events: cur ? cur.events : [], updated: cur ? cur.at : null, stale: true };
}

// past high-impact releases, every week we've kept (for "your record on CPI days")
async function newsHistory() {
  if (!kvConfigured()) return [];
  let weeks = []; try { weeks = (await kv(['SMEMBERS', 'news:weeks'])) || []; } catch (e) { return []; }
  weeks = weeks.sort().slice(-60);
  const out = [];
  for (const w of weeks) {
    let ev = []; try { ev = JSON.parse((await kv(['GET', 'news:wk:' + w])) || '[]'); } catch (e) {}
    ev.forEach((e) => { if (e.impact === 'high') out.push({ t: e.t, title: e.title, cur: e.cur }); });
  }
  return out;
}

// The Federal Reserve's own announcements (monetary policy press releases and speeches), from its public RSS feeds.
// US government material: free to show. Cached 30 minutes, same lock and back-off as the calendar.
const FED_FEEDS = [['policy', 'https://www.federalreserve.gov/feeds/press_monetary.xml'], ['speech', 'https://www.federalreserve.gov/feeds/speeches.xml']];
function rssItems(xml, kind) {
  const out = [], strip = (t) => String(t || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  (String(xml).match(/<item[\s\S]*?<\/item>/g) || []).slice(0, 12).forEach((it) => {
    const g = (tag) => { const m = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>').exec(it); return m ? strip(m[1]) : ''; };
    const title = g('title').slice(0, 200), link = g('link'), t = Date.parse(g('pubDate'));
    if (title && /^https:\/\/www\.federalreserve\.gov\//.test(link) && isFinite(t)) out.push({ kind, title, link, t: new Date(t).toISOString() });
  });
  return out;
}
async function fedNews() {
  if (!kvConfigured()) return [];
  let cur = null; try { cur = JSON.parse((await kv(['GET', 'news:fed'])) || 'null'); } catch (e) {}
  if (cur && Date.now() - cur.at < 30 * 60 * 1000) return cur.items;
  let cooling = false; try { cooling = !!(await kv(['GET', 'news:fedcool'])); } catch (e) {}
  let mine = false; if (!cooling) { try { mine = (await kv(['SET', 'news:fedlock', '1', 'NX', 'EX', '60'])) === 'OK'; } catch (e) {} }
  if (mine) {
    try {
      const all = [];
      for (const [kind, url] of FED_FEEDS) {
        const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 7000);
        try { const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': '05project.com journal (cached)' } }); if (r.ok) rssItems(await r.text(), kind).forEach((x) => all.push(x)); } finally { clearTimeout(to); }
      }
      if (!all.length) throw new Error('fed empty');
      const items = all.sort((a, b) => (a.t < b.t ? 1 : -1)).slice(0, 16);
      await kv(['SET', 'news:fed', JSON.stringify({ at: Date.now(), items })]);
      return items;
    } catch (e) { try { await kv(['SET', 'news:fedcool', '1', 'EX', '600']); } catch (e2) {} }
  }
  return cur ? cur.items : [];
}

module.exports = { fedNews, rssItems, newsThisWeek, newsHistory, weekOf, mainWeek, clean };
