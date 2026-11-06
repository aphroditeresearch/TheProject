# Rebrand checklist

This repo is The Project member site (built from the 00 Cleared engine). Everything below is what makes it "The Project". Change these and you have a new brand on the same engine. Everything else (Discord sign-in, role locks, admin panel, uploads, progress tracking, Chrome-only lockdown, security alert, legal pages) works as is.

## 1. Brand identity (`index.html`)

| What | Where | Current value |
|---|---|---|
| Page title | `<title>` | The Project |
| Wordmark text | every `class="wm-t"` | PROJECT |
| Number mark | every `class="wm-n"` | stacked T / H / E |
| Japanese text | `.kana-v` and `wm-k` | プロジェクト |
| Tagline under the wordmark | `.word .tag` | discipline compounds. |
| Greeting | `.hi-sub` | Welcome to THE PROJECT. |
| Sign-in popup stamp | `#stamp` | THE PROJECT · MEMBER / VERIFIED / date |
| Popup countdown | `START` in the popup script | 0% counting up to 100% |
| Error and help messages | `ERRORS` in the boot script | mention "The Project server" |
| Meta description | `<meta name="description">` | The Project mentorship… |

## 2. Look (`index.html`, `terms.html`, `privacy.html`)

| What | Where |
|---|---|
| Colors | the `:root` block at the top of each file (`--bg`, `--ink`, `--blue`, `--extrude`, `--kana-c` …) |
| Fonts | the Google Fonts `<link>` and `--display`, `--sans`, `--mono` |
| Drifting leaves color | `drawPetal` in the script (`#137D86`, `#14A39D`) |
| Video tint | `hue-rotate(-44deg)` on `.moon video`; diamond size is `.moon` height; green glow is `.hero::after` |
| Security alert colors | `.blockwarn` / `.warn-box` (red) |

## 3. Media files

| File | Used for |
|---|---|
| `diamond.mp4`, `diamond.jpg` | the floating diamond beside the wordmark (and the demo lesson clip) |
| `blueprint.svg` | faint candlestick blueprint behind the sign-in scene (opacity on `.blueprint`) |
| `poster.jpg` | still frame while the video loads, profile banner fallback, player background |
| `favicon.svg` | browser tab icon (diamond) |

Replace them with files of the same name, or update the names in `index.html`.

## 4. Discord and access

| What | Where |
|---|---|
| Chapter role IDs | `ROLES` in `index.html` **and** `CHAPTER_ROLES` in `api/_lib.js` (keep them matching) |
| Admin account | `ADMIN_DISCORD_IDS` in Vercel; otherwise the default ID in `adminIds()` in `api/_lib.js` |
| Curriculum defaults | `CURRICULUM` in `index.html` (used until you save from the Admin tab) |
| Discord app, server ID, secrets | Vercel environment variables (see README) |

## 5. Storage keys (only if two brands share one browser or database)

| What | Where |
|---|---|
| Cookie names | `SESSION_COOKIE`, `STATE_COOKIE` in `api/_lib.js` (`theproject_session`, `theproject_oauth_state`) |
| Browser storage | every `localStorage` key starting `theproject.` in `index.html` |
| Database | give each brand its **own** Upstash database and Blob store, so nothing is shared |

## 6. Legal pages (`terms.html`, `privacy.html`)

Business name, operator (Josh Painter), location (San Antonio, Texas), governing law and courts (Texas, Bexar County), domain (www.advanced-amd.com), brand name, and the cookie names if you change them.

## 7. Package and docs

`package.json` name and description, and this repo's `README.md`.

## Setting up the new brand's services

Each brand needs its own: GitHub repo, Vercel project, domain, Discord application (new Client ID and Secret, with the new domain's `/api/callback` as a redirect), Discord server and roles, `SESSION_SECRET`, Upstash Redis database and Blob store. Follow the setup steps in `README.md` for each.
