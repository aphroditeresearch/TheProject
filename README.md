# The Project

Members-only site for The Project mentorship.

The page loads straight into a full-screen scene: a glowing diamond floating beside the `THE PROJECT` wordmark as it slams in, over a faint blueprint of a candlestick chart, with a Discord sign-in card. After sign-in, a progress ring and a rubber stamp ("VERIFIED") play, then the member portal opens.

The page itself is plain HTML, CSS and JavaScript with no build step. Sign-in, content and admin run as Vercel functions in `api/`.

## Run it locally

Open `index.html` in Chrome, or serve the folder:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Without the backend, the page runs in demo mode: the button plays the popup and opens a sample portal.

## Files

```
index.html          the whole page
diamond.mp4         the floating diamond beside the wordmark, cropped from the 4K source 
diamond.jpg         still frame of the diamond while the video loads
sample.mp4          widescreen sample clip, only played in the local demo preview
blueprint.svg       faint candlestick-chart blueprint behind the sign-in scene
poster.jpg          still frame while the video loads, profile banner and player background
favicon.svg         browser tab icon (a diamond)
terms.html, privacy.html
blob-upload.js      video upload helper for the Admin tab
api/                Discord sign-in, content and admin routes (Vercel functions)
package.json        Node version and the Vercel Blob package
```

Keep the `api` folder as a folder in the repo. If you upload through GitHub's website, drag the whole `api` folder onto the upload page so it isn't flattened.

## Put it on GitHub and Vercel

```bash
cd the-project
git init
git add .
git commit -m "First version of The Project site"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/the-project.git
git push -u origin main
```

In Vercel, **Add New → Project**, import the repo, leave the build command empty, and deploy. Then add your domain under Project → Settings → Domains.

## Separate from 00 Cleared

This brand shares no state with the 00 Cleared site:

- Cookies: `theproject_session`, `theproject_oauth_state`
- Browser storage: every key starts with `theproject.`
- Give it its **own** Vercel project, Discord application, `SESSION_SECRET`, Upstash Redis database and Blob store. Don't connect the 00 Cleared ones.

## Editing the portal

Everything you edit lives in the **CONFIG** block near the bottom of `index.html`:

- `ROLES`: the Discord role IDs that unlock Chapter 2 and Chapter 3. In Discord, turn on Developer Mode (User Settings → Advanced), then right-click a role in Server Settings → Roles → **Copy Role ID**.
- `CURRICULUM`: chapters and lessons. Chapter 1 is open to every member. A lesson can be a plain title, or `{ title, video, summary }` to show a video and a short description in the player.
- `HOMEWORK`: assignments shown on the Homework tab (`title`, `chapter`, `due`, `details`). There's a commented example to copy.
- `BREAKDOWNS`: posts shown on the Breakdowns tab (`id`, `title`, `date`, `summary`, optional `video` and `link`).

### Completion rules

- **Lessons complete only after the full video is watched.** Only continuous playback counts, skipping ahead past the furthest point watched is blocked on the first watch, and the lesson ticks itself off when the video ends. Members can't tick lessons by hand.
- Breakdowns with a video follow the same rule. Link-only breakdowns and homework are ticked by hand.
- Every completion records the day it happened. The Profile tab lists each completed lesson, breakdown and homework with its date, newest first.
- Progress is kept per Discord user. Until the backend is connected it's stored in that member's browser. In demo mode, lessons without a video play the site's sample clip so you can try the flow.

## Discord sign-in

Sign-in runs on small Vercel functions in the `api` folder. No bot is needed.

| Route | What it does |
|---|---|
| `/api/login` | Sends the member to Discord to approve sign-in |
| `/api/callback` | Discord sends them back here. Checks they're in your server, reads their profile and roles, starts a 7-day session |
| `/api/session` | Tells the page who's signed in, their roles and saved progress. Re-checks roles with Discord every 5 minutes |
| `/api/progress` | Saves lesson, breakdown and homework completions with the date (needs the optional database) |
| `/api/logout` | Signs out |

### Setup

1. **Create the Discord app.** Go to https://discord.com/developers/applications → **New Application** → name it "The Project". Open **OAuth2**:
   - Copy the **Client ID**, then **Reset Secret** and copy the **Client Secret**.
   - Under **Redirects**, add `https://05project.com/api/callback` and save. (Add your `*.vercel.app` address too if you test there.)
2. **Copy IDs from Discord.** Turn on User Settings → Advanced → **Developer Mode**. Right-click your server icon → **Copy Server ID**. In Server Settings → Roles, right-click the Illuminated and Enlightened roles → **Copy Role ID**, and paste them into `ROLES` in `index.html`.
3. **Add environment variables in Vercel** (Project → Settings → Environment Variables), then redeploy:

   | Name | Value |
   |---|---|
   | `DISCORD_CLIENT_ID` | from step 1 |
   | `DISCORD_CLIENT_SECRET` | from step 1 (keep it secret) |
   | `DISCORD_GUILD_ID` | your Server ID |
   | `SESSION_SECRET` | a long random string, e.g. from https://generate-secret.vercel.app/64 |
   | `MEMBER_ROLE_ID` | optional: only members with this role can sign in at all |
   | `DISCORD_REDIRECT_URI` | optional: set it if sign-in says the redirect is invalid, to exactly the URL from step 1 |
   | `DISCORD_BACKUP_WEBHOOK` + `CRON_SECRET` | optional: nightly backup to a private Discord channel (see Backups) |
   | `DISCORD_TESTIMONIAL_WEBHOOK` / `DISCORD_PAYOUT_WEBHOOK` | optional: Wins feeds (see Wins) |
   | `DISCORD_STAFF_WEBHOOK` | optional: security alerts to a staff channel (see Security alerts) |

4. **Optional, for progress across devices:** in Vercel → **Storage** (or Marketplace) → add **Upstash Redis** and connect it to this project. It adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically. Without it, sign-in and roles still work, and progress stays in each member's browser.

### What members see

- "Continue with Discord" → Discord's approval screen (first time only) → back to the site, the stamp plays, and the portal opens with their name, avatar, banner, join date and Discord ID.
- Chapters unlock from their Discord roles. Give or remove a role in Discord and the site follows within about 5 minutes.
- Not in your server, missing the base role, or cancelled: they land back on the sign-in page with a short message saying why.

The watch-to-complete check runs in the browser, so treat it as a strong nudge rather than proof. For airtight tracking, confirm watch time from your video host before saving a completion. Completion dates are stamped with the server's clock, so they can't be backdated.

## Admin panel

An **Admin** tab appears in the portal for the admin Discord accounts only (IDs `1313595031466021026`, `484654761757507584` and `1195730656043487295`). To add more admins, set `ADMIN_DISCORD_IDS` in Vercel to a comma-separated list of Discord user IDs. Everyone else never sees the tab, and the server refuses admin requests from them.

| Section | What you can do |
|---|---|
| Announcements | Post a banner at the top of every member's portal, with an optional end date. Members can dismiss it. |
| Homework | Assign homework with a chapter, due date and details. Members mark it done and the date is logged. |
| Lectures | Rename or add chapters (with the Discord role that unlocks each), add, reorder or delete lessons, and attach a video and notes to each lesson. |
| Breakdowns | Post breakdowns with a video (upload or link), summary and an optional extra link. |
| Members | Everyone who has signed in, when they were last seen, completion %, homework done and which chapters they can open. Select a member to see every completion with its date. |

Once you save from the Admin tab, what's stored there replaces the lists in the CONFIG block of `index.html`.

**Needs:**
- **Upstash Redis** (see setup step 4) for anything to save.
- **Vercel Blob** for video uploads: in Vercel → **Storage** → **Create** → **Blob**, connect it to this project, then redeploy. It adds `BLOB_READ_WRITE_TOKEN`. Without it you can still paste video links from any host.

Lesson videos for chapters a member's roles don't unlock are never sent to their browser. Uploaded videos live at long random addresses, so they're hard to guess, but anyone who has a link can play it. For stronger protection later, move videos to a host with signed, expiring links (Mux, Cloudflare Stream, Bunny Stream).

## Chrome only and lockdown

- Any browser other than Google Chrome (Safari, Edge, Brave, Firefox, Opera and so on) gets a "Wrong browser" screen with a Get Google Chrome button and a Copy link button. Chrome on iPhone and iPad is allowed. `/api/login` also turns non-Chrome browsers away.
- Right-click, dragging, text selection, copy, printing, Save Page, View Source and the developer-tools shortcuts (F12, Ctrl/Cmd+Shift+I/J/C, Cmd+Option+I/J/C/U) are blocked.
- If developer tools are opened docked to the window, the page covers itself and pauses video until they're closed.
- Lesson videos have download, picture-in-picture, casting and playback-speed controls turned off.

These stop casual copying, but nothing running in a browser can stop someone determined (screen recording, a browser that lies about itself, devtools opened in a separate window). The real protection for lesson videos is on the server: host them on a service with signed, expiring links (Mux, Cloudflare Stream, Bunny Stream or private Vimeo) and have the backend hand out a link only to members whose role allows that chapter.

## Asset rights

The diamond video comes from a third-party wallpaper site. Confirm you have the right to use them commercially, or swap in your own, before the site goes public.

## Who can sign in, and what they see

| Discord role | Sign in? | What they see |
|---|---|---|
| Grounded `1546326599119671407` (free) | no: "Grounded is free Discord access" | — |
| Awakened `1546326866875646084` | yes | Awakened only, one lesson (or lesson part) at a time |
| Illuminated `1554996401979654165` | yes | Awakened (all open) + Illuminated one at a time |
| Enlightened `1546326926099222538` | yes | everything below open + Enlightened one at a time |

Chapters a member hasn't reached aren't sent to their browser at all. In the chapter they're on, the next item
opens once the current one's **notes and homework** are handed in (homework is uploaded as images or PDFs from their
computer). If a lesson has a video, it has to be watched to the end first. Locked items are blurred and their titles,
videos and homework never leave the server.

**Moving up on the site**
- Finishing the last Awakened lesson opens Illuminated automatically.
- Finishing the last Illuminated lesson shows a **Promotion** card on the member's Profile. They pick a payout
  certificate they uploaded and request promotion. It shows at the top of **Admin → Hand-ins**; Promote opens Enlightened.
  (Chapters marked "Opens only by promotion" in Admin → Lectures work this way.)
- The site doesn't change Discord roles. After promoting someone, give them the role in Discord too if you want it there.

**Lessons with parts**: Liquidity (2), Manipulation (3), Ranges (2),
Order Blocks (4), Start of Many (Start of Many + Breakeven Protocol), Conclusion (Mark Ups + Conclusion).
Sessions is one video with an "Indicator Announcement" banner above it; any lesson can have a banner (Admin → Lectures → Banner title, message, link). Each part has
its own video and homework and unlocks on its own. Edit parts in Admin → Lectures ("Split into parts", "+ Add part").

**Certificates**: every member can upload payout and funded certificates on their Profile (only they and admins see them).
Uploads go to the Vercel Blob store, so it must be connected to the project (Storage → Blob → connect).

## Breakdowns: one at a time, every week

Post them from **Admin → Breakdowns**, choosing the type, the week and (for dailies) the day:

- **Daily breakdown**: Monday to Friday
- **Weekly Breakdown**: the recap of the week
- **Weekly Outlook**: the plan for the week, opens it before Monday (pick the week it plans)
- **Advanced Breakdown**: a separate chain, only for the Enlightened role

Members work through each week in this order: Weekly Outlook (the plan for that week) → Monday → … → Friday → Weekly Breakdown (the recap) → next week's Outlook.
Each one opens once the previous one's **notes and mark-ups** are handed in (or approved, if Hand-ins is set to "After I approve").
Anyone who can sign in gets the main chain; Advanced needs the Enlightened level (role or promotion) and isn't shown before that. Locked breakdowns show only their day and are blurred:
titles, videos and notes never leave the server.

## For admins: catching members up

**Admin → Progress** is the one place for this:
1. Tick members (**Select all**, or search).
2. Tick lectures, lesson parts, breakdowns or homework (**Select all** per chapter, **Select everything**, or shift-click a range).
3. Pick an action at the bottom: **Unlock + mark done** (the usual one), Mark done, Unlock, Lock, Undo done or Reset.

With one member ticked, every item shows where they are (Done, Open, Locked, Handed in…). In **Members → Details**,
"Unlock or mark done for …" jumps to Progress with that member already ticked.

All three admin accounts (`1313595031466021026`, `484654761757507584`, `1195730656043487295`) have all of this, see every lesson and breakdown, and aren't covered by the focus shield.

## Recording deterrents (and their limits)

A website can't detect screen-recording software, so the portal makes recordings traceable and awkward instead:
- a faint, drifting watermark with the member's @username, Discord ID and the date across the whole portal and the moving name tag on the video;
- videos keep playing when you switch to another tab or window (so members can take notes elsewhere); watch progress still only counts real playback, so skipping ahead in a background tab doesn't work;
- PrintScreen, Win+Shift+S and Cmd+Shift+3/4/5/6 blank the page, try to clear the clipboard, and are logged against the member (Members → Flags).

A recorder running in the background (like OBS) can still capture the screen, which is why the watermark matters. Only
DRM video (Widevine, via a host such as Mux or Bunny Stream) makes the video itself record as black.

## Videos: upload or YouTube

A lesson, part or breakdown video can be an uploaded MP4 (Admin → Upload) or a YouTube link (watch, youtu.be, shorts or live).
YouTube videos follow the same rules: no skipping ahead on the first watch, and the lesson completes when it ends.
Set YouTube videos to **Unlisted** with **Allow embedding** on. Note that anyone who gets an unlisted link can watch it on
YouTube outside the site, so uploaded MP4s (signed links that expire) are the more locked-down option.

## Journal and the psych leaderboard

**Journal tab**: each member first creates their journal by writing their rules. The rules sit next to the entry form.
Every trade entry needs: pair, account type, session, trade date & time, contracts, outcome (TP / SL / BE), trade P&L,
trade overview, entry model (BOS, MITIGATION, Chained OBs or DIV + OB), 1–12 screenshots, and "Did you follow your rules?". It won't post without all of them.
A "No trades today" entry needs the date, session, a short overview and the rules answer (one per day).
Members can delete their own entries for 7 days. Admins can **Void** an entry (0 points) in Members → Details.

**Leaderboard tab (psych leaderboard)**, by this week / this month / all time:

| Entry | Points |
|---|---|
| Rules followed + TP | 3 |
| Rules followed + SL or BE | 1 |
| Rules followed + no trades that day | 1 |
| Rules not followed (or voided) | 0 |

## Homework

Assign it in Admin → Homework. Tick the lectures it goes with: members see it once one of those lectures is open for
them (tick none to show everyone). Members open an assignment, hand in notes + files, and see your feedback. The Homework
tab shows a count of open assignments, and a small reminder pops up in the corner once per visit.
"Review hand-ins" on an assignment opens Admin → Hand-ins filtered to it.

## Admin: hand-ins and bulk changes

**Hand-ins**: members on the left (with how many are waiting), their hand-ins on the right. Filter by Waiting / Reviewed /
All and by Lessons / Breakdowns / Homework, or search a member. **Clear all hand-ins** deletes every member hand-in
(items you marked done are kept). All hand-ins were cleared once automatically after this update.

**Progress**: see "catching members up" above.


## Advanced tab
Members who reach the top level (Enlightened) get an **Advanced** tab next to Breakdowns. Add lectures to it in
**Admin → Advanced** (section, title, video, summary, homework). They unlock one at a time, like breakdowns, and are
grouped by section. Nobody below the top level sees the tab or its lectures.

## Homework notifications
New homework and work that's sent back or approved show as notifications at the top of the Homework tab and as a popup
in the bottom-left corner (once per visit, until it’s handed in). The Homework tab shows a red count of homework not handed in yet. "Watch the lectures for this" opens the videos an assignment is linked to.

## Journal reviews and calendar
New journal entries are **pending** until an admin approves them in **Admin → Journal**. Only approved entries score on
the psych leaderboard. Denying needs a short note, which the member sees. Entries posted before this update count as
approved. The member's journal opens on a month calendar: green days made money, red days lost it, and clicking a day
shows its entries.

## Admins: preview as a member
The **View as** menu in the top bar (admins only) shows the site the way a member on one step sees it: Awakened,
Illuminated or Enlightened, with the same locks and blur, as a brand-new member with nothing done. The Admin tab stays. Hand-ins are off in the
preview, and your own progress is left alone. Pick **Admin view** (or "Back to admin view") to see everything again. The choice is
remembered in that browser.

## Letter rain
Behind the portal, the letters of THE PROJECT fall faintly in columns, like the Matrix, from the moment the portal opens. Under them: two slow teal glows drifting, a faint chart grid, a soft scan line every ~14 seconds and fine film grain. It pauses when the tab is in the background and is off for anyone who has "reduce motion" turned on.

## Admins: going through journals by day
**Admin → Journal → By day** lists the days journal entries were uploaded (or switch to **Trade date**), with how many
are waiting. Pick a day to see everyone's entries from it, then **Walk through on a call**: one entry at a time with big
screenshots, the trade details and the member's rules next to it. Keys: ← → move, **A** approves, **D** denies (type a
short note first), **Esc** closes. Dots along the bottom show what you've approved (green) and denied (red).

## Payout leaderboard
Members add payouts on their **Profile** (payout certificate + amount + the day it was paid). An admin checks them in
**Admin → Payouts**, confirms or corrects the amount, and **Certifies** it (or denies it with a note). The Leaderboard has
two boards: **Psych** (journal points) and **Payouts** (certified payouts added up per member, this week / month / all
time). Certified payouts can't be deleted by the member.

## Admin notifications
Admins get a bell in the top bar. It checks every 90 seconds (and whenever you come back to the tab) for new hand-ins,
journal entries, payout or funded certificates and promotion requests. New ones pop up in the top-right corner and the
bell shows how many you haven't seen; click one to jump straight to it. The panel also shows how much is waiting, and the
Hand-ins, Journal and Payouts buttons in Admin carry red counts.


## Journal points (admin picks the points)
When you approve a journal entry you choose how many points it's worth (0–3 buttons, or keys 0–3 in the by-day
walkthrough). The site suggests a number:

| Entry | Points |
|---|---|
| Live/funded, rules followed, TP | 3 |
| Live/funded, rules followed, SL or BE | 1 |
| Paper/demo, rules followed, TP | 1 |
| Paper/demo, rules followed, SL or BE | 0 |
| No-trade day, rules followed | 1 |
| Rules not followed | 0 |

The suggested numbers live in `basePoints()` in `api/_gate.js` (and `entryWorth()` in `index.html`). Entries approved
before this update keep exactly the points they already had, so nobody's leaderboard total changes.

## Journal stats
Journal → **Stats** (members see their own; admins see everyone or one student, under Admin → Journal → Stats). Filter by
this week / month / last 30 days / all time. Shows trade days vs no-trade days, how often students sit out, win rate,
P&L, rules followed, the times trades are taken (30-minute buckets), a weekday table, whether there was high-impact news
on no-trade days (and which news), and breakdowns by session, entry model and account. Admins also get a per-student table.

## No-trade days and news
No-trade entries can carry up to 12 screenshots (optional) for mark-ups and price action, and every entry asks whether
there was high-impact news that day (and which: CPI, FOMC, NFP…). Older entries without this simply show as "not said".

## Breakdowns and playback speed
Breakdown homework can be handed in without watching the video (people watch them live), and breakdown videos can be
skipped through freely. Lectures still need watching first. Every video has a speed button that cycles 1× → 1.5× → 2×
(2× is the maximum), and a **CC** button for YouTube's captions (auto-captions work). Both are remembered per browser.

## Performance
The background is lighter: the letter rain runs at a lower frame rate with fewer columns and pauses while a video plays
or you scroll, the moving background layers are static, and the top bars no longer blur what's behind them.

## Stats tab
A **Stats** tab in the top bar puts every student's journal together: trade days vs no-trade days, when trades get taken,
weekdays, news on no-trade days, sessions, entry models and accounts. Pick a period (this week / month / last 30 days / all
time).
- **Members** switch between **Everyone** (all journals combined, with no names, notes or screenshots) and **Me**.
- **Admins** get a dropdown: everyone combined, yourself, or any one student, plus a "By student" table (click a name to
  open just that student).
Denied entries are left out. The combined numbers are cached for up to 2 minutes and refresh as soon as someone posts or an
admin reviews an entry. Days are calendar days: twelve people trading on Friday is one trading day with twelve trades. A no-trade log counts as
sitting out only if that student didn't also log a trade that day.

## Trade data (optional fields on every trade)
The journal's trade form has a **Trade data** section. Everything in it is optional, so students can still post quickly and
older entries are untouched:
direction, entry type, which time zone their times are in (converted to New York time for the stats), exit time, entry /
stop / target / exit prices, risk in $, how far price went against them and in their favour (MAE / MFE, in points), bias
timeframe and HTF bias, entry timeframe, setup grade, how they felt before entering, liquidity swept, confluence, how they
managed the trade, and mistakes.
The site works out the planned R, the R multiple, the hold time, whether the trade was with or against the HTF bias, and
which trade of the day it was. The choice lists are at the top of the "trade data" block in `index.html` (`TD`) and in
`api/member.js` (`HTFS`, `SWEPT`, `CONFL`…); keep the two in step when you add an option.

## What works best (Stats tab)
Ranks every condition (model, session, half-hour of the day in NY time, weekday, direction, bias alignment, timeframes,
liquidity swept, confluence, grade, emotion, management, mistakes, planned R, hold time, 1st/2nd/3rd trade of the day,
instrument, account, news, rules) and common pairings (model + session, model + time…) by:
- **Win rate:** TP ÷ trades.
- **Reliable WR:** the low end of the 95% range for the true win rate (Wilson). It stops a 3-for-3 condition from outranking
  45-for-70, so it's the default ranking.
- **Avg R, profit factor and P&L.**
You can set the minimum number of trades a condition needs before it's ranked (3 / 5 / 10 / 20). Denied entries are left out.

## Excel export
Stats tab → **Export to Excel** downloads a real .xlsx built in the browser: Trades (every field, one row per trade),
No-trade days, What works (every condition), Combinations, and By student when there's more than one student. Admins export
whatever they're looking at (everyone or one student, for the chosen period) with names. Members can only export their own
journal. Screenshot links aren't included because they expire; the sheet shows how many screenshots each entry has.

## Days, W / L / no-trade
- **Days journaled / Trading days:** calendar days, across everyone in the combined view.
- **No-trade logs:** each time a student logged that they sat a day out ("No-trade days" when looking at one student).
- **W / L / No-trade:** wins, losses, break-evens and sit-outs, overall (with a bar and percentages) and for every day in
  the **By day** table (latest 10 days, "Show all" for the rest). The weekday table has the same split.
- The Excel export has a **By day** sheet with the same columns plus a total row.
- Periods: this week, this month, 30 days, 90 days, this year, all time. Everything is computed from the stored entries
  each time, so nothing is lost or rolled up, and the numbers stay right as months of data build up.
- New entries default to the last trading day: before 5am counts as the day before, and weekends go back to Friday.
  Dating a trade on a Saturday asks for confirmation first.

## Which trades the stats count
Stats (the Stats tab, Journal → Stats, and the analysis sheets in the Excel export) only count **Funded** and
**Evaluation** trades. Paper, demo and personal / live trades stay in the journal and on the leaderboard but are left out
of every stat. No-trade days always count. The export's Trades sheet still lists every trade, with a "Counted in stats"
column. To change which accounts count, edit `STAT_ACCOUNTS` in `index.html` and the matching line in
`communityStats()` in `api/member.js`.

## Screenshot viewer
Clicking any screenshot (journal entries, homework hand-ins, payout certificates, the admin walkthrough) opens it in a
viewer over the page instead of a new tab. With several files you can move between them with the arrows, ← →, the
scroll wheel or trackpad, swiping on a phone, or the thumbnails along the bottom. Click the image to zoom to full size
(click again or press Esc to zoom out), and press Esc or click outside it to close. "Open original" still opens the file
in a new tab, and Ctrl/Cmd-click does too. PDFs show an "Open PDF" button in the viewer. The code is `lightbox()` in
`index.html`.

## Who sees what in Stats
- **Students, Stats tab:** only the combined summary for everyone: days, trades, no-trade logs, W / L / no-trade with the
  bar, win rate, P&L, rules followed, avg R, profit factor, avg win and avg loss, with a period filter. No student picker,
  no "Me", no Excel. The server only sends them the fields that summary needs, anonymised.
- **Students, Journal → Stats:** their own full stats (by day, times, weekdays, news, sessions, models, accounts, What
  works best), like a personal TradeZella dashboard. Nobody can see another student's stats.
- **Admins, Stats tab:** everything: everyone combined, any single student, yourself, the By student table, all the
  breakdowns, and Export to Excel. When you preview the site "As Awakened" etc., you see the student version.

## Phones and tablets
Tested at phone (390px) and iPad (820px) widths, signed in as a member and as an admin. Nothing scrolls sideways.
- **Videos:** phones only start a YouTube video when the tap lands on YouTube's own player. If the play button doesn't
  start it, the next tap goes straight to the video ("Tap the video once more to start it"), and the site's controls
  take over once it plays. While a video plays, one tap shows the controls and the next pauses. Full screen fills the
  screen on iPhone, which can't do real full screen for a page. The player also stays usable when the phone is sideways.
- **Protections that misfired on touch:**
  - A long-press no longer counts as a right-click (no alarm, warning or flag).
  - The developer-tools size check is skipped on phones and tablets (the keyboard and pinch-zoom tripped it).
  - Opening the photo picker to add screenshots doesn't trigger the "Paused" cover.
  - The two overlays that both had `id="shield"` are now `#shield` (developer tools) and `#pshield` (focus cover).
- **Layout:**
  - The tab bar scrolls sideways with faded edges, and the current tab is kept in view.
  - The homework pop-up is a slim bar at the bottom.
  - Text boxes use 16px text so iPhones don't zoom in when you tap them.
  - Lectures and Breakdowns have an "All lessons" / "All breakdowns" button to jump to the list.
  - Journal → Stats no longer runs off the side.
  - Bigger touch targets on the video controls.
- The phone and tablet rules are in the `phones & tablets` block at the end of the main stylesheet in `index.html`.

## Approving a hand-in unlocks the next one automatically
Admin → Hand-ins → "When does the next lesson unlock?" → **After I approve**. Approving a hand-in unlocks the next lesson
or breakdown on the server straight away, with nothing to unlock by hand. A student who has the site open sees it within
about 45 seconds (or as soon as they come back to the tab), with a message like "✓ Approved: Lesson name. The next one is
unlocked." Sending a hand-in back shows them a message too. The page waits to update if they're watching a video, typing,
or uploading, so nothing they're doing is interrupted. The code is `pollUnlocks()` in `index.html`.

## Feedback for members
- **Bell (members):** members now have a bell in the top bar. It lists every approval and send-back on lectures,
  breakdowns, advanced lectures and homework (with the mentor's feedback), journal entries an admin commented on or didn't
  count, and payout certificates certified or not. Clicking an item opens that lesson, homework or journal day. The red
  number counts unread items. Reviews from before this update start as read. Admins keep their own Activity bell.
- **Profile → Feedback from your mentor:** everything above in one list, newest first, with filters (All, With comments,
  Lectures, Breakdowns, Homework, Journal).
- **Journal approvals can carry a comment:** the note box when reviewing a journal entry is now "Comment for the member
  (optional; needed to deny)". On approved entries the member sees it as "Mentor: …".
- Updates arrive on their own: hand-in reviews within about 45 seconds, journal and certificate reviews within about 2
  minutes, or straight away when the member opens the bell. The code is `fbItems()` / `paintFb()` in `index.html`.

## Sign-in on phones, and 12 attachments
- The sign-in `state` sent to Discord is now signed and valid for 15 minutes, so `/api/callback` accepts it even when the
  phone dropped the state cookie (iPhone browsers can lose cookies set on a redirect, and a double tap on Sign in
  replaced it). Both cases used to show "expired". A state this site didn't sign is still refused.
- Sign-in errors show inside the sign-in card instead of a floating message.
- On phones and tablets the Japanese wordmark sits on its own line above PROJECT instead of overlapping it.
- Hand-ins (lecture homework, homework assignments, breakdown mark-ups) take up to **20** files each (`MAX_HANDIN_FILES`); journal entries (trade and no-trade) take up to **12** screenshots
  (`MAX_FILES` in `index.html` and `api/member.js`). If a student picks more, they're told how many weren't added.

## Backups
Admin → **Backups**.
- **Download backup now:** one JSON file with everything in the database (members, progress, hand-ins, journals, points,
  payouts, certificates, feedback, content, settings, snippets). Screenshots and videos stay in Blob storage; the backup
  keeps their links.
- **Daily automatic backup:** Vercel Cron (`vercel.json`) calls `/api/admin/members?cron=backup` every night at 08:00 UTC
  (2–3am Chicago time). A gzip of the same file is posted to a private Discord channel, outside Vercel and Upstash, so it
  survives a problem with either. To set it up:
  1. In Discord, make a private channel only admins can see.
  2. Channel settings → Integrations → Webhooks → New Webhook → copy the URL.
  3. In Vercel, add `DISCORD_BACKUP_WEBHOOK` (the webhook URL) and `CRON_SECRET` (any long random text).
  4. Redeploy, then press "Send a backup to Discord now" to test it.

  The Backups screen shows when the last one ran, and any error.
- **Restore:** pick a `.json` (from the download button) or `.json.gz` (from Discord) and type RESTORE. A backup of the site
  as it is now downloads first, so a restore can be undone.
  - **"Only add what's missing"** puts back deleted records and deleted entries inside them, e.g. one journal entry or
    one hand-in, without changing anything that exists.
  - **"Replace with the backup's version"** overwrites the records in the file.

  Keys that aren't in the file are never touched.

## Streaks, weekly recap, quiet students
- **Journaling streak:** weekdays in a row with at least one entry that wasn't denied (trade or no-trade), using New York
  dates. Today isn't missed until it's over, and weekends neither count nor break it. It shows at the top of the
  member's Journal and as 🔥 N on the leaderboard (2+ days). The logic is `streakOf()` in `api/_gate.js` and `index.html`.
- **Week in review:** a Journal sidebar card (This week / Last week) with W / L / no-trade, win rate, P&L (Funded and
  Evaluation only), rules followed, best setup, most common mistake, and one thing to focus on. Every Monday the bell
  gets "Your week in review".
- **Quiet students (admins):** Admin → Members starts with students who haven't journaled, handed in or finished a
  lecture in 3, 5, 7 or 14+ days, with what they last did. "Copy message" copies a friendly check-in DM. The admin bell
  and the Members tab show how many have been quiet for 5+ days.

## Saved feedback snippets & student report (admins)
- **Snippets:** every review box (hand-ins, journal entries, the walkthrough) has one-tap feedback lines underneath.
  Tapping one adds it to the comment. "Edit snippets" changes the list for every admin (stored in the `snippets` key).
- **Report:** Admin → Members → Report (also on the quiet list). One screen for a 1:1 call:
  - streak and last work
  - trading summary (this week / 30 / 90 days / all time)
  - this week and last week
  - course progress and hand-ins waiting
  - the last 10 journal entries, with screenshots
  - every piece of written feedback you've given them

## Wins: testimonials + payouts (with Discord feeds)
- **Wins tab:**
  - **Testimonials:** students submit a star rating, a review and an optional result line. After an admin approves it,
    it shows here with the average rating.
  - **Payouts:** a feed of certified payouts that students chose to share.
- **Admin → Testimonials:** approve, deny (with a reason the student sees) or take down. Admins can't edit what a
  student wrote. The bell and the tab show how many are waiting.
- **Discord feeds:** two Vercel settings, each the URL of a channel webhook (Channel → Edit → Integrations → Webhooks →
  New Webhook → Copy URL):
  - `DISCORD_TESTIMONIAL_WEBHOOK`: approved reviews are posted with stars, text, name and picture.
  - `DISCORD_PAYOUT_WEBHOOK`: certifying a payout posts "💸 Certified payout: $X" with the student's note and payout date.
    The certificate image is attached only if the student ticked "Include my certificate image".

  Each item posts once, @mentions are switched off, and the Testimonials screen shows whether each channel is
  connected.
- **Student consent:** when uploading a payout certificate, students choose whether to share it and whether the
  certificate picture goes to Discord (both ticked by default). Unshared payouts never leave the site's admin screens.
- **Certificate picture in Discord:** when certifying, admins see "Include their certificate picture" and can untick it
  (e.g. an account number is showing). They can't include a picture a student chose not to share. Certificates uploaded
  before students were asked can be included by ticking it. Images show inside the post; PDFs are attached as a file.
  Files over about 9.5 MB are skipped, and the amount still posts.
- **Tagging:** Admin → Testimonials → Discord feeds → "Who gets tagged" lets you pick, for reviews and payouts
  separately: Nobody, @here, @everyone, or a role (paste the role ID). The post's first line then pings them, e.g.
  "@everyone 💸 Ava just got paid $2,400". It's saved in the `feed-settings` key and applies to new posts.

## Security hardening
- **Headers (`vercel.json`), on every response:**
  - `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`: the site can't be loaded inside
    another site's frame, which stops clickjacking.
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`: still lets YouTube embeds play.
  - `Permissions-Policy` turns off camera, microphone, location, payment and USB.
  - `Access-Control-Allow-Origin` is pinned to `https://05project.com`, replacing Vercel's default `*` on static files.
    The API never sent it.
- **Rate limits** (Redis counters, `rateLimit()` in `api/_lib.js`):
  - sign-in starts: 20 per 10 minutes per IP address (then "Too many sign-in attempts")
  - upload requests: 60 per 10 minutes per member
  - member actions: 300 per 10 minutes per member

  Blocked-action flags are never limited, so they're always recorded.
- **Certificate delete:** an ID that isn't one of your own certificates returns 404. Members could only ever delete from
  their own record.
- **"Send a backup now"** is a POST.
- **Developer tools already open when the page loads:** for members on a computer, no lesson data (including video
  links) is requested at all. The block screen shows, and the page reloads once developer tools are closed. Admins
  aren't affected.
- **Already in place:**
  - the session cookie is `HttpOnly; Secure; SameSite=Lax`
  - uploads are checked on the server: PNG, JPG, WebP, GIF, HEIC and PDF only (no SVG or HTML), max 25 MB, only into
    the member's own folder
  - files are in a private Blob store, reachable only through signed links that expire after 6 hours

## Breakdowns: newest on top
The Breakdowns list shows the newest week first, and the newest breakdown first inside each week. Numbers and the
unlock order don't change: members still work through them in the order they were posted.

## Journal: edit, tags, day notes, entries list
- **Edit any entry later** (Edit button on the entry). Changing the date, result, account, rules answer or kind on an
  entry an admin already reviewed sends it back to "waiting" for review; fixing notes, screenshots or trade data
  doesn't. Edited entries show an "Edited" tag for admins.
- **Only the essentials are required:** trades need date, result (TP/SL/BE), account type and "followed my rules";
  no-trade days need date and the rules answer. Everything else (time, instrument, P&L, notes, screenshots, trade data)
  is optional. A trade with no P&L shows "—" and counts as $0.
- **Tags** (up to 8 per entry, e.g. `A+`, `london`, `revenge`) with suggestions from tags already used.
- **Day notes:** click any day on the calendar (including today, before any trade) to write a **Plan** before the
  session, a **Recap** after, and a mood. Days with notes get a small dot.
- **Entries view:** every entry in one searchable list, filterable by result, account, model and tag, with a running
  total (trades, TP %, net P&L).

## Journal: import trades from a CSV
Journal → **Import CSV**. Export the trade history from the trading platform, pick the file, check the preview, pick the
account type, and import. Each trade becomes an entry (marked "Imported") that the member can add notes and screenshots
to later. Up to 200 trades per file.
- **Tradovate** (Performance → export): read automatically, including long/short from the buy and sell times.
- **TopstepX / ProjectX, NinjaTrader, Rithmic, TradingView and most others:** columns are guessed from their names;
  anything guessed wrong can be fixed with the dropdowns. Times with a time zone are converted to the member's time.
- Negative P&L in any common form works (`-20`, `$(20.00)`, `-$20`). If the file has a fees column, fees can be taken
  off the P&L.
- Importing the same file twice skips the trades already there. Imported trades go to admins for review like any entry.
- Limit: 5,000 journal entries per member.

## Admin: daily recap (for the group calls)
Admin → Journal → **Daily recap** (the default view). Pick a trading day (it starts on today, or Friday at the weekend):
- the totals: how many students journaled, TP · SL · BE, no-trade days, net P&L, % of rules followed;
- one card per student with their plan, recap and mood for that day, then each entry (time, instrument, side, result,
  P&L, tags, notes). Click an entry, or **Walk through everyone**, to go through them full-screen on the call;
- **Haven't journaled this day:** everyone with a journal who has nothing for that day;
- **Copy summary:** a short text version to paste into Discord.

## Security alerts to the staff channel
Suspicious activity is posted to a private Discord channel and listed under Admin → **Backups & safety → Security
alerts** (last 200 kept even without Discord):
- dev tools opened on the site;
- 5 or more blocked actions within 10 minutes (right-click, save, view source, print, screenshot keys…);
- too many requests (300 actions in 10 minutes) or uploads (60 in 10 minutes);
- too many sign-in attempts from one IP address (20 in 10 minutes);
- a non-admin calling admin-only actions (e.g. trying to change their own role);
- a request that came from another website (blocked; see below).

Each alert names the member (with a Discord mention), their IP and what happened. One alert per person per kind every
30 minutes, so nobody can flood the channel. To turn it on: in Discord, a staff-only channel → Edit Channel →
Integrations → Webhooks → New Webhook → Copy Webhook URL; in Vercel add **`DISCORD_STAFF_WEBHOOK`** with that URL and
redeploy; then press **Send a test alert** in Admin → Backups & safety.

## More security (this round)
- **Cross-site requests are refused:** any POST/PUT/DELETE whose `Origin` is a different website gets 403 (and an
  alert). Requests without an `Origin` (Vercel's own callbacks) still work.
- **Size limits:** 5,000 journal entries and 3,000 day notes per member; CSV imports are written in one go.
- Edits only work on your own entries (anything else returns 404), and an edit can't change review status, points or
  who reviewed it.


## Paste screenshots instead of saving files
In the journal's screenshot box and the homework / breakdown hand-in box, members can paste instead of saving a file first:
- **TradingView "Copy chart image"** (Ctrl+Shift+S, or ⇧⌘S on a Mac), then Ctrl+V / ⌘V anywhere on the form.
- **TradingView "Copy link"** (Alt+S / ⌥S, a `tradingview.com/x/…` snapshot link): the site fetches that snapshot's
  image and adds it as a screenshot. If the link is pasted into a text box it stays there as text too.
- **Any copied screenshot** (Win+Shift+S, ⌘⇧4 with Control, Snipping Tool…).
- **Drag and drop** files onto the box.

Pasted images upload exactly like picked files (same private storage, same limits). The TradingView link lookup runs in
`api/upload.js` (`GET /api/upload?tv=<id>`), accepts only TradingView snapshot IDs and PNG images up to 10 MB, and is
limited to 40 per 10 minutes per member.

## Sunday counts as Monday
Futures open Sunday evening for Monday's session, so anything dated **Sunday** belongs to **Monday's** trading day:
journal entries, imported trades and day notes. A Sunday-dated entry is saved under Monday with a "Sunday open" tag (the
form says so when a Sunday is picked). Older Sunday entries and notes are shown under Monday when read, without changing
what's saved; a Sunday plan and a Monday plan show together. Daily recap, By day, the calendar, streaks, weekly recaps
and leaderboards all follow this. On Sunday evening the new-entry date and the admin Daily recap start on Monday.

## Arrow keys: jump 10 seconds
On any video, **→** jumps forward 10 seconds and **←** goes back 10 seconds (a "+10s" / "−10s" badge flashes on the
video). Breakdowns and lectures already completed can be jumped through freely. On a lecture's first watch, ← always works
and → only goes as far as already watched (no skipping ahead). Works in full screen too. The keys act on the video you
last clicked or the one playing, and are ignored while typing in a text box or when the image viewer or walkthrough is open.

## Share cards: results for TikTok / Instagram
**Students:** Stats → **📱 Share my P&L** (also in Journal → Stats). **Admins:** Stats → **📱 Share card**, then pick whose:
**Everyone (the Project)** (admin-only: the data behind it only loads for admins), **Me**, or any student. Each card is a
1080×1920 image for **Today**, **This week** or **This month**.
- **Everyone card:** two styles (admins pick; remembered per device):
  - **Profile** (default): The Project with the diamond as its picture, "Today's Group P&L" with a trend arrow, then win
    rate, record and average win : loss.
  - **Ledger:** the group total ("Across 4 traders · 79% win rate"), then every trader with trades, win % and P&L,
    best first. Each name is in that person's role colour.
  Same pool and numbers as Stats for that period (everyone with a journal).
- **Personal card:** two styles, picked on the card (remembered per device):
  - **Profile** (default): avatar, name in their role colour, @handle · role, then the P&L in its own panel with a trend
    arrow.
  - **Ledger:** brand + who + date, the total ("Across 2 trades"), then every trade (time, market, TP/SL, P&L) or, for a
    week or month, every day. The card sizes itself to the rows (up to 9, then "+N more").
  The number, arrow and glow are green when up and red when down. Everything sits in the middle of the image, clear of
  the bars Instagram and TikTok stories put at the top and bottom. The Discord picture is used when Discord allows it;
  otherwise the first letter of the name in their colour.
- Funded / Evaluation trades only, denied entries left out, Sunday counts as Monday.
- **Save image** shares the PNG straight to apps on a phone (Instagram, TikTok, Photos) or downloads it on a computer.
  Or tap the card to hide the buttons and take a normal screenshot; tap again to bring them back.

## Stats periods
Stats (and Journal → Stats) use one dropdown: **Today**, This week, This month, Last 30 / 60 / 90 days, Last year, All
time. Weeks start Monday, Sunday counts as Monday. The "By day" table under the totals lists P&L day by day.

## Pictures load cleanly
Just-pasted or just-picked pictures (journal screenshots, hand-ins, certificates) show straight away from the member's
own device, since the private storage only gives a viewing link once the entry is saved. A picture that still can't
be shown (e.g. an unsaved draft after a refresh) appears as a tidy picture tile, never a broken-image icon.
Screenshots, hand-in files and certificates show a soft shimmer while they load instead of an empty box or the
browser's broken-picture icon. In the screenshot viewer every picture starts loading as soon as it opens, and moving
to the next one keeps the current picture up (with a small spinner) until the next one is ready. Share cards are drawn
straight onto the page, so they appear instantly and switching style or period never flashes.

## Highlighted tabs and buttons
Every tab row and option group shows which one is selected the moment it's clicked: the main tabs, the Admin sections,
filters, views, periods and the share card's options (including places that don't redraw the whole page).

## Sign-in intro: Signature
After "Continue as …" (or straight back from Discord) the PROJECT wordmark is drawn on stroke by stroke like an ink
signature ("THE" fading in beside it), fills in, and a glowing teal line draws underneath. Then the member appears
below: their Discord picture inside a slowly turning ring in their role colour with a green check, "Welcome back,
Name" revealed left to right (name in role colour), and "VERIFIED MEMBER · ROLE". Then it dissolves into the portal
(about 3.5 seconds). If the account is still loading, the teal line gently pulses until it's ready. With reduced motion
on, it shows briefly without the animation. No Discord picture: the first letter of the name in their colour. On phones
the picture sits above the welcome line.

## Name colours and titles
Names on share cards and in the sign-in intro use Discord role colours. Staff are set by Discord user ID in
`STAFF_COLORS` / `STAFF_TITLES` in index.html (colour and title only; admin access is still `ADMIN_DISCORD_IDS`):
- `1313595031466021026`: Moderator, yellow `#F1C40F` (also an admin)
- `505505326532132868`: Moderator, yellow `#F1C40F` (not an admin)
- `484654761757507584`: Admin, red `#E74C3C`
Everyone else: Enlightened `#00C853`, Illuminated `#AA00FF`, Awakened `#3498DB` (highest level role wins), otherwise the
site's green.
