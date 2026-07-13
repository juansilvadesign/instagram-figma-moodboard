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
  for (const a of container.querySelectorAll('a[href]')) {
    const code = R.shortcodeFromUrl(a.getAttribute('href'));
    if (code) return code;
  }
  // permalink pages and open post modals carry the shortcode in the address bar
  return R.shortcodeFromUrl(location.pathname);
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
  if (bar) {
    // Append as the section's LAST child: the action-bar section IS the flex row (Like/Comment/
    // Repost/Share left, Save pushed right — live DOM 2026-07-08), so this lands right of Save.
    // Do NOT append into "the first child holding an svg" — that nests it inside the Like span.
    const wrap = document.createElement('div');
    wrap.className = 'igfm-wrap';
    wrap.appendChild(btn);
    bar.appendChild(wrap);
  } else {
    btn.classList.add('igfm-overlay');
    container.classList.add('igfm-anchor');
    container.appendChild(btn);
  }
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

function scan() {
  for (const c of postContainers()) inject(c);
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

// Ask the MAIN-world inject.js to pull this post's media object out of React fiber memory.
// Details are JSON STRINGS both ways (object details don't reliably cross Chrome's isolated/
// MAIN world boundary); the container is handed over via a data-igfm-req attribute because the
// DOM is shared across worlds even though JS objects are not. The raw media object comes back
// as plain JSON and is normalized HERE (inject.js has no resolver).
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
      if (d.error) console.warn('[IGFM] fiber extraction reported:', d.error, d.stats || '');
      else console.log('[IGFM] fiber extraction stats:', d.via || '', d.stats || '');
      if (!d.media) return finish(null);
      let media = null;
      try {
        media = R.normalizeShortcodeMedia(d.media) || R.normalizeApiV1Item(d.media);
      } catch (err) {
        console.warn('[IGFM] fiber media normalization failed:', err);
      }
      if (media) {
        media.source = 'react_fiber';
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

async function runDownload(btn) {
  if (btn.dataset.busy) return;
  // Resolve at CLICK time from the button's current container — on SPA navigation a permalink
  // <main> persists across posts, so anything captured at inject time can go stale.
  const container = btn.closest('article, div[role="dialog"], main') || document;
  // May be null: some sponsored posts carry no /p/ permalink — the fiber path still works
  // (it matches by container, and the found media object brings its own code).
  const shortcode = findShortcode(container);
  console.log('[IGFM] button clicked — shortcode', shortcode || '(none — sponsored post?)');
  btn.dataset.busy = '1';
  btn.classList.add('igfm-loading');
  toast('Resolving post media…');
  try {
    let media = null;
    let notice = '';

    // First attempt: extract directly from React fiber memory (instant, no network; the only
    // path that works for sponsored/ad posts and private-account carousels).
    try {
      media = await fetchMediaFromReact(container, shortcode);
    } catch (e) {
      console.warn('[IGFM] React Fiber extraction failed:', e);
    }

    // Second attempt: fetch from the Instagram API/HTML (needs a shortcode).
    if (!media && shortcode) {
      try {
        media = await R.fetchMediaByShortcode(shortcode);
      } catch (e) {
        console.warn('[IGFM] API resolution failed, trying DOM fallback:', (e && e.message) || e);
      }
    }

    // Last resort: harvest rendered images from the clicked container.
    if (!media) {
      media = R.mediaFromDom(container, shortcode);
      if (media) notice = ' — DOM fallback, images only';
    }

    if (!media) throw new Error('no downloadable media found');
    const items = R.planDownloads(media);
    console.log(`[IGFM] media resolved via ${media.source}:`, items);
    const res = await chrome.runtime.sendMessage({ type: 'igfm-download', items });
    console.log('[IGFM] background response:', res);
    if (!res || !res.ok) throw new Error((res && res.error) || 'no response from background (service worker alive?)');
    const skipped = res.failed ? ` (${res.failed} failed)` : '';
    btn.classList.add('igfm-done');
    toast(`Saved ${res.saved} file${res.saved === 1 ? '' : 's'} → Downloads/${R.CAPTURE_FOLDER}/${skipped}${notice}`, 'ok');
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

// One delegated, capture-phase handler — robust to React re-renders and IG's own click handlers.
document.addEventListener(
  'click',
  (e) => {
    const btn = e.target.closest?.('.igfm-btn');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    runDownload(btn);
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
