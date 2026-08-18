# Handover — TUMANIC M·A·E

Paste everything below the line into a fresh session opened in the project
folder. It replaces the original brief, which described a two-panel layout that
no longer exists; that version is still in git history if you want it.

---

Take over an in-progress website build. Read this whole brief before touching
files. Check claims against the repo before acting on them — this was accurate
when written, not necessarily now.

## The project

A site for **TUMANIC** — a UK electronic producer (deep house, drum & bass,
dubstep, hip-hop; weekly releases) who also paints. It plays his music and sells
his artwork. Brand: **TUMANIC M·A·E** — Music · Art · Events.

Working folder: `C:\Users\joset\OneDrive\Desktop\newprojects\altopurse.github.io`

## Where it stands

**The front end is live** at <https://altopurse.github.io> from the repo
`altopurse/altopurse.github.io` (a GitHub Pages user site, served from the repo
root on `main`). Every page and asset was verified returning 200 with correct
MIME types.

**The API is not deployed.** Render builds it but the deploy fails. See
*Deploying the API* below — the fix is a dashboard setting, not a code change.

Because `apiBase` in `assets/js/config.js` is still empty, the site is in
offline mode by design: artwork, player and discography render from local JSON,
and buy buttons say checkout is offline. That is the intended fallback, not a bug.

## Stack — decided, do not change without asking

- **Front end**: static HTML/CSS/JS, no build step, GitHub Pages from repo root.
- **API**: Node/Express in `server/`, on Render with root directory `server`.
- **Database**: Firestore (artworks, merch, orders, analytics).
- **Payments**: Mollie hosted checkout.
- **Comments**: Giscus (not configured). **List**: Buttondown (not configured).

## Repo map

| Path | What it is |
|---|---|
| `index.html` | Whole site — gateway, Music, Art, Events, About, checkout dialog |
| `assets/css/styles.css` | Everything visual. Colours sampled from the painting |
| `assets/js/config.js` | Public settings — API URL, platform links. **Never a secret** |
| `assets/js/app.js` | Data loading, room tabs, player swapping, checkout, list |
| `assets/js/analytics.js` | Cookieless beacon |
| `admin/index.html` | Dashboard — stats, orders, erasure, Spotify sync |
| `privacy.html`, `robots.txt`, `thanks.html` | Privacy notice, crawl rules, post-payment page |
| `data/*.json` | Fallback catalogue used whenever the API is unreachable |
| `server/` | Express API |
| `render.yaml` | Render blueprint. Does **not** reconfigure an existing service |
| `docs/CONTENT.md` | How to add releases, artwork, events, posts |

## Principles the code holds to — keep them

1. **The page renders before JavaScript runs.** The feature artwork, the
   discography and the player are real markup in `index.html`. A sleeping API or
   a failed script never costs a visitor the content. `app.js` upgrades in place.
2. **Prices are decided server-side.** The browser sends a SKU and nothing about
   money. `server/lib/catalogue.js` is the only place a price is resolved.
3. **The Mollie webhook is not trusted.** Mollie posts an id; the server
   re-fetches the payment from Mollie and rejects on an amount mismatch before
   marking anything paid.
4. **No secret in this repo — it is public.** Keys live in Render's environment.
   `server/.env` is git-ignored. Verify with `git grep` across all commits before
   any push.
5. **Every unknown has a designed state.** Nothing says "coming soon" and nothing
   is invented. If a fact is unknown it stays `null` and the UI says so.

## Layout

The artist's wireframe (`docs/wireframe.webp`): title, three equal panels with a
circled six-point asterisk and a circled pentagram on the dividers, names set
vertically, URL beneath.

Built as a 100svh gateway opening into three full-width sections, each keeping
its rotated name as a sticky spine above 1180px. **The three panels stay side by
side at every width, phone included** — vertical names are what make a narrow
column work, and collapsing to a stack loses the drawing. Do not "fix" that.

Section accents: Music yellow, Art red, Events purple. Each has a lifted
`--accent-text` variant because raw red and purple fail 4.5:1 on near-black.
`--void: #1B2951` is the artist's own colour, currently used only behind the
series statement.

## Music

Four rooms — Glass (house), Rage (drum & bass), Padded (dubstep), Forest
(hip-hop) — built as pure CSS environments, wired as a tablist with roving
tabindex. Selecting one swaps the Spotify embed to that room's playlist and
updates the label, outbound link and iframe title.

Playlist ids were confirmed against Spotify's oembed titles, **not** the order
they were sent in — three of four did not match that order. If more arrive,
verify the same way.

Releases: Evisceration (2026, latest), Tu Witchy, trap$hitty, Smack Me Up (all
2026), Bel Mercy (2022, most played, ~172k), Glorifying Addictions (2022). Every
`genre` in `data/releases.json` is still `null`, so the rooms filter to nothing
and the page explains why. Per-track BPM, key and track ids are **not known** —
do not fabricate them.

## Art

Two pieces in the catalogue:

1. **Your Money Is Mine** (25 Milli piece), Void Series / 90s Cubism, acrylic on canvas with integrated Bible price tag, 100 × 100 cm, painted 7 March – 28 November 2024. Provenance and dates authenticated on a signed sheet by Mr Jamie V. Heap.
   - Process & Symbolism: Commences with drink thrown on canvas, 3D triangles, 3-6-9 pattern, Masonic eye in hands / dark navy into black ("hiding in plain sight"), 90s Cubism / Nintendo 64 chromatic palette.
   - Physical Price Tag: Green leather New Testament Bible with cut window showing 3 torn pages, adhered cardboard painted "£25,000,000" in red acrylic.
   - Store Display Rule: Original only (1 of 1, no prints). The price is **not** displayed on the store; instead it directs visitors to email Jamie (`tumanicmae@gmail.com`) for pricing inquiries.

2. **Primary Doubt**, Void Series, acrylic on canvas, 100 × 100 cm, painted 29 July – 1 August 2026. Title, dates and dimensions confirmed by the artist on 2 August 2026.
   - Process: Ruled out in pencil into 3D triangles and freemasonry symbolism, canvas turned upside down before paint. The third eye sits in the bottom right corner (black and white).
   - Sold as a one-of-one original (£8,500) plus signed A3/A2/A1 prints (draft pricing).
   - Photos: Updated to a clean high-resolution straight-on photograph taken on the doorstep.

The artwork `id`s are `your-money-is-mine` (SKU `YMM01-ORIG`) and `tessellation-01` (SKUs `TESS01-*`).

## Analytics — read before changing anything

No cookies, no localStorage, no fingerprinting, so **no consent banner**. That is
a design property, not a coincidence — do not add anything that stores on the
device without saying so loudly.

Visitors are counted by a one-way hash of IP + user agent + **today's date** + a
secret. The date inside the hash means the same person tomorrow is an unrelated
value. Raw IPs are never stored. `Sec-GPC` and `Do Not Track` stop collection in
the browser and again on the server. Referrers are cut to a hostname.

The beacon posts `text/plain` **deliberately** — `application/json` triggers a
CORS preflight that `sendBeacon` cannot perform, so it fails silently
cross-origin. Do not "tidy" that to JSON.

Erasure keeps the sale and removes the person: UK tax rules require six years of
sales records, so deleting an order outright trades one legal problem for another.

`/admin/` is behind `ADMIN_TOKEN` with a constant-time compare, held in
`sessionStorage` for one tab. `noindex` and `robots.txt` are tidiness, not
security.

`Access-Control-Allow-Headers` **must keep listing `x-admin-token`**. The admin
panel sends that header, a custom header forces a CORS preflight, and a preflight
only permits the headers this list names. Without it every admin call is blocked
by the browser before it is sent — verified by reproducing it, not by reading the
spec. Nothing on the public site sends that header, so the bug is invisible until
someone opens `/admin` against a deployed API.

## The API — live since 2 August 2026

**`https://altopurse-github-io.onrender.com`** — named after the repo, not after
`render.yaml`, because the service predates the blueprint. `apiBase` in
`assets/js/config.js` points at it.

What was wrong for two days: the **Start Command was `npm install`**, which
installs, exits, and takes the process with it — hence `Application exited
early`, then `Port scan timeout reached`. The Build Command was `yarn`, which
ignores the committed `package-lock.json`. Neither was a code fault; a clean
clone ran `npm ci` and booted throughout. The fix was two dashboard fields:

| Field | Set to |
|---|---|
| Root Directory | `server` |
| Build Command | `npm ci` |
| Start Command | `node index.js` |

The lesson worth keeping: when Render says `Application exited early`, read the
line above it. It prints the command it actually ran, and that is the answer.

Environment variables are listed in `server/.env.example`. `PUBLIC_API_URL` can
only be set after the first deploy assigns a URL; Mollie's webhook needs it.

A clean clone of the repo runs `npm ci` and boots successfully, so the code is
not the fault. Verify that yourself before assuming otherwise.

Once it is up: set `apiBase` in `assets/js/config.js` to the Render URL, commit,
push. That single line turns on the shop, the admin and the mailing list.

Firestore is separate: the API runs without it, serving the repo JSON read-only,
but orders and analytics record nothing until
`GOOGLE_APPLICATION_CREDENTIALS_JSON` is set and `npm run seed` has run once.

## Still unknown — ask the artist, never guess into the copy

1. Real prices for each print size. Still `draftPrice: true`. The original is
   settled at £8,500.
2. Which room each of the six releases belongs to.
3. The track **Primary Doubt** — bassline house, 127 BPM, made alongside the
   painting of the same name. Not one of the six listed releases. Unknown whether
   it is released and where it can be heard, so it is **not on the site yet**.
   Once that is known it earns a Music ↔ Art link, which nothing else on the site
   currently has.
4. Apple Music and YouTube Music artist URLs — the icons stay hidden until these
   are in `config.js`, because a dead icon is worse than no icon.
5. A custom domain. `tumanic.com` was confirmed unregistered on 2 August 2026 at
   the registry (RDAP, not a reseller search) and is the chosen name; so are
   `tumanic.co.uk`, `tumanic.uk`, `tumanicmae.com` and `tumanicmae.co.uk`.
   **Do not add a CNAME file before DNS resolves** — Pages will stop serving
   `altopurse.github.io` and serve only the custom domain, which will not work
   yet. Cloudflare records must be **DNS-only (grey cloud)** or GitHub cannot
   complete the ACME challenge and HTTPS never provisions.

Closed on 2 August 2026: the piece's title, dimensions and dates (see Art); the
data controller (**JobLeadHub**, trading as TUMANIC) and the contact address
(**tumanicmae@gmail.com**), which completed `privacy.html`.

## Known open decisions

- **The Spotify embed sets third-party cookies.** Our analytics need no consent;
  that iframe technically does. Stated plainly in `privacy.html`. The clean fix
  is click-to-load, which puts a click in front of the main feature — undecided.
- **Whether `#1B2951` should become the whole site's ground** rather than just
  the statement's. If it does, `--purple-lift` drops to 4.35:1 and needs nudging.
- **Merch fulfilment** — print on demand was chosen; no account exists yet.

## Standards

- Sentence case, second person, active voice. No exclamation marks, no "simply".
- Visible `:focus-visible` on every control. Dialogs trap Tab, close on Escape
  and return focus to the opener. Escape is handled explicitly because not every
  engine fires the native `cancel` event.
- Honour `prefers-reduced-motion`; animate transform and opacity only.
- `Intl.NumberFormat` for money, `Intl.DateTimeFormat` for dates,
  `font-variant-numeric: tabular-nums` in columns.
- Headings run h1 → h4 with no gaps. Interactive targets at least 24×24, except
  links inline in a sentence.
- Design the empty, long-string and error states before the happy path.
- **Verify, then claim.** Measure contrast and layout in a browser rather than
  computing by hand — doing exactly that caught a spine at 2.68:1 and a top bar
  overflowing at 360px. State plainly what was checked and what was not.

## Environment

Windows 11, PowerShell 5.1. The Bash tool does not work here. No `&&`, no
ternary. **Do not pass multi-line commit messages as here-strings to git** — PS
5.1 re-tokenises embedded double quotes and mangles them. Write the message to a
file and use `git commit -F`. Never bulk-edit source with
`Get-Content`/`Set-Content`; it double-encodes em dashes and curly quotes.
