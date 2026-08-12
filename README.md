# TUMANIC M·A·E

Site for TUMANIC — UK producer and painter. Music, art and events.

Front end is static HTML, CSS and JavaScript with no build step, served by
GitHub Pages from the root of this repo. The API lives in [`server/`](server)
and runs on Render.

## Running it locally

```bash
python -m http.server 8080
```

Then open <http://localhost:8080>. Use a server rather than opening
`index.html` directly — the page fetches JSON, and `file://` blocks that.

## How it holds together

The page renders **before** any JavaScript runs. The feature artwork, the
discography and the Spotify player are all in `index.html` as real markup, so a
sleeping API, a failed script or a blocked CDN never costs a visitor the
content. `assets/js/app.js` upgrades that markup in place when it can.

| Path | What it holds |
|---|---|
| `index.html` | Whole page. Gateway, three sections, About, checkout dialog |
| `assets/css/styles.css` | Everything visual. Colours are sampled from the painting |
| `assets/js/config.js` | Public settings — API URL, platform links. **Never a secret** |
| `assets/js/app.js` | Data loading, room tabs, checkout, mailing list |
| `data/*.json` | Fallback catalogue, used when the API is unreachable |
| `assets/art/`, `assets/img/` | Web derivatives. Originals stay off the repo |
| `admin/` | Dashboard — visit stats, orders, erasure, Spotify sync |
| `privacy.html` | Privacy notice. Keep it true if you change what is recorded |
| `server/` | Express API — Mollie checkout, Firestore, Spotify sync, stats |
| `docs/` | The original brief and the artist's wireframe |

## Visit statistics

No cookies, no `localStorage`, no fingerprinting, so no consent banner. IP
addresses are never stored — a visitor is counted via a one-way hash of
IP + user agent + **today's date** + a secret, so the same person tomorrow is an
unrelated value and cannot be followed between days. Only daily totals survive.

You can see what happens on the site, not who did it. Following individuals
between visits would need a consent banner and considerably more paperwork.

`Sec-GPC` and `Do Not Track` stop collection entirely, checked in the browser
and again on the server.

The admin lives at `/admin/`, behind `ADMIN_TOKEN`, held in `sessionStorage`
for one tab. It is `noindex` and blocked in `robots.txt` — but note that is
obscurity, not security. The token is the security.

## Turning things on

Each of these is off until its account exists, and each fails to a designed
state rather than an error.

1. **Checkout** — deploy `server/` to Render, then set `apiBase` in
   `assets/js/config.js` to the Render URL. Until then buy buttons say the
   checkout is offline.
2. **Apple Music and YouTube Music** — paste the artist URLs into
   `config.js`. The icons appear on their own. A missing URL renders nothing,
   because a dead icon is worse than no icon.
3. **Comments** — enable Discussions on this repo, run through
   [giscus.app](https://giscus.app), and paste the four values into `config.js`.
4. **Mailing list** — set `BUTTONDOWN_API_KEY` in Render.
5. **Merch** — connect Printful or Printify and fill in `providerVariantId`
   in `data/merch.json`.

## Still needed from the artist

- Prices for each print size. The original is settled at £8,500, confirmed by
  the artist on 11 August 2026; the print prices in `data/artworks.json` are
  still **drafts** and the page says so on the page.
- A contact email for commissions and receipts.
- Which room each release belongs in — every `genre` in `data/releases.json`
  is `null`, so all four rooms are currently empty and the page says why.
- A higher-resolution photo of the painting. The best available crop is about
  1000 px square, which caps how large it can be shown.

## Rules that are not up for negotiation

- **No secret ever goes in this repo.** It is public. Keys live in Render's
  environment. `server/.env` is git-ignored.
- **Prices are computed server-side.** The browser sends a SKU and nothing
  about money. The server looks the price up in Firestore before charging.
- **The Mollie webhook is not trusted.** Mollie posts an id; the server
  re-fetches the payment from Mollie's API to find out what really happened.
