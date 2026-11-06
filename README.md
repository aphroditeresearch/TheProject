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

An **Admin** tab appears in the portal for the admin Discord accounts only (IDs `1313595031466021026` and `484654761757507584`). To add more admins, set `ADMIN_DISCORD_IDS` in Vercel to a comma-separated list of Discord user IDs. Everyone else never sees the tab, and the server refuses admin requests from them.

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

Both admin accounts (`1313595031466021026`, `484654761757507584`) have all of this, see every lesson and breakdown, and aren't covered by the focus shield.

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
