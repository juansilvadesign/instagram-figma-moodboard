// content.js — injects a download button into each Instagram post's action bar and runs the
// capture flow on click. Loaded after resolver.js (classic scripts, shared via globalThis).
//
// Uses EVENT DELEGATION — a single capture-phase click listener on `document` — instead of
// per-button listeners. Instagram is a recycling React SPA: a per-button listener dies whenever
// React re-renders the action bar subtree, and IG's own click handling can swallow the event.
// A delegated capture-phase listener survives re-renders and fires before IG's handlers.
// (Proven pattern from the twitter-video-downloader sibling.)
//
// DOM heuristics live in this file and are the part most likely to drift when Instagram changes
// its markup. NEVER match by aria-label text — labels follow the profile's UI language (this
// user's Chrome runs PT-BR: "Curtir", "Comentar", "Salvar"), so only structural selectors are safe.

console.log('[IGFM] content script loaded on', location.href);

const R = globalThis.IGFM_RESOLVER;

// Download glyph (same asset as the twitter-video-downloader sibling), fills follow currentColor.
const DL_PATHS =
  '<path fill="currentColor" d="M11.2419 15.1531L5.83239 9.86407L7.17053 8.54645L10.2929 11.6085V2.70996H12.1909V11.6085L15.3227 8.54645L16.6609 9.86407L11.2419 15.1531Z"/>' +
  '<path fill="currentColor" d="M19.7926 14.2249L19.7736 17.4818C19.7736 18.7623 18.7107 19.7923 17.401 19.7923H5.08255C3.76339 19.7923 2.70996 18.753 2.70996 17.4725V14.2249H4.60803V17.4725C4.60803 17.7323 4.81682 17.9365 5.08255 17.9365H17.401C17.6668 17.9365 17.8756 17.7323 17.8756 17.4725L17.8945 14.2249H19.7926Z"/>';

const dlSvg = (size) =>
  `<svg viewBox="0 0 23 23" width="${size}" height="${size}" fill="none" aria-hidden="true">${DL_PATHS}</svg>`;

function findShortcode(container) {
  // Prefer canonical page signals over scanning DOM links. On a permalink/reel the clicked
  // container can be a broad <main> holding unrelated links, and a reel's /reels/audio/<id>/
  // attribution link sits BEFORE its own link — a link scan grabbed "audio" and the download
  // failed (2026-07-14). The address bar + <link rel=canonical> / og:url carry the post's OWN
  // code with no DOM-order fragility.
  const canonical = document.querySelector('link[rel="canonical"]');
  const og = document.querySelector('meta[property="og:url"]');
  const fromPage =
    R.shortcodeFromUrl(location.pathname) ||
    (canonical && R.shortcodeFromUrl(canonical.getAttribute('href'))) ||
    (og && R.shortcodeFromUrl(og.getAttribute('content')));
  if (fromPage) return fromPage;
  // Feed / multi-post surfaces have no single canonical post — scan THIS container's links
  // (scoped to the clicked card; shortcodeFromUrl skips the audio-attribution trap).
  for (const a of container.querySelectorAll('a[href]')) {
    const code = R.shortcodeFromUrl(a.getAttribute('href'));
    if (code) return code;
  }
  return null;
}

const hasPostMedia = (container) => !!container.querySelector('video, img');

// Action bar = innermost <section> holding ≥2 aria-labelled svg icons (like/comment/share/save
// in any locale) and no comment form. The form check also rejects page-level wrapper sections.
function findActionBar(container) {
  const matches = [...container.querySelectorAll('section')].filter((s) => {
    if (s.querySelector('textarea, form')) return false;
    let labeledSvgs = 0;
    for (const svg of s.querySelectorAll('svg')) {
      let curr = svg;
      while (curr && curr !== s) {
        if (curr.hasAttribute('aria-label')) {
          labeledSvgs++;
          break;
        }
        curr = curr.parentElement;
      }
    }
    return labeledSvgs >= 2;
  });
  return matches.find((s) => !matches.some((o) => o !== s && s.contains(o))) || null;
}

function inject(container) {
  if (container.querySelector('.igfm-btn')) return; // self-healing: re-inject only if missing
  if (!hasPostMedia(container) || !findShortcode(container)) return; // not a post card

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'igfm-btn';
  btn.title = 'Download post media';
  btn.setAttribute('aria-label', 'Download post media');
  btn.innerHTML = dlSvg(24);

  const bar = findActionBar(container);
  const rail = bar ? null : findReelRail(container);
  if (bar) {
    // Append as the section's LAST child: the action-bar section IS the flex row (Like/Comment/
    // Repost/Share left, Save pushed right — live DOM 2026-07-08), so this lands right of Save.
    // Do NOT append into "the first child holding an svg" — that nests it inside the Like span.
    const wrap = document.createElement('div');
    wrap.className = 'igfm-wrap';
    wrap.appendChild(btn);
    bar.appendChild(wrap);
  } else if (rail) {
    injectIntoRail(rail, btn);
  } else {
    btn.classList.add('igfm-overlay');
    container.classList.add('igfm-anchor');
    container.appendChild(btn);
  }
}

// The fullscreen Reels viewer renders its actions as a VERTICAL rail (a <div>, not a <section>),
// so findActionBar misses it and the button never appears (reported 2026-07-14 on /reel/<code>/).
// Find the rail STRUCTURALLY — never by aria-label TEXT (gotcha #2, locale) — as the element that
// is the common grandparent of the most icon action buttons (each item is wrapper > [role=button]
// > svg[aria-label], per the live DOM). Majority-vote so a differently-nested item can't fool it.
function findReelRail(container) {
  const counts = new Map();
  for (const b of container.querySelectorAll('[role="button"]')) {
    if (!b.querySelector('svg[aria-label]')) continue;
    const railEl = b.parentElement && b.parentElement.parentElement; // button → item wrapper → rail
    if (railEl) counts.set(railEl, (counts.get(railEl) || 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [railEl, n] of counts) {
    if (n > bestN) {
      best = railEl;
      bestN = n;
    }
  }
  return bestN >= 3 ? best : null; // Like/Comment/Share/Save/More — a real action rail
}

function injectIntoRail(rail, btn) {
  // Place before the LAST icon item (the "…" more menu). The trailing audio-thumb/spacer has no
  // svg[aria-label], so it's excluded — this lands us right after Save without naming any label,
  // and is naturally immune to the Save→Remove label flip. Inherit the item's spacing from a live
  // sibling's class (the x… classes are build-hashed and rotate between IG deploys — copy, never
  // hard-code), then re-anchor fresh each scan (React swaps the whole column between reels).
  const items = [...rail.children].filter((c) => c.querySelector('svg[aria-label]'));
  const anchor = items[items.length - 1] || null; // the "…" menu, or end if none
  const wrap = document.createElement('div');
  if (anchor) wrap.className = anchor.className;
  wrap.classList.add('igfm-wrap', 'igfm-rail-item');
  wrap.appendChild(btn);
  rail.insertBefore(wrap, anchor); // before the "…" menu → right after Save
}

// Feed + modal posts render as <article> (modals contain one). Fallbacks: a post modal without
// an <article>, then a permalink page whose URL carries the shortcode. Profile grids get nothing
// by design — clicking a tile opens the modal, which gets the button.
function postContainers() {
  const found = [...document.querySelectorAll('article')];
  for (const dialog of document.querySelectorAll('div[role="dialog"]')) {
    if (!dialog.querySelector('article')) found.push(dialog);
  }
  if (!found.length) {
    const main = document.querySelector('main');
    if (main && R.shortcodeFromUrl(location.pathname)) found.push(main);
  }
  return found;
}

function visibleRect(el) {
  if (!el || !el.getBoundingClientRect) return null;
  try {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.right <= 0 || r.bottom <= 0 ||
      r.left >= innerWidth || r.top >= innerHeight) return null;
    const style = getComputedStyle(el);
    return style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 ? null : r;
  } catch { return null; }
}

function storyCardFor(media, mediaRect) {
  let node = media.parentElement, best = null, bestScore = -Infinity;
  for (let depth = 0; node && node !== document.body && depth < 18; depth++, node = node.parentElement) {
    const r = visibleRect(node);
    if (!r) continue;
    if (r.width > Math.min(innerWidth * 0.88, mediaRect.width * 1.8 + 100) ||
      r.height > innerHeight + 80) break;
    if (r.width < mediaRect.width * 0.75 || r.height < mediaRect.height * 0.8) continue;
    if (r.height < r.width * 1.1) continue; // story cards are portrait; feed posts behind them are not
    const hasReply = !!node.querySelector('textarea');
    const hasControls = !!node.querySelector('svg[aria-label]');
    const score = (hasReply ? 4 : 0) + (hasControls ? 2 : 0) +
      Math.min(1, r.width * r.height / (innerWidth * innerHeight));
    if (score >= bestScore) { best = node; bestScore = score; }
  }
  return best;
}

function activeStoryCard() {
  const candidates = [];
  for (const media of document.querySelectorAll('img, video')) {
    const mr = visibleRect(media);
    if (!mr || mr.width < 100 || mr.height < 150) continue;
    const card = storyCardFor(media, mr);
    if (!card) continue;
    const cr = visibleRect(card);
    if (!cr) continue;
    const distance = Math.hypot(
      (mr.left + mr.width / 2 - innerWidth / 2) / innerWidth,
      (mr.top + mr.height / 2 - innerHeight / 2) / innerHeight,
    );
    const area = mr.width * mr.height / (innerWidth * innerHeight);
    candidates.push({ card, media, rect: cr, score: area - distance * 2 });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function removeStoryButtons() {
  for (const btn of document.querySelectorAll('.igfm-story-btn')) removeStoryButton(btn);
}

function removeStoryButton(btn) {
  const slot = btn.parentElement && btn.parentElement.classList.contains('igfm-story-slot')
    ? btn.parentElement : null;
  const card = btn.closest('.igfm-story-anchor');
  (slot || btn).remove();
  if (card && !card.querySelector('.igfm-story-overlay')) card.classList.remove('igfm-story-anchor');
}

function lowestCommonAncestor(a, b, card) {
  for (let node = a; node && card.contains(node); node = node.parentElement) {
    if (node.contains(b)) return node;
  }
  return null;
}

function childContaining(parent, descendant) {
  if (!parent || !parent.contains(descendant) || parent === descendant) return null;
  let child = descendant;
  while (child.parentElement !== parent) child = child.parentElement;
  return child;
}

function storyBottomAnchor(active) {
  const { card, rect: cr } = active;
  const icons = [];
  for (const svg of card.querySelectorAll('svg[aria-label]')) {
    const r = visibleRect(svg);
    if (!r || r.top < cr.top + cr.height * 0.8 || r.bottom > cr.bottom + 4) continue;
    if (svg.closest('textarea, form, [contenteditable]')) continue;
    icons.push({ svg, rect: r });
  }
  icons.sort((a, b) => a.rect.left - b.rect.left);
  const like = icons[0];
  if (!like) return null;

  const share = icons.find(({ rect }) => rect.left > like.rect.left);
  let row;
  if (share) {
    row = lowestCommonAncestor(like.svg, share.svg, card);
    if (!row || row === card) return null;
  } else {
    const reply = [...card.querySelectorAll('textarea, form, [contenteditable]')]
      .map((el) => ({ el, rect: visibleRect(el) }))
      .filter(({ el, rect }) => rect && !el.contains(like.svg) &&
        rect.top <= cr.bottom + 4 && rect.bottom >= cr.top + cr.height * 0.8)
      .sort((a, b) => Number(a.el.matches('form')) - Number(b.el.matches('form')) ||
        Math.abs(a.rect.bottom - like.rect.top) - Math.abs(b.rect.bottom - like.rect.top))[0];
    if (!reply) return null;
    const bar = lowestCommonAncestor(like.svg, reply.el, card);
    row = childContaining(bar, like.svg);
  }
  if (!row || !card.contains(row)) return null;
  let likeItem = childContaining(row, like.svg);
  if (!likeItem) { likeItem = row; row = row.parentElement; }
  if (!row || !card.contains(row) || likeItem.parentElement !== row) return null;
  if (share && childContaining(row, share.svg) === likeItem) return null;
  return { row, likeItem };
}

function injectStoryButton(active) {
  const card = active && active.card;
  if (!card) { removeStoryButtons(); return; }
  const existing = [...document.querySelectorAll('.igfm-story-btn')];
  const current = existing.find((btn) => card.contains(btn));
  for (const btn of existing) if (btn !== current) removeStoryButton(btn);
  const placement = storyBottomAnchor(active);
  if (current) {
    const slot = current.parentElement && current.parentElement.classList.contains('igfm-story-slot')
      ? current.parentElement : null;
    if (placement && slot) {
      const { row, likeItem } = placement;
      if (slot.parentElement !== row || slot.previousElementSibling !== likeItem) likeItem.after(slot);
      const classes = (typeof likeItem.className === 'string' ? likeItem.className : '') +
        ' igfm-story-slot';
      if (slot.className !== classes) slot.className = classes;
      return;
    }
    if (!placement && current.classList.contains('igfm-story-overlay')) return;
    removeStoryButton(current);
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.title = 'Download story (Shift-click: all items in this story)';
  btn.setAttribute('aria-label', 'Download story');
  btn.innerHTML = dlSvg(24);
  if (placement) {
    const slot = document.createElement('div');
    slot.className = (typeof placement.likeItem.className === 'string' ? placement.likeItem.className : '') +
      ' igfm-story-slot';
    btn.className = 'igfm-btn igfm-story-btn';
    slot.appendChild(btn);
    placement.likeItem.after(slot);
  } else {
    btn.className = 'igfm-btn igfm-story-btn igfm-story-overlay';
    card.classList.add('igfm-story-anchor');
    card.appendChild(btn);
  }
}

function storyProgress(card, cardRect) {
  let best = null;
  for (const row of card.querySelectorAll('*')) {
    const children = [...row.children];
    if (children.length < 2 || children.length > 100 ||
      !children.every((child) => child.tagName === children[0].tagName)) continue;
    const rects = children.map((child) => visibleRect(child));
    if (!rects.every((r) => r && r.width >= 5 && r.height > 0 && r.height <= 4)) continue;
    if (rects[0].top < cardRect.top - 2 || rects[0].top > cardRect.top + cardRect.height * 0.2) continue;
    if (!rects.every((r, i) => Math.abs(r.top - rects[0].top) <= 5 &&
      (!i || r.left >= rects[i - 1].right - 3))) continue;
    const filled = children.flatMap((child, i) => child.firstElementChild ? [i] : []);
    if (filled.length !== 1) continue;
    const score = children.length * 10 + rects.reduce((sum, r) => sum + r.width, 0) / 100;
    if (!best || score > best.score) best = { count: children.length, index: filled[0], score };
  }
  return best ? { count: best.count, index: best.index } : null;
}

function imageBasename(url) {
  if (!url || !/^https?:/i.test(url)) return null;
  try { return new URL(url).pathname.split('/').pop() || null; } catch { return null; }
}

function storySignals(active) {
  const images = [...active.card.querySelectorAll('img')].map((img) => ({ img, rect: visibleRect(img) }))
    .filter(({ rect: r }) => r && r.width >= 100 && r.height >= 150);
  images.sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
  const image = images[0] && images[0].img;
  return { imageBasename: image ? imageBasename(image.currentSrc || image.src) : null,
    progress: storyProgress(active.card, active.rect) };
}

function overlapArea(a, b) {
  if (!a || !b) return 0;
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

function carouselViewport(list, container) {
  let node = list.parentElement;
  while (node && node !== container) {
    try {
      const style = getComputedStyle(node);
      if (/hidden|clip|scroll/.test(style.overflowX) || /hidden|clip|scroll/.test(style.overflowY))
        return visibleRect(node);
    } catch { return null; }
    node = node.parentElement;
  }
  return visibleRect(list.parentElement) || visibleRect(container);
}

function carouselTranslateIndex(li, width) {
  const transform = li && li.style && li.style.transform || '';
  const match = transform.match(/translateX\(\s*([-\d.]+)px\s*\)/) ||
    transform.match(/translate3d\(\s*([-\d.]+)px\s*,/);
  if (!match || !width) return null;
  const index = Math.round(Number(match[1]) / width);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function carouselSignals(container) {
  const media = [...container.querySelectorAll('img, video')].map((el) => ({ el, rect: visibleRect(el) }))
    .filter(({ rect: r }) => r && r.width >= 120 && r.height >= 120);
  media.sort((a, b) => {
    const distance = (r) => Math.hypot(
      (r.left + r.width / 2 - innerWidth / 2) / innerWidth,
      (r.top + r.height / 2 - innerHeight / 2) / innerHeight,
    );
    return distance(a.rect) - distance(b.rect);
  });
  const centre = media[0];
  if (!centre) return { imageBasename: null, translateIndex: null };
  const centreBasename = centre.el.tagName === 'VIDEO' ? imageBasename(centre.el.poster) :
    imageBasename(centre.el.currentSrc || centre.el.src);
  const lists = [...container.querySelectorAll('ul')].map((list) => {
    const viewport = carouselViewport(list, container);
    if (!viewport) return null;
    const slides = [...list.children].filter((li) => li.tagName === 'LI' &&
      li.querySelector('img, video') && li.getBoundingClientRect().width >= viewport.width / 2);
    if (slides.length < 2) return null;
    const score = overlapArea(viewport, centre.rect) + (list.contains(centre.el) ? 1000000 : 0);
    if (score <= 0) return null;
    return { list, viewport, slides, score };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
  const chosen = lists[0];
  if (!chosen) return { imageBasename: centreBasename, translateIndex: null };
  const visibleSlide = chosen.slides.map((li) => ({ li, rect: visibleRect(li) }))
    .sort((a, b) => overlapArea(b.rect, chosen.viewport) - overlapArea(a.rect, chosen.viewport))[0];
  if (!visibleSlide || !overlapArea(visibleSlide.rect, chosen.viewport))
    return { imageBasename: centreBasename, translateIndex: null };
  const video = visibleSlide.li.querySelector('video');
  const images = [...visibleSlide.li.querySelectorAll('img')].map((img) => ({ img, rect: visibleRect(img) }))
    .filter(({ rect }) => rect).sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
  const src = video && video.poster || images[0] && (images[0].img.currentSrc || images[0].img.src);
  return { imageBasename: imageBasename(src) || centreBasename,
    translateIndex: carouselTranslateIndex(visibleSlide.li, visibleSlide.rect.width) };
}

function scan() {
  const route = R.storyRouteFromPath(location.pathname);
  if (route) {
    try { injectStoryButton(activeStoryCard()); }
    catch (e) { console.warn('[IGFM] story button injection failed:', e); }
  }
  else {
    removeStoryButtons();
    for (const c of postContainers()) inject(c);
  }
  try {
    injectProfileButton(); // v2: adds/removes the fixed profile-capture control on SPA nav
  } catch (e) {
    console.warn('[IGFM] profile button injection failed:', e);
  }
}

function toast(text, kind = '') {
  let el = document.getElementById('igfm-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'igfm-toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.className = 'igfm-toast' + (kind ? ' igfm-toast-' + kind : '') + ' igfm-show';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('igfm-show'), 4500);
}

// Ask the MAIN-world inject.js to pull this post's media object out of the page — its
// network-response cache first (feed/modal GraphQL carries the full carousel), then embedded
// JSON blobs, then React fiber props. Details are JSON STRINGS both ways (object details don't
// reliably cross Chrome's isolated/MAIN world boundary); the container is handed over via a
// data-igfm-req attribute because the DOM is shared across worlds even though JS objects are
// not. The raw media object comes back as plain JSON and is normalized HERE (inject.js has no
// resolver).
function fetchMediaFromReact(container, shortcode) {
  return new Promise((resolve) => {
    const reqId = 'igfm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    let done = false;
    const finish = (media) => {
      if (done) return;
      done = true;
      document.removeEventListener('igfm-response-react', onResponse);
      clearTimeout(timer);
      try {
        container.removeAttribute('data-igfm-req');
      } catch {
        // container may be `document` or already gone
      }
      resolve(media);
    };
    const onResponse = (e) => {
      let d = e && e.detail;
      if (typeof d === 'string') {
        try {
          d = JSON.parse(d);
        } catch {
          d = null;
        }
      }
      if (!d || d.reqId !== reqId) return;
      // stats logged as a JSON string so console-scraping tools capture them fully
      if (d.error) console.warn('[IGFM] page extraction error:', d.error, JSON.stringify(d.stats || {}));
      else console.log('[IGFM] page extraction:', d.via || 'no-hit', JSON.stringify(d.stats || {}));
      if (!d.media) return finish(null);
      let media = null;
      try {
        media = R.normalizeShortcodeMedia(d.media) || R.normalizeApiV1Item(d.media);
      } catch (err) {
        console.warn('[IGFM] page media normalization failed:', err);
      }
      if (media) {
        const via = d.via || '';
        media.source = via === 'network_cache' || via === 'embedded_json' ? via : 'react_fiber';
        if (!media.shortcode) media.shortcode = shortcode || null;
      }
      finish(media);
    };
    document.addEventListener('igfm-response-react', onResponse);
    const timer = setTimeout(() => finish(null), 1600);
    try {
      container.setAttribute('data-igfm-req', reqId);
    } catch {
      // non-element container — inject.js will fall back to a shortcode search
    }
    document.dispatchEvent(
      new CustomEvent('igfm-request-react', {
        detail: JSON.stringify({ reqId, shortcode: shortcode || null }),
      }),
    );
  });
}

function fetchStoryReelFromPage(route) {
  return new Promise((resolve) => {
    const reqId = 'igfms' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      document.removeEventListener('igfm-response-story', onResponse);
      clearTimeout(timer);
      resolve(result);
    };
    const onResponse = (e) => {
      let detail = e && e.detail;
      if (typeof detail === 'string') {
        try { detail = JSON.parse(detail); } catch { detail = null; }
      }
      if (!detail || detail.reqId !== reqId) return;
      if (detail.error) console.warn('[IGFM] story lookup error:', detail.error);
      finish({ reel: detail.reel || null, diag: detail.diag || null });
    };
    document.addEventListener('igfm-response-story', onResponse);
    const timer = setTimeout(() => finish({ reel: null, diag: null }), 1600);
    document.dispatchEvent(new CustomEvent('igfm-request-story', {
      detail: JSON.stringify({ reqId, route }),
    }));
  });
}

async function runStoryDownload(btn, all) {
  if (btn.dataset.busy) return;
  const route = R.storyRouteFromPath(location.pathname);
  let active = null;
  try { active = activeStoryCard(); } catch (e) { console.warn('[IGFM] story card lookup failed:', e); }
  if (!route || !active || !active.card.contains(btn)) {
    toast('Story viewer not ready', 'err');
    return;
  }
  let signals = { imageBasename: null, progress: null };
  try { signals = storySignals(active); } catch (e) { console.warn('[IGFM] story signal lookup failed:', e); }
  btn.dataset.busy = '1';
  btn.classList.add('igfm-loading');
  toast('Resolving story media…');
  const warnPickFailure = (reel, diag, items) => {
    const normalizedNullPks = items && reel && Array.isArray(reel.items) ? reel.items.flatMap((raw, index) => {
      if (items[index]) return [];
      const pk = raw && (raw.pk != null ? raw.pk : raw.id && String(raw.id).split('_')[0]);
      return pk == null ? [] : [String(pk)];
    }) : [];
    console.warn('[IGFM] story pick failed', { route, diag,
      signals: { progressCount: signals.progress ? signals.progress.count : null,
        progressIndex: signals.progress ? signals.progress.index : null,
        imageBasename: signals.imageBasename }, normalizedNullPks });
  };
  try {
    const { reel, diag } = await fetchStoryReelFromPage(route);
    if (!reel || !Array.isArray(reel.items) || reel.kind !== route.kind ||
      (route.kind === 'story' && String(reel.owner || '').toLowerCase() !== route.username.toLowerCase()) ||
      (route.kind === 'highlight' && reel.id !== 'highlight:' + route.highlightId)) {
      warnPickFailure(reel, diag, null);
      toast(route.kind === 'story' && route.pk ? "This story item wasn't captured — reload the tab" :
        'Story data not captured yet — reload the tab', 'err');
      return;
    }
    const items = reel.items.map((raw) => {
      const item = R.normalizeStoryItem(raw);
      return item && item.username && item.username.toLowerCase() === String(reel.owner).toLowerCase()
        ? item : null;
    });
    let chosen;
    if (all) chosen = items.filter(Boolean);
    else {
      const index = R.pickStoryItem(route, reel, items, signals);
      if (index === null) {
        warnPickFailure(reel, diag, items);
        const pkInReel = route.pk && (diag && diag.pkInReel != null ? diag.pkInReel :
          reel.items.some((raw) => String(raw.pk || String(raw.id || '').split('_')[0]) === route.pk));
        toast(route.kind === 'highlight'
          ? "Couldn't tell which item is on screen — Shift-click saves the whole highlight"
          : route.pk
            ? pkInReel
              ? "This story's video isn't loaded yet — try again in a moment"
              : "This story item wasn't captured — reload the tab"
            : "Couldn't tell which item is on screen — Shift-click saves the whole story", 'err');
        return;
      }
      chosen = [items[index]];
    }
    const plan = R.planStoryDownloads(chosen, route.kind);
    if (!plan.length) throw new Error('no downloadable story media in this reel');
    const res = await sendPlan(plan);
    btn.classList.add('igfm-done');
    const failed = res.failed ? ` (${res.failed} failed)` : '';
    toast(all ? `Saved ${res.saved} of ${reel.items.length}${failed}` : `Saved ${res.saved} story${failed}`, 'ok');
    setTimeout(() => btn.classList.remove('igfm-done'), 2500);
  } catch (e) {
    console.error('[IGFM] story download error:', e);
    btn.classList.add('igfm-error');
    toast('Story capture failed: ' + ((e && e.message) || e), 'err');
    setTimeout(() => btn.classList.remove('igfm-error'), 4500);
  } finally {
    delete btn.dataset.busy;
    btn.classList.remove('igfm-loading');
  }
}

async function runDownload(btn, all) {
  if (btn.dataset.busy) return;
  // Resolve at CLICK time from the button's current container — on SPA navigation a permalink
  // <main> persists across posts, so anything captured at inject time can go stale.
  const container = btn.closest('article, div[role="dialog"], main') || document;
  // May be null: some sponsored posts carry no /p/ permalink — the fiber path still works
  // (it matches by container, and the found media object brings its own code).
  const shortcode = findShortcode(container);
  // single-string log (not multi-arg) so console-scraping tools capture the shortcode reliably
  console.log(`[IGFM] button clicked — shortcode=${shortcode || '(none — sponsored post?)'}`);
  btn.dataset.busy = '1';
  btn.classList.add('igfm-loading');
  toast('Resolving post media…');
  try {
    let media = null;
    let notice = '';

    // First attempt: resolve inside the page (network-response cache → embedded JSON → React
    // fibers). Instant, no extra requests; the only path that works for sponsored posts and
    // deferred feed carousels — /p/<code>/ embeds are cover-only for those.
    try {
      media = await fetchMediaFromReact(container, shortcode);
    } catch (e) {
      console.warn('[IGFM] React Fiber extraction failed:', e);
    }

    // Second attempt: the API escalation chain (post HTML → /api/v1/media/<pk>/info/ →
    // GraphQL). Runs when there's no in-page hit OR the hit still needs completing — a partial
    // carousel, OR a lone image from an untrusted source that could be a masked ad-carousel
    // cover (cold permalink embeds lie: media_type 1 + null count on a real 8-slide carousel).
    // The in-page result seeds the chain — it contributes the pk and stays as the floor.
    if (shortcode && (!media || R.needsCompletion(media))) {
      try {
        const fetched = await R.fetchMediaByShortcode(shortcode, media || null);
        if (fetched) media = fetched;
      } catch (e) {
        console.warn('[IGFM] API resolution failed:', (e && e.message) || e);
      }
    }

    // Last resort: harvest rendered images from the clicked container.
    if (!media) {
      media = R.mediaFromDom(container, shortcode);
      if (media) notice = ' — DOM fallback, images only';
    }

    if (!media) throw new Error('no downloadable media found');
    if (R.isPartialCarousel(media)) {
      const total = media.expectedCount > media.items.length ? media.expectedCount : '?';
      notice = ` — ${media.items.length} of ${total} slides (Instagram withheld the rest)`;
    }
    let index = null;
    let carouselFallback = null;
    if (media.items.length > 1 && !all) {
      let signals = { imageBasename: null, translateIndex: null };
      try { signals = carouselSignals(container); } catch (e) { console.warn('[IGFM] carousel signal lookup failed:', e); }
      index = R.pickCarouselIndex(media.items, signals);
      if (index === null) carouselFallback = `Couldn't tell which slide is on screen — saved all ${media.items.length}`;
    }
    const items = R.planDownloads(media, index === null ? undefined : { index });
    console.log(`[IGFM] media resolved via ${media.source}:`, items);
    const res = await chrome.runtime.sendMessage({ type: 'igfm-download', items });
    console.log('[IGFM] background response:', res);
    if (!res || !res.ok) throw new Error((res && res.error) || 'no response from background (service worker alive?)');
    const skipped = res.failed ? ` (${res.failed} failed)` : '';
    btn.classList.add('igfm-done');
    toast(carouselFallback ? `${carouselFallback}${skipped}${notice}` :
      `Saved ${res.saved} file${res.saved === 1 ? '' : 's'} → Downloads/${R.CAPTURE_FOLDER}/${skipped}${notice}`, 'ok');
    setTimeout(() => btn.classList.remove('igfm-done'), 2500);
  } catch (e) {
    console.error('[IGFM] capture error:', e);
    btn.classList.add('igfm-error');
    toast('Capture failed: ' + ((e && e.message) || e), 'err');
    setTimeout(() => btn.classList.remove('igfm-error'), 4500);
  } finally {
    delete btn.dataset.busy;
    btn.classList.remove('igfm-loading');
  }
}

// ---- v2: whole-profile crawl ------------------------------------------------

// The profile button is FIXED-POSITION, not injected into Instagram's header. The header is
// another bespoke surface whose structure would need its own archaeology (findActionBar missed
// the Reels rail entirely — gotcha #16 — and cost a round of live debugging). A fixed control
// has no DOM heuristic to drift, and it reads as OUR tool rather than as Instagram chrome.
function injectProfileButton() {
  const C = globalThis.IGFM_CRAWLER;
  const onProfile = !!C.profileHandleFromPath(location.pathname);
  const existing = document.querySelector('.igfm-profile-btn');
  if (!onProfile) {
    if (existing) existing.remove(); // SPA nav away from a profile
    return;
  }
  if (existing) return;
  const btn = document.createElement('button');
  btn.className = 'igfm-profile-btn';
  btn.type = 'button';
  btn.title = 'Capture this profile into Downloads/instagram-captures/<handle>/ (shift-click: every carousel slide)';
  btn.innerHTML = `${dlSvg(16)}<span>Capture profile</span>`;
  document.body.appendChild(btn);
}

// Asks inject.js for the profile payload the PAGE already fetched (bio, link, counts) AND its
// story-highlights tray. Makes no network request — inject.js answers from its tap cache, keyed by
// exact username. Returns { profile, highlights } (each null when the page never fetched it), and
// the crawl then simply records nulls.
function fetchProfileFromPage(handle) {
  return new Promise((resolve) => {
    const reqId = 'igfmp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    let done = false;
    const finish = (p) => {
      if (done) return;
      done = true;
      document.removeEventListener('igfm-response-profile', onResponse);
      clearTimeout(timer);
      resolve(p);
    };
    const onResponse = (e) => {
      let d = e && e.detail;
      if (typeof d === 'string') {
        try {
          d = JSON.parse(d);
        } catch {
          d = null;
        }
      }
      if (!d || d.reqId !== reqId) return;
      console.log(`[IGFM] profile payload: ${d.profile ? 'hit' : 'miss'} · highlights: ${Array.isArray(d.highlights) ? d.highlights.length : 0} (${d.cached || 0} cached)`);
      finish({ profile: d.profile || null, highlights: Array.isArray(d.highlights) ? d.highlights : null });
    };
    document.addEventListener('igfm-response-profile', onResponse);
    const timer = setTimeout(() => finish({ profile: null, highlights: null }), 1600);
    document.dispatchEvent(
      new CustomEvent('igfm-request-profile', { detail: JSON.stringify({ reqId, handle }) }),
    );
  });
}

async function sendPlan(items) {
  if (!items.length) return { ok: true, saved: 0, failed: 0 };
  const res = await chrome.runtime.sendMessage({ type: 'igfm-download', items });
  if (!res || !res.ok) throw new Error((res && res.error) || 'no response from background');
  return res;
}

async function runProfileCrawl(btn, full) {
  if (btn.dataset.busy) return;
  const C = globalThis.IGFM_CRAWLER;
  const handle = C.profileHandleFromPath(location.pathname);
  if (!handle) return toast('Not a profile page', 'err');

  btn.dataset.busy = '1';
  btn.classList.add('igfm-loading');
  const limit = C.DEFAULT_LIMIT;
  const date = new Date().toISOString().slice(0, 10); // one dated folder per capture
  console.log(`[IGFM] profile crawl start — handle=${handle} date=${date} limit=${limit} mode=${full ? 'full' : 'covers'}`);
  try {
    // 1. Scroll the grid. This both reveals the links we read ORDER from and makes the PAGE issue
    //    its own pagination requests, which inject.js's tap caches — so resolution below is free.
    toast(`Reading @${handle}'s grid…`);
    const all = await C.scrollUntil(limit, (n, t) => toast(`Reading grid… ${n}/${t}`));
    const codes = all.slice(0, limit);
    if (!codes.length) throw new Error('no posts found on this grid');

    // The profile payload + highlights tray the page fetched for itself. Zero extra requests.
    const page = await fetchProfileFromPage(handle);
    const rawProfile = page.profile;
    const rawHighlights = page.highlights;

    const entries = [];
    const skipped = [];
    let saved = 0;
    let profile = null;

    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      // The tap already holds this post (probe 2026-07-17: 27/27 grid posts cached, carousels
      // complete). fetchMediaFromReact hits mediaCache first and returns without a request; the
      // hardened escalation chain only runs if this specific post was somehow missed.
      let media = null;
      try {
        media = await fetchMediaFromReact(document, code);
      } catch (e) {
        console.warn('[IGFM] in-page lookup failed for', code, e);
      }
      if (!media || R.needsCompletion(media)) {
        try {
          const fetched = await R.fetchMediaByShortcode(code, media || null);
          if (fetched) media = fetched;
        } catch (e) {
          console.warn('[IGFM] escalation failed for', code, (e && e.message) || e);
        }
      }
      if (!media || !media.items.length) {
        skipped.push({ shortcode: code, reason: 'unresolved' });
        toast(`${i + 1}/${codes.length} — skipped ${code}`);
        continue;
      }
      if (!media.shortcode) media.shortcode = code;
      if (!profile) profile = C.profileFromMedia(media.user, rawProfile);

      const plan = C.intoHandleFolder(C.planPost(media, { full }), handle, date);
      const res = await sendPlan(plan);
      saved += res.saved || 0;
      entries.push(C.captureEntry(media, plan));
      toast(`Captured ${i + 1} of ${codes.length}…`);

      // Randomized 5–10s. Paces the media downloads AND the page's own pagination traffic.
      if (i < codes.length - 1) await C.sleep(C.nextDelayMs());
    }

    // The payload alone still yields a header even if every post somehow failed to resolve.
    if (!profile) profile = C.profileFromMedia(null, rawProfile);

    // 2. Avatar (one image, no delay — a single CDN file).
    if (profile && profile.avatar_url) {
      try {
        const aplan = C.planAvatar(profile.avatar_url, handle, date);
        await sendPlan(aplan);
        profile.avatar_file = aplan[0].filename.split('/').pop();
        saved += 1;
      } catch (e) {
        console.warn('[IGFM] avatar download failed:', e);
      }
    }

    // 2b. Highlight covers — downloaded like the avatar (one CDN image each, no delay), capped at
    //     the template's 8 rings, tray order. Attaches profile.highlights = [{title, cover_file}] so
    //     placement FILLS the ring row; absent/empty → placement deletes the row (the old default).
    if (profile) {
      const hs = C.normalizeHighlights(rawHighlights);
      if (hs.length) {
        try {
          const hplan = C.planHighlights(hs, handle, date);
          await sendPlan(hplan);
          profile.highlights = C.highlightEntries(hs, hplan);
          saved += hplan.length;
          console.log(`[IGFM] highlights: ${hplan.length} covers saved`);
        } catch (e) {
          console.warn('[IGFM] highlights download failed:', e);
        }
      }
    }

    // 3. capture.json — the placement engine's contract. `posts` is in FEED ORDER (grid order),
    //    which buildManifest({feedOrder}) trusts over its pk fallback. Overwrites so a re-capture
    //    can't leave a stale 'capture (1).json' the CLI would ignore.
    const capture = C.buildCaptureJson({ handle, date, full, limit, profile, entries, skipped });
    await sendPlan([{
      url: 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(capture, null, 2)),
      filename: `${R.CAPTURE_FOLDER}/${handle}/${date}/capture.json`,
      conflictAction: 'overwrite',
    }]);

    btn.classList.add('igfm-done');
    const miss = skipped.length ? ` (${skipped.length} skipped)` : '';
    toast(`Captured ${entries.length} posts → Downloads/${R.CAPTURE_FOLDER}/${handle}/${date}/${miss}`, 'ok');
    console.log('[IGFM] profile crawl done:', JSON.stringify({ handle, posts: entries.length, saved, skipped: skipped.length }));
    setTimeout(() => btn.classList.remove('igfm-done'), 3000);
  } catch (e) {
    console.error('[IGFM] profile crawl error:', e);
    btn.classList.add('igfm-error');
    toast('Profile capture failed: ' + ((e && e.message) || e), 'err');
    setTimeout(() => btn.classList.remove('igfm-error'), 4500);
  } finally {
    delete btn.dataset.busy;
    btn.classList.remove('igfm-loading');
  }
}

// One delegated, capture-phase handler — robust to React re-renders and IG's own click handlers.
document.addEventListener(
  'click',
  (e) => {
    const profileBtn = e.target.closest?.('.igfm-profile-btn');
    if (profileBtn) {
      e.preventDefault();
      e.stopPropagation();
      runProfileCrawl(profileBtn, e.shiftKey); // shift = every carousel slide, not just covers
      return;
    }
    const btn = e.target.closest?.('.igfm-btn');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    if (btn.classList.contains('igfm-story-btn')) runStoryDownload(btn, e.shiftKey);
    else runDownload(btn, e.shiftKey);
  },
  true,
);

const debounce = (fn, ms) => {
  let t;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
};
new MutationObserver(debounce(scan, 300)).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
scan();
console.log('[IGFM] content script initialized (delegated click + observer active)');
