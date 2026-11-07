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
- lessons cover over and videos pause whenever the window loses focus (most snipping and capture tools take focus);
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
trade overview, entry model (BOS, MITIGATION, Chained OBs or DIV + OB), 1–4 screenshots, and "Did you follow your rules?". It won't post without all of them.
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
No-trade entries can carry up to 4 screenshots (optional) for mark-ups and price action, and every entry asks whether
there was high-impact news that day (and which: CPI, FOMC, NFP…). Older entries without this simply show as "not said".

## Breakdowns and playback speed
Breakdown homework can be handed in without watching the video (people watch them live), and breakdown videos can be
skipped through freely. Lectures still need watching first. Every video has a speed button: 1× or 1.5×, nothing else.

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
