/* ============================================================
   TUMANIC M·A·E — front end
   The page already renders without this file: the feature artwork,
   the discography and the player are in the HTML. Everything here
   is an upgrade on top of that, so a sleeping backend or a failed
   script never costs a visitor the content.
   ============================================================ */

const CFG = window.TUMANIC_CONFIG ?? {};
const API = (CFG.apiBase ?? '').replace(/\/$/, '');

const money = new Intl.NumberFormat(CFG.locale ?? 'en-GB', {
  style: 'currency',
  currency: CFG.currency ?? 'GBP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
});

const longDate = new Intl.DateTimeFormat(CFG.locale ?? 'en-GB', {
  day: 'numeric', month: 'long', year: 'numeric'
});

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Fetch that gives up rather than hanging — Render's free tier sleeps. */
async function getJSON(url, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ── Footer year, contact link ────────────────────────────── */

function chrome() {
  const year = $('#year');
  if (year) year.textContent = String(new Date().getFullYear());

  const contact = $('#contact-link');
  if (!contact) return;
  if (CFG.contactEmail) {
    contact.href = `mailto:${CFG.contactEmail}?subject=${encodeURIComponent('Enquiry via tumanic.com')}`;
  } else {
    // No address yet — send people somewhere real rather than a broken mailto.
    contact.href = '#newsletter';
    contact.textContent = 'Join the list';
  }
}

/* ── Top bar reveals once the gateway is behind you ───────── */

function topbar() {
  const bar = $('#topbar');
  const gate = $('#gateway');
  if (!bar || !gate || !('IntersectionObserver' in window)) return;

  new IntersectionObserver(
    ([entry]) => bar.setAttribute('data-hidden', String(entry.isIntersecting)),
    { rootMargin: '-40% 0px 0px 0px' }
  ).observe(gate);
}

/* ── Extra platform links, when their URLs are known ──────── */

function platforms() {
  const list = $('.platforms');
  if (!list) return;

  const extra = [
    { url: CFG.platforms?.appleMusic,   label: 'Apple Music',   icon: '#ic-apple' },
    { url: CFG.platforms?.youtubeMusic, label: 'YouTube Music', icon: '#ic-ytmusic' }
  ];

  for (const { url, label, icon } of extra) {
    if (!url) continue;
    const li = document.createElement('li');
    li.innerHTML = `<a class="platform" href="${url}" target="_blank" rel="noopener">
      <svg class="platform__ic" aria-hidden="true"><use href="${icon}"/></svg>
      ${label}<span class="platform__ext" aria-hidden="true">↗</span></a>`;
    list.append(li);
  }
}

/* ── Player follows the room ──────────────────────────────── */

/**
 * Each room has its own Spotify playlist; Everything shows the artist.
 * Swapping the src reloads the embed, so anything playing stops — which is
 * what you want when you have deliberately changed room.
 */
function swapDeck(tab) {
  const frame = $('#deck-frame');
  const label = $('#deck-label');
  const link = $('#deck-link');
  const embed = tab.dataset.embed;
  if (!frame || !embed) return;

  const next = `https://open.spotify.com/embed/${embed}?utm_source=generator&theme=0`;
  if (frame.getAttribute('src') === next) return;

  const name = tab.dataset.embedName ?? tab.querySelector('.room__name')?.textContent?.trim() ?? '';
  frame.setAttribute('src', next);
  frame.title = `TUMANIC on Spotify — ${name}`;
  if (label) label.textContent = name;
  if (link) link.href = `https://open.spotify.com/${embed}`;
}

/* ── Rooms: tabs with roving tabindex ─────────────────────── */

function rooms() {
  const tabs = $$('.room[role="tab"]');
  const panel = $('#panel-releases');
  const empty = $('#disco-empty');
  if (!tabs.length || !panel) return;

  function select(tab, { focus = true } = {}) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    }
    panel.setAttribute('aria-labelledby', tab.id);
    if (focus) tab.focus();

    swapDeck(tab);

    const room = tab.dataset.room;
    let shown = 0;
    for (const track of $$('.track', panel)) {
      const match = room === 'all' || track.dataset.genre === room;
      track.hidden = !match;
      if (match) shown += 1;
    }
    if (empty) empty.hidden = shown > 0;
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => select(tab, { focus: false }));
    tab.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(tab);
      let next = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = tabs[(i + 1) % tabs.length];
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === 'Home') next = tabs[0];
      else if (e.key === 'End') next = tabs.at(-1);
      if (!next) return;
      e.preventDefault();
      select(next);
    });
  }

  const jump = $('[data-goto-room]');
  if (jump) jump.addEventListener('click', () => {
    const target = tabs.find((t) => t.dataset.room === jump.dataset.gotoRoom);
    if (target) select(target);
  });
}

/* ── Data: backend first, local JSON as the safety net ────── */

const state = { artworks: [], merch: [], online: false, reason: '' };

async function loadShop() {
  const status = $('#shop-status');

  // Load the local catalogue first so static assets/pieces are always known.
  let localArt = [];
  let localMerch = [];
  try {
    const [art, merch] = await Promise.all([
      getJSON('data/artworks.json'),
      getJSON('data/merch.json')
    ]);
    localArt = art.artworks ?? [];
    localMerch = merch.products ?? [];
  } catch {
    // index.html holds the static fallback
  }

  if (API) {
    try {
      const live = await getJSON(`${API}/api/artworks`);
      const liveMap = new Map((live.artworks ?? []).map((a) => [a.id, a]));
      // Keep all local pieces, overlaying live Firestore state (pricing/availability)
      const combinedArt = localArt.map((l) => {
        const r = liveMap.get(l.id);
        if (!r) return l;
        return {
          ...r,
          images: l.images ?? r.images,
          description: l.description ?? r.description,
          dimensions: l.dimensions ?? r.dimensions,
          series: l.series ?? r.series
        };
      });
      // Append any live pieces not in local
      const localIds = new Set(localArt.map((a) => a.id));
      for (const a of (live.artworks ?? [])) {
        if (!localIds.has(a.id)) combinedArt.push(a);
      }
      state.artworks = combinedArt.length > 0 ? combinedArt : (live.artworks ?? localArt);
      state.merch = (live.products && live.products.length > 0) ? live.products : localMerch;
      state.online = true;

      // Checkout needs a database that is both connected and stocked.
      const canCheckout = live.source === 'firestore' && state.artworks.length > 0;
      applyShop({ live: canCheckout });

      if (!canCheckout && status) {
        status.textContent = 'The shop is not open yet. Everything here is real, but you cannot check out.';
      } else if (canCheckout && status) {
        const allDraft = state.artworks.every(
          (a) => (a.original?.draftPrice || a.original?.inquireOnly) && (a.prints ?? []).every((p) => p.draftPrice)
        );
        status.textContent = allDraft
          ? 'Prices are still being finalised, so nothing can be bought just yet. Join the list below and you will know first.'
          : '';
      }
      return;
    } catch (err) {
      state.reason = err.name === 'AbortError' ? 'timeout' : 'unreachable';
    }
  } else {
    state.reason = 'not-configured';
  }

  state.artworks = localArt;
  state.merch = localMerch;
  applyShop({ live: false });

  if (status) {
    status.textContent = state.reason === 'not-configured'
      ? 'The shop is not open yet. Everything here is real, but you cannot check out.'
      : 'The shop is offline right now, so checkout is unavailable. The artwork below is up to date.';
    if (state.reason !== 'not-configured') {
      const retry = document.createElement('button');
      retry.className = 'linkish';
      retry.type = 'button';
      retry.textContent = 'Try again';
      retry.style.marginLeft = '.5rem';
      retry.addEventListener('click', () => { status.textContent = 'Checking…'; loadShop(); });
      status.append(' ', retry);
    }
  }
}

/* ── Pieces: one artwork or fifteen, from the same catalogue ─
   The Art section used to be a single hand-written piece. Everything below
   builds that same block from the catalogue instead, so putting a second and
   third canvas on the site is an edit to data/artworks.json rather than to
   this file or to index.html.

   Anything that reaches innerHTML here is escaped. The catalogue comes from
   Firestore, which the artist can write to from /admin, so treating it as
   trusted markup would be a stored-XSS hole in the one place a non-developer
   types. ───────────────────────────────────────────────────── */

const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

const dayMonth = new Intl.DateTimeFormat(CFG.locale ?? 'en-GB', { day: 'numeric', month: 'long' });

/** Local midnight, not UTC — `new Date('2026-07-29')` is UTC and lands on the
 *  28th for anyone west of London. */
function parseDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** "29 July – 1 August 2026", or one date, or the year, or nothing. */
function painted(art) {
  const tag = (iso, text) => `<time datetime="${esc(iso)}">${esc(text)}</time>`;
  const from = parseDay(art.startedOn);
  const to = parseDay(art.finishedOn);
  if (from && to) return `${tag(art.startedOn, dayMonth.format(from))} – ${tag(art.finishedOn, longDate.format(to))}`;
  if (to) return tag(art.finishedOn, longDate.format(to));
  if (from) return tag(art.startedOn, longDate.format(from));
  return art.year ? esc(String(art.year)) : '';
}

function specsHTML(art) {
  const rows = [];
  if (art.series) rows.push(['Series', esc(art.series)]);
  const when = painted(art);
  if (when) rows.push(['Painted', when]);
  if (art.medium) rows.push(['Medium', esc(art.medium)]);

  const d = art.dimensions;
  rows.push(['Size', d?.width && d?.height
    ? `${esc(d.width)} × ${esc(d.height)}&nbsp;${esc(d.unit ?? 'cm')}`
    // Said plainly rather than left out. A missing row reads as an oversight;
    // this reads as a fact nobody has measured yet, which is what it is.
    : '<span class="specs__unknown">Not measured yet</span>']);

  if (art.original?.editionText) {
    rows.push(['Edition', esc(art.original.editionText)]);
  } else if (art.original?.editionNumber && art.original?.editionOf) {
    rows.push(['Edition', `Original, ${esc(art.original.editionNumber)} of ${esc(art.original.editionOf)}`]);
  } else if (art.original?.editionOf === 1) {
    rows.push(['Edition', 'Original, one of one']);
  }
  return rows.map(([k, v]) => `<div class="specs__row"><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('');
}

function buysHTML(art) {
  const rows = [];
  if (art.original?.sku) {
    rows.push({
      name: 'The original',
      note: art.original.note ?? 'Unique canvas',
      priceMinor: art.original.priceMinor,
      inquireOnly: art.original.inquireOnly === true,
      sku: art.original.sku
    });
  }
  for (const p of art.prints ?? []) {
    if (!p.sku) continue;
    rows.push({
      name: `${p.size ?? 'Print'} print`,
      note: [p.sizeNote, p.editionOf ? `edition of ${p.editionOf}` : null].filter(Boolean).join(' · '),
      priceMinor: p.priceMinor,
      inquireOnly: p.inquireOnly === true,
      sku: p.sku
    });
  }
  if (!rows.length) return '';

  return `<div class="buys" data-field="buys">${rows.map((r) => {
    if (r.inquireOnly) {
      const subject = encodeURIComponent(`Enquiry regarding ${art.title || 'the original canvas'}`);
      const mailto = `mailto:${CFG.contactEmail || 'tumanicmae@gmail.com'}?subject=${subject}`;
      return `<div class="buy">
          <div class="buy__what">
            <span class="buy__name">${esc(r.name)}</span>
            <span class="buy__note">${esc(r.note)}</span>
          </div>
          <span class="buy__price">Price on enquiry</span>
          <a class="btn btn--buy" href="${mailto}">Enquire</a>
        </div>`;
    }
    const minor = Number(r.priceMinor);
    return `<div class="buy">
        <div class="buy__what">
          <span class="buy__name">${esc(r.name)}</span>
          <span class="buy__note">${esc(r.note)}</span>
        </div>
        <span class="buy__price"${Number.isFinite(minor) ? ` data-price="${esc(minor)}"` : ''}>${
          Number.isFinite(minor) ? esc(money.format(minor / 100)) : '<span class="specs__unknown">No price yet</span>'
        }</span>
        <button class="btn btn--buy" type="button" data-sku="${esc(r.sku)}">Buy</button>
      </div>`;
  }).join('')}</div>`;
}

/** Only says what is actually still a draft for this piece. */
function draftNoteHTML(art) {
  const origDraft = art.original?.draftPrice === true;
  const printDraft = (art.prints ?? []).some((p) => p.draftPrice === true);
  if (!origDraft && !printDraft) return '';
  const text = origDraft && printDraft
    ? 'These prices are drafts and will be confirmed before the shop opens.'
    : origDraft
      ? 'The price of the original is a draft and will be confirmed before the shop opens.'
      : 'The print prices are drafts and will be confirmed before the shop opens. The price of the original is the artist’s, and it is final.';
  return `<p class="draft-note" id="draft-note-${esc(art.id)}">${text}</p>`;
}

function stageHTML(art) {
  const hero = art.images?.hero;
  if (!hero?.webp) return '';

  const srcset = [
    hero.w320 ? `${hero.w320} 320w` : null,
    hero.w640 ? `${hero.w640} 640w` : null,
    hero.width ? `${hero.webp} ${hero.width}w` : null
  ].filter(Boolean).join(', ');

  const extras = [];
  const insitu = art.images.insitu;
  if (insitu?.webp) {
    extras.push(`<li><img src="${esc(insitu.w400 ?? insitu.webp)}" data-full="${esc(insitu.webp)}" loading="lazy" decoding="async" alt="${esc(insitu.alt)}"></li>`);
  }
  for (const d of art.images.details ?? []) {
    if (d?.webp) extras.push(`<li><img src="${esc(d.webp)}" loading="lazy" decoding="async" alt="${esc(d.alt)}"></li>`);
  }

  return `<div class="feature__stage">
      <figure class="feature__hero" data-lightbox>
        <img src="${esc(hero.webp)}"${srcset ? ` srcset="${esc(srcset)}"` : ''}
             sizes="(min-width: 1180px) 36vw, (min-width: 900px) 44vw, 92vw"${
               hero.width ? ` width="${esc(hero.width)}" height="${esc(hero.height ?? hero.width)}"` : ''}
             decoding="async" data-full="${esc(hero.jpg ?? hero.webp)}" alt="${esc(hero.alt)}">
        ${(art.original?.editionNumber && art.original?.editionOf) ? `<figcaption class="feature__flag">${esc(art.original.editionNumber)} of ${esc(art.original.editionOf)}</figcaption>` : art.original?.editionOf === 1 ? '<figcaption class="feature__flag">One of one</figcaption>' : ''}
      </figure>
      ${extras.length ? `<ul class="strip" aria-label="Detail views" data-lightbox>${extras.join('')}</ul>` : ''}
    </div>`;
}

function pieceHTML(art) {
  const stage = stageHTML(art);
  const paras = String(art.description ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p class="feature__desc">${esc(p)}</p>`)
    .join('');

  return `<article class="feature${stage ? '' : ' feature--noshot'}" id="piece-${esc(art.id)}" data-artwork="${esc(art.id)}">
      ${stage || '<p class="feature__noshot">This one has not been photographed yet.</p>'}
      <div class="feature__body">
        <h4 class="feature__title" data-field="title">${esc(art.title || 'Untitled')}</h4>
        ${paras}
        <dl class="specs" data-field="specs">${specsHTML(art)}</dl>
        ${buysHTML(art)}
        ${draftNoteHTML(art)}
      </div>
    </article>`;
}

function renderPieces() {
  const host = $('#pieces');
  // An empty catalogue means the fetch failed on both the API and the local
  // JSON. index.html still holds the first piece, and a stale piece beats an
  // empty Art section, so leave that markup exactly where it is.
  if (!host || !state.artworks.length) return;

  host.innerHTML = state.artworks.map(pieceHTML).join('');
  wireZoom(host);

  const nav = $('#piece-index');
  if (!nav) return;
  const many = state.artworks.length > 1;
  nav.innerHTML = many
    ? state.artworks.map((a) => `<a href="#piece-${esc(a.id)}">${esc(a.title || 'Untitled')}</a>`).join('')
    : '';
  nav.hidden = !many;
}

function applyShop({ live }) {
  renderPieces();

  // Prices: format from minor units so the markup never carries a formatted string.
  for (const el of $$('[data-price]')) {
    const minor = Number(el.dataset.price);
    if (Number.isFinite(minor)) el.textContent = money.format(minor / 100);
  }

  // The gateway counts are the artist's stated body of work, not the size of
  // this catalogue — 15 originals exist, one is photographed and for sale. They
  // are written in the HTML and deliberately not overwritten from here.

  const sold = new Set();
  // A draft price is a placeholder nobody has signed off. The server refuses
  // these too — this only saves the visitor filling in a delivery address
  // before being told no.
  const draftSkus = new Set();
  for (const a of state.artworks) {
    if (a.original && a.original.available === false) sold.add(a.original.sku);
    if (a.original?.draftPrice) draftSkus.add(a.original.sku);
    for (const p of a.prints ?? []) {
      if (p.available === false) sold.add(p.sku);
      if (p.draftPrice) draftSkus.add(p.sku);
    }
  }

  for (const btn of $$('.btn--buy')) {
    if (!btn.dataset.sku) continue;
    const row = btn.closest('.buy');
    if (sold.has(btn.dataset.sku)) {
      btn.disabled = true;
      btn.textContent = 'Sold';
      if (row) row.dataset.sold = 'true';
      continue;
    }
    if (draftSkus.has(btn.dataset.sku)) {
      btn.disabled = true;
      btn.textContent = 'Price to confirm';
      // Each piece carries its own note, so the id has to be the piece's own.
      // One shared #draft-note would be a duplicate id the moment a second
      // canvas is listed, and aria-describedby would resolve to the wrong one.
      const piece = btn.closest('[data-artwork]');
      if (piece) btn.setAttribute('aria-describedby', `draft-note-${piece.dataset.artwork}`);
      continue;
    }
    if (live) {
      btn.disabled = false;
      btn.textContent = 'Buy';
      btn.removeAttribute('aria-describedby');
      btn.addEventListener('click', () => openCheckout(btn), { once: false });
    } else {
      btn.disabled = true;
      btn.textContent = 'Checkout offline';
      btn.setAttribute('aria-describedby', 'shop-status');
    }
  }
}

async function loadReleases() {
  let data = null;

  if (API) {
    try { data = await getJSON(`${API}/api/releases`); } catch { /* fall through */ }
  }
  if (!data) {
    try { data = await getJSON('data/releases.json'); } catch { return; }
  }

  const releases = data.releases ?? [];

  // Tag the static list with genres so the rooms can filter it.
  const rows = $$('#disco-list .track');
  releases.forEach((rel, i) => {
    const row = rows[i];
    if (row && rel.genre) row.dataset.genre = rel.genre;
  });

  const untagged = releases.filter((r) => !r.genre).length;
  const status = $('#disco-status');
  if (status && untagged === releases.length && releases.length > 0) {
    status.textContent = 'Releases are not sorted into rooms yet, so every room is empty. Everything is listed below.';
  }
}

/* ── Doors: make the colour rise where there is no hover ──── */

/**
 * Reported twice as "the three tabs still aren't rising with colour". They
 * were not, and the code was correct: the rise is a :hover effect, and the
 * artist works from a phone, where hover does not exist. Rather than leave a
 * static band, trigger the same rise as each door scrolls into view.
 *
 * Only on hover-less pointers — a mouse user already has the real thing, and
 * firing both would flip the door back to rest the moment they moved away.
 */
function doors() {
  if (!window.matchMedia?.('(hover: none)').matches) return;
  const list = $$('.door');
  if (!list.length) return;

  // No IntersectionObserver here on purpose. The doors sit in the gateway,
  // which is the first full screen, so they are already in view on load —
  // scroll detection would add a dependency and buy nothing. The stagger is
  // in the CSS, so one flag on each is all this needs.
  const rise = () => { for (const d of list) d.dataset.risen = ''; };

  // A beat after paint, so the rise reads as a movement rather than as the
  // colour simply having always been there.
  if (document.readyState === 'complete') setTimeout(rise, 350);
  else window.addEventListener('load', () => setTimeout(rise, 350), { once: true });
}

/* ── Image viewer ─────────────────────────────────────────── */

/**
 * The artwork is the reason anyone is on this page, and until now the images
 * were 300px wide and could not be opened. Clicking any of them now shows it
 * full size.
 *
 * The thumbnails become real buttons rather than click handlers on <img>, so
 * they are reachable by Tab and announced as controls. The alt text does double
 * duty as the caption, which keeps one description in one place.
 */
let zoomOpener = null;

function openViewer(src, alt) {
  const dialog = $('#viewer');
  const img = $('#viewer-img');
  const cap = $('#viewer-cap');
  if (!dialog || !img) return;

  img.src = src;
  img.alt = alt ?? '';
  if (cap) cap.textContent = alt ?? '';
  // showModal only arrived in Safari 15.4. On an older phone it is either
  // missing or throws, and the tap then does nothing at all — reported as
  // "the pictures on the store can't be selected". Opening the file directly
  // is a worse experience than the viewer, but an infinitely better one than
  // a button that silently ignores you.
  try {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else window.open(src, '_blank', 'noopener');
  } catch {
    window.open(src, '_blank', 'noopener');
  }
}

/**
 * Wrap every lightbox image in a button. Called once at load and again each
 * time the pieces are re-rendered, so it has to skip anything already wrapped
 * — a second pass over the same image would nest a button inside a button,
 * which is invalid and drops it out of the tab order.
 */
function wireZoom(root = document) {
  for (const host of $$('[data-lightbox]', root)) {
    for (const thumb of $$('img', host)) {
      if (thumb.closest('.zoom')) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'zoom';
      // The full-size file, not the thumbnail: srcset picks a small source for
      // a small box, and reusing that in the viewer would show a blurry image.
      // || rather than ??: a lazy image that has not started loading reports
      // currentSrc as an empty string, not null, and ?? kept that empty string
      // — which is why three of the four detail views opened a blank viewer.
      btn.dataset.full = thumb.dataset.full || thumb.currentSrc || thumb.src;
      btn.setAttribute('aria-label', `Enlarge: ${thumb.alt || 'artwork'}`);
      thumb.replaceWith(btn);
      btn.append(thumb);
      btn.addEventListener('click', () => {
        zoomOpener = btn;
        openViewer(btn.dataset.full, thumb.alt);
      });
    }
  }
}

function viewer() {
  const dialog = $('#viewer');
  const img = $('#viewer-img');
  if (!dialog || !img) return;

  wireZoom();

  const close = () => dialog.close();
  $('#viewer-close')?.addEventListener('click', close);

  // Escape explicitly: not every engine fires cancel, and preventDefault stops
  // the two paths racing where the native one does work.
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    close();
  });

  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });

  dialog.addEventListener('close', () => {
    img.src = '';           // release the decoded image
    const target = zoomOpener;
    zoomOpener = null;
    // Restore focus on the next frame. Calling focus() inside the close event
    // races the browser's own focus handling and loses — measured, not
    // guessed: focus stayed on the dialog's close button.
    requestAnimationFrame(() => target?.focus());
  });
}

/* ── Checkout ─────────────────────────────────────────────── */

let openerEl = null;

function openCheckout(btn) {
  const dialog = $('#buy-dialog');
  if (!dialog) return;
  openerEl = btn;

  const row = btn.closest('.buy');
  const name = row ? $('.buy__name', row)?.textContent?.trim() : 'Artwork';
  const note = row ? $('.buy__note', row)?.textContent?.trim() : '';
  const price = row ? $('.buy__price', row)?.textContent?.trim() : '';

  $('#buy-piece').textContent = name ?? 'Artwork';
  $('#buy-detail').textContent = note ?? '';
  $('#buy-price').textContent = price ?? '';
  $('#buy-form').dataset.sku = btn.dataset.sku ?? '';

  const err = $('#buy-error');
  err.hidden = true;
  err.textContent = '';

  dialog.showModal();          // native modal traps Tab and closes on Escape
  $('#buy-name').focus();
}

function checkout() {
  const dialog = $('#buy-dialog');
  const form = $('#buy-form');
  if (!dialog || !form) return;

  const close = () => dialog.close();
  $('#buy-close')?.addEventListener('click', close);

  // Close on Escape explicitly. Most engines do this natively via the cancel
  // event, but not all of them do, and preventDefault keeps the two paths
  // from racing where the native one works.
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    close();
  });

  // Return focus to whatever opened the dialog, on the next frame — doing it
  // inside the close event races the browser's focus handling and loses.
  dialog.addEventListener('close', () => {
    const target = openerEl;
    openerEl = null;
    requestAnimationFrame(() => target?.focus());
  });

  // Clicking the backdrop closes it.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#buy-error');
    const submit = $('#buy-submit');

    for (const field of $$('input[required], textarea[required]', form)) {
      const bad = !field.checkValidity();
      field.setAttribute('aria-invalid', String(bad));
      if (bad) {
        err.hidden = false;
        err.textContent = 'Check the highlighted fields — something is missing or mistyped.';
        field.focus();
        return;
      }
    }

    if (!API) {
      err.hidden = false;
      err.textContent = 'Checkout is not connected yet, so this order cannot be taken.';
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Talking to the payment page…';
    err.hidden = true;

    try {
      // Only the SKU and the buyer's details go up. The server looks the
      // price up in the database — nothing about money is trusted from here.
      const res = await fetch(`${API}/api/orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sku: form.dataset.sku,
          name: $('#buy-name').value.trim(),
          email: $('#buy-email').value.trim(),
          address: $('#buy-address').value.trim(),
          postcode: $('#buy-postcode').value.trim(),
          country: $('#buy-country').value.trim()
        })
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.checkoutUrl) {
        throw new Error(body.error ?? 'The payment page could not be created.');
      }
      window.location.href = body.checkoutUrl;
    } catch (ex) {
      err.hidden = false;
      err.textContent = `${ex.message} Nothing has been charged. Try again in a moment.`;
      submit.disabled = false;
      submit.textContent = 'Continue to payment';
    }
  });
}

/* ── Mailing list ─────────────────────────────────────────── */

function newsletter() {
  const form = $('#newsletter');
  if (!form) return;
  const msg = $('#sub-msg');
  const input = $('#sub-email');
  const btn = $('#sub-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!input.checkValidity()) {
      input.setAttribute('aria-invalid', 'true');
      msg.dataset.state = 'error';
      msg.textContent = 'That email address does not look right — check it and try again.';
      input.focus();
      return;
    }
    input.setAttribute('aria-invalid', 'false');

    if (!API) {
      msg.dataset.state = 'error';
      msg.textContent = 'The list is not connected yet. Try again once the site is live.';
      return;
    }

    btn.disabled = true;
    msg.dataset.state = '';
    msg.textContent = 'Adding you…';

    try {
      const res = await fetch(`${API}/api/subscribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: input.value.trim() })
      });
      if (!res.ok) throw new Error('That did not go through.');
      msg.dataset.state = 'ok';
      msg.textContent = 'You are on the list. Check your inbox to confirm.';
      form.reset();
    } catch (ex) {
      msg.dataset.state = 'error';
      msg.textContent = `${ex.message} Try again in a moment.`;
    } finally {
      btn.disabled = false;
    }
  });
}

/* ── Comments ─────────────────────────────────────────────── */

function comments() {
  const mount = $('#comments');
  const g = CFG.giscus ?? {};
  if (!mount || !g.repo || !g.repoId || !g.categoryId) return;

  $('#comments-fallback')?.remove();
  const s = document.createElement('script');
  s.src = 'https://giscus.app/client.js';
  s.async = true;
  s.crossOrigin = 'anonymous';
  Object.assign(s.dataset, {
    repo: g.repo,
    repoId: g.repoId,
    category: g.category ?? 'General',
    categoryId: g.categoryId,
    mapping: 'pathname',
    reactionsEnabled: '1',
    emitMetadata: '0',
    inputPosition: 'top',
    theme: 'dark_dimmed',
    lang: 'en',
    loading: 'lazy'
  });
  mount.append(s);
}

/* ── Go ───────────────────────────────────────────────────── */

chrome();
topbar();
platforms();
rooms();
doors();
viewer();
checkout();
newsletter();
comments();
loadShop();
loadReleases();
