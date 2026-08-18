/* ============================================================
   TUMANIC M·A·E — API

   Two rules this file exists to enforce:
     1. Prices are decided here, from the catalogue. The browser sends a
        SKU and nothing about money.
     2. The Mollie webhook is not trusted. Mollie posts an id; we go and
        ask Mollie what actually happened.
   ============================================================ */

import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import {
  initDb, usingFirestore,
  getArtworks, getMerch, getReleases, saveReleases,
  createOrder, updateOrder, getOrder, settleOrder,
  listOrders, anonymiseOrder,
  createReport, listReports, updateReport, deleteReport
} from './lib/db.js';
import { lookupSku, toMollieAmount } from './lib/catalogue.js';
import { createPayment, getPayment } from './lib/mollie.js';
import { fetchReleases, keepGenres } from './lib/spotify.js';
import { record, stats, purge } from './lib/analytics.js';
import { seedFromRepo } from './lib/seed.js';

try { process.loadEnvFile('./.env'); } catch { /* Render supplies real env vars */ }

const app = express();
const PORT = process.env.PORT || 3000;
const CURRENCY = 'GBP';

app.set('trust proxy', 1);
// text/plain is included so the analytics beacon avoids a CORS preflight,
// which sendBeacon cannot perform.
app.use(express.json({ limit: '16kb', type: ['application/json', 'text/plain'] }));
app.use(express.urlencoded({ extended: false, limit: '16kb' })); // Mollie posts form-encoded

/* ── CORS, locked to the Pages origin ─────────────────────── */

const allowed = new Set(
  (process.env.SITE_ORIGIN ?? '')
    .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean)
    .concat(['http://localhost:8080', 'http://127.0.0.1:8080'])
);

app.use((req, res, next) => {
  const origin = req.headers.origin?.replace(/\/$/, '');
  if (origin && allowed.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    // x-admin-token has to be listed here or the browser rejects every /admin
    // call before it is sent: a custom header forces a preflight, and the
    // preflight only permits headers this list names.
    res.set('Access-Control-Allow-Headers', 'content-type, x-admin-token');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.set('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ── Crude rate limit. Enough to stop a bored script. ─────── */

const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.path}:${req.ip}`;
    const rec = hits.get(key) ?? { n: 0, reset: now + windowMs };
    if (now > rec.reset) { rec.n = 0; rec.reset = now + windowMs; }
    rec.n += 1;
    hits.set(key, rec);
    if (rec.n > max) {
      return res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
}, 60_000).unref();

/* ── Input helpers ────────────────────────────────────────── */

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

/* ── Catalogue ────────────────────────────────────────────── */

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, firestore: usingFirestore, checkout: Boolean(process.env.MOLLIE_API_KEY) });
});

app.get('/api/artworks', async (_req, res, next) => {
  try {
    const [artworks, products] = await Promise.all([getArtworks(), getMerch()]);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ source: usingFirestore ? 'firestore' : 'repo', currency: CURRENCY, artworks, products });
  } catch (err) { next(err); }
});

app.get('/api/releases', async (_req, res, next) => {
  try {
    const data = await getReleases();
    res.set('Cache-Control', 'public, max-age=300');
    res.json(data);
  } catch (err) { next(err); }
});

/* ── Orders ───────────────────────────────────────────────── */

app.post('/api/orders', limit(10, 60_000), async (req, res, next) => {
  try {
    const sku = str(req.body?.sku, 64);
    const name = str(req.body?.name, 120);
    const email = str(req.body?.email, 160);
    const address = str(req.body?.address, 400);
    const postcode = str(req.body?.postcode, 20);
    const country = str(req.body?.country, 80);

    if (!name || !address || !postcode || !country) {
      return res.status(400).json({ error: 'Some delivery details are missing.' });
    }
    if (!isEmail(email)) {
      return res.status(400).json({ error: 'That email address does not look right.' });
    }

    const item = await lookupSku(sku);
    if (!item) return res.status(404).json({ error: 'That item is not for sale.' });
    if (item.soldOut) return res.status(409).json({ error: 'That one has already sold.' });
    if (item.draft) {
      // Refused here rather than only in the browser, because the browser can
      // be bypassed and this is the last gate before a real card is charged.
      return res.status(409).json({
        error: 'The price for this piece is not final yet, so it cannot be sold. Please check back shortly.'
      });
    }

    const amount = toMollieAmount(item.priceMinor, CURRENCY);

    if (!usingFirestore) {
      return res.status(503).json({
        error: 'The shop database is not connected yet, so orders cannot be recorded.'
      });
    }

    const orderId = await createOrder({
      sku: item.sku,
      kind: item.kind,
      artworkId: item.artworkId,
      unique: Boolean(item.unique),
      description: item.description,
      amountMinor: item.priceMinor,   // recorded from the catalogue, not the client
      currency: CURRENCY,
      buyer: { name, email, address, postcode, country },
      status: 'created',
      createdAt: new Date().toISOString()
    });

    const site = (process.env.SITE_ORIGIN ?? '').split(',')[0].trim().replace(/\/$/, '');
    const api = (process.env.PUBLIC_API_URL ?? '').trim().replace(/\/$/, '');

    const payment = await createPayment({
      amount,
      description: item.description,
      redirectUrl: `${site}/thanks.html?order=${orderId}`,
      webhookUrl: api ? `${api}/api/webhooks/mollie` : null,
      metadata: { orderId }
    });

    await updateOrder(orderId, { paymentId: payment.id, status: 'pending' });

    res.json({ orderId, checkoutUrl: payment._links?.checkout?.href });
  } catch (err) { next(err); }
});

app.get('/api/orders/:id', async (req, res, next) => {
  try {
    const order = await getOrder(str(req.params.id, 64));
    if (!order) return res.status(404).json({ error: 'No such order.' });
    // Never echo the buyer's address back out.
    res.json({
      id: order.id,
      status: order.status,
      description: order.description,
      amountMinor: order.amountMinor,
      currency: order.currency
    });
  } catch (err) { next(err); }
});

/* ── Mollie webhook ───────────────────────────────────────── */

app.post('/api/webhooks/mollie', async (req, res) => {
  // Answer immediately and unconditionally: a non-2xx makes Mollie retry,
  // and a retry storm is worse than a missed log line.
  res.sendStatus(200);

  const paymentId = str(req.body?.id, 64);
  if (!paymentId) return;

  try {
    // The POST body only carries an id. Everything else comes from Mollie.
    const payment = await getPayment(paymentId);
    const orderId = payment.metadata?.orderId;
    if (!orderId) return console.warn('[webhook] payment with no orderId:', paymentId);

    const order = await getOrder(orderId);
    if (!order) return console.warn('[webhook] unknown order:', orderId);

    // Guard against a tampered or mismatched amount before marking it paid.
    const expected = (order.amountMinor / 100).toFixed(2);
    if (payment.status === 'paid' && payment.amount?.value !== expected) {
      console.error(`[webhook] amount mismatch on ${orderId}: paid ${payment.amount?.value}, expected ${expected}`);
      await updateOrder(orderId, { status: 'flagged', flagReason: 'amount-mismatch' });
      return;
    }

    await settleOrder(orderId, {
      paymentStatus: payment.status,
      item: { unique: order.unique, artworkId: order.artworkId }
    });
    console.log(`[webhook] order ${orderId} -> ${payment.status}`);
  } catch (err) {
    console.error('[webhook] failed:', err.message);
  }
});

/* ── Mailing list ─────────────────────────────────────────── */

app.post('/api/subscribe', limit(5, 60_000), async (req, res, next) => {
  try {
    const email = str(req.body?.email, 160);
    if (!isEmail(email)) return res.status(400).json({ error: 'That email address does not look right.' });

    const key = process.env.BUTTONDOWN_API_KEY?.trim();
    if (!key) return res.status(503).json({ error: 'The mailing list is not connected yet.' });

    const r = await fetch('https://api.buttondown.email/v1/subscribers', {
      method: 'POST',
      headers: { authorization: `Token ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email_address: email, type: 'regular' })
    });

    // An address already on the list is a success from the visitor's side.
    if (!r.ok && r.status !== 400) throw new Error('The list provider refused that.');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ── Analytics intake ─────────────────────────────────────── */

app.post('/api/collect', limit(120, 60_000), async (req, res) => {
  // Answer first: a visitor should never wait on a counter.
  res.sendStatus(204);

  // Global Privacy Control is a legally recognised opt-out in some
  // jurisdictions. The client already checks it; this is the backstop.
  if (req.get('sec-gpc') === '1' || req.get('dnt') === '1') return;

  try {
    await record({
      ip: req.ip,
      ua: req.get('user-agent'),
      lang: req.get('accept-language'),
      referrer: str(req.body?.referrer, 300),
      path: str(req.body?.path, 120),
      event: str(req.body?.event, 40),
      room: str(req.body?.room, 24)
    });
  } catch (err) {
    console.error('[collect]', err.message);
  }
});

/* ── Admin ────────────────────────────────────────────────── */

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN?.trim();
  const given = req.get('x-admin-token') ?? '';
  if (!expected) return res.status(503).json({ error: 'No admin token is configured on the server.' });

  // Constant-time compare so the token cannot be guessed a character at a time.
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Not authorised.' });
  }
  next();
}

app.get('/api/admin/stats', requireAdmin, async (req, res, next) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    res.set('Cache-Control', 'no-store');
    res.json(await stats({ days }));
  } catch (err) { next(err); }
});

app.get('/api/admin/orders', requireAdmin, async (_req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ orders: await listOrders({ limit: 100 }) });
  } catch (err) { next(err); }
});

app.post('/api/admin/orders/:id/anonymise', requireAdmin, async (req, res, next) => {
  try {
    await anonymiseOrder(str(req.params.id, 64));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/admin/purge', requireAdmin, async (_req, res, next) => {
  try { res.json(await purge({})); } catch (err) { next(err); }
});

app.post('/api/admin/seed', requireAdmin, async (_req, res, next) => {
  try {
    res.json({ ok: true, ...(await seedFromRepo()) });
  } catch (err) {
    // This one is worth surfacing: "Firestore is not connected" tells the
    // artist exactly what to fix, where the generic 500 would not.
    res.status(503).json({ error: err.message });
  }
});

/* ── Reports: bugs and feature requests ───────────────────── */

// Pictures arrive as data URLs, so this route alone needs a body limit far
// above the 16kb the rest of the API uses. Mounted here rather than globally,
// so nothing else gains a 2MB attack surface.
const bigJson = express.json({ limit: '2mb' });

const MAX_SHOTS = 6;
// The whole report is one Firestore document and a document caps at 1MB, so
// what matters is the pictures added together, not any one of them. The
// browser divides this between however many are attached before encoding.
const MAX_SHOT_TOTAL = 1_000_000;

const isImageDataUrl = (s) => /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s);

app.post('/api/admin/reports', requireAdmin, bigJson, limit(30, 60_000), async (req, res, next) => {
  try {
    const body = str(req.body?.body, 4000);
    const kind = ['bug', 'feature'].includes(req.body?.kind) ? req.body.kind : 'bug';
    const from = str(req.body?.from, 60);
    const page = str(req.body?.page, 300);

    // `shot` is still read because a cached copy of the old admin page posts
    // one picture under that name, and it should not start failing.
    const shots = (Array.isArray(req.body?.shots) ? req.body.shots : [req.body?.shot])
      .filter((s) => typeof s === 'string' && s);

    if (!body) return res.status(400).json({ error: 'Say what happened before sending it.' });

    if (shots.length > MAX_SHOTS) {
      return res.status(400).json({ error: `A report holds ${MAX_SHOTS} pictures. Send the rest as a second one.` });
    }
    // Only ever accept image data URLs. Anything else is either a mistake or
    // an attempt to store something that will later be served back to a browser.
    if (!shots.every(isImageDataUrl)) {
      return res.status(400).json({ error: 'One of those attachments is not an image.' });
    }
    if (shots.reduce((n, s) => n + s.length, 0) > MAX_SHOT_TOTAL) {
      return res.status(413).json({ error: 'Those pictures are too large even after resizing. Send fewer at once, or crop them.' });
    }

    const id = await createReport({
      kind, body, from, page, shots,
      status: 'open',
      createdAt: new Date().toISOString()
    });
    res.json({ ok: true, id });
  } catch (err) { next(err); }
});

app.get('/api/admin/reports', requireAdmin, async (_req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ reports: await listReports({ limit: 50 }) });
  } catch (err) { next(err); }
});

app.post('/api/admin/reports/:id/status', requireAdmin, bigJson, async (req, res, next) => {
  try {
    const status = ['open', 'done'].includes(req.body?.status) ? req.body.status : 'open';
    await updateReport(str(req.params.id, 64), { status });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/admin/reports/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    await deleteReport(str(req.params.id, 64));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/admin/sync', requireAdmin, async (_req, res, next) => {
  try {
    const previous = await getReleases().catch(() => ({ releases: [] }));
    const fresh = await fetchReleases();
    const releases = keepGenres(fresh, previous.releases ?? []);

    await saveReleases({
      source: 'spotify',
      updated: new Date().toISOString(),
      artist: previous.artist ?? {},
      rooms: previous.rooms ?? [],
      releases
    });

    res.json({ ok: true, count: releases.length });
  } catch (err) { next(err); }
});

/* ── Errors ───────────────────────────────────────────────── */

app.use((_req, res) => res.status(404).json({ error: 'No such endpoint.' }));

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  // Never hand an internal message to the browser.
  res.status(500).json({ error: 'Something went wrong at our end. Nothing has been charged.' });
});

await initDb();
if (usingFirestore) {
  try {
    const res = await seedFromRepo();
    console.log(`[db] Auto-seeded catalogue into Firestore on boot (${res.total} items).`);
  } catch (err) {
    console.error('[db] Auto-seed failed on boot:', err.message);
  }
}
app.listen(PORT, () => {
  console.log(`[api] listening on ${PORT} — firestore=${usingFirestore}`);
});
