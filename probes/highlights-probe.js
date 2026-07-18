/* IGFM — HIGHLIGHTS PROBE (zero requests, throwaway diagnostic)
 *
 * Answers, in order (gotcha #25: prove the data REACHES the tap before touching any matcher):
 *   1. Does the page fetch the highlights tray at all, and from WHICH url?
 *   2. Would TAP_URL_RE match that url?  (if no -> that's the whole bug, same as #25)
 *   3. Would looksLikeMedia / looksLikeProfile claim a tray item? (expected NO -> needs its own
 *      collector, same fix shape as #24)
 *   4. What is a tray item's real SHAPE — title, cover url, id?
 *   5. Is the cover a direct CDN url (placeable like a post cover)?
 *   6. Does the payload identify its OWNER? (#18/#22/#26 — the page carries other people's stuff;
 *      no owner key = we cannot safely tell solarity's highlights from a suggested user's)
 *
 * NOT a shipped patch. inject.js already taps at document_start and must stay the ONLY tap
 * (memory: don't add a second fetch/XHR patch). This is a temporary console recorder that exists
 * because the question is precisely "what does the tap THROW AWAY" — which the caches, by
 * construction, cannot answer.
 *
 * HOW TO RUN
 *   1. Open instagram.com — the HOME feed, NOT the target profile. (The recorder must be installed
 *      before the profile route fires its fetches; IG is an SPA, so navigating in-tab is what
 *      catches them. Same reason a tab reload is required after an extension reload — gotcha #13.)
 *   2. Paste this whole file into the DevTools console. It prints "[HL] recorder armed".
 *   3. CLICK through to the target profile (e.g. @solarity.studio) in that SAME tab. Do not reload.
 *   4. Let the highlights tray render. Optionally click one open (that may fire a 2nd endpoint —
 *      the probe will show whether it's separate).
 *   5. Run:  IGFM_HL.report()
 *   6. Paste the whole report back.
 */
(() => {
  const seen = [];                    // { url, bytes, hit }
  const HL_TOKEN = /highlight/i;      // deliberately broad — do NOT assume the tray's endpoint

  // Same defensive parse as the real tap: @defer streams arrive newline-chunked, so a whole-body
  // JSON.parse silently loses the deferred halves (gotcha #13). Parse per line, keep what parses.
  function parseChunks(text) {
    const out = [];
    for (const line of String(text).split('\n')) {
      const s = line.trim();
      if (!s || (s[0] !== '{' && s[0] !== '[')) continue;
      try { out.push(JSON.parse(s)); } catch { /* not a chunk */ }
    }
    if (!out.length) { try { out.push(JSON.parse(text)); } catch { /* not json */ } }
    return out;
  }

  function record(url, text) {
    try {
      const hit = HL_TOKEN.test(text);
      seen.push({ url: String(url), bytes: text.length, hit, text: hit ? text : null });
    } catch { /* never break the page */ }
  }

  // --- the temporary tap (fetch + XHR), mirroring inject.js's try/caught discipline ----------
  const of = window.fetch;
  window.fetch = function (...a) {
    return of.apply(this, a).then((r) => {
      try {
        const u = (a[0] && a[0].url) || a[0];
        r.clone().text().then((t) => record(u, t)).catch(() => {});
      } catch { /* ignore */ }
      return r;
    });
  };
  const oo = XMLHttpRequest.prototype.open;
  const os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__u = u; return oo.call(this, m, u, ...r); };
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener('load', () => {
      try { record(this.__u, this.responseText || ''); } catch { /* ignore */ }
    });
    return os.apply(this, a);
  };

  // --- shape discovery: find highlight-ish objects WITHOUT assuming one schema ---------------
  // Three independent tells, so a schema change can't blind all of them at once.
  function findHighlights(root) {
    const found = [];
    const stack = [{ v: root, path: '$' }];
    const visited = new Set();
    let budget = 200000;
    while (stack.length && --budget > 0) {
      const { v, path } = stack.pop();
      if (!v || typeof v !== 'object' || visited.has(v)) continue;
      visited.add(v);
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) stack.push({ v: v[i], path: `${path}[${i}]` });
        continue;
      }
      let keys; try { keys = Object.keys(v); } catch { continue; }
      const idIsHl = typeof v.id === 'string' && /^highlight:/.test(v.id);
      const hasCover = v.cover_media !== undefined || v.cover_cropped_image !== undefined;
      const titled = typeof v.title === 'string';
      if (idIsHl || (hasCover && titled)) found.push({ path, obj: v, keys });
      for (const k of keys) {
        let val; try { val = v[k]; } catch { continue; }
        if (val && typeof val === 'object') stack.push({ v: val, path: `${path}.${k}` });
        if (HL_TOKEN.test(k) && val && typeof val === 'object') {
          found.push({ path: `${path}.${k}`, obj: val, keys: Object.keys(val), viaKeyName: true });
        }
      }
    }
    return found;
  }

  const firstUrl = (o, d = 0) => {           // hunt the cover's real CDN url, shape-agnostically
    if (!o || typeof o !== 'object' || d > 6) return null;
    if (typeof o.url === 'string' && /^https?:/.test(o.url)) return o.url;
    for (const k of Object.keys(o)) { const r = firstUrl(o[k], d + 1); if (r) return r; }
    return null;
  };

  window.IGFM_HL = {
    _seen: seen,
    report() {
      const inj = window.IGFM_INJECT;
      const TAP = inj && inj.TAP_URL_RE;
      console.log('%c=== IGFM HIGHLIGHTS PROBE ===', 'font-weight:bold');
      console.log(`responses recorded: ${seen.length} · containing /highlight/i: ${seen.filter((s) => s.hit).length}`);
      console.log(`IGFM_INJECT present: ${!!inj}  (needed for the matcher/predicate checks)`);
      if (!inj) console.warn('inject.js not found — is the extension loaded AND the tab reloaded since?');

      // Q1+Q2 — the endpoint list, and whether the SHIPPED matcher would even be fed. (#25)
      console.log('\n--- endpoints carrying highlight data ---');
      const hits = seen.filter((s) => s.hit);
      if (!hits.length) console.warn('NONE. The tray never arrived over fetch/XHR in this session — it may be SSR-embedded, or lazy until clicked. Try clicking a highlight open, then re-run.');
      const byUrl = {};
      for (const s of hits) {
        const bare = s.url.split('?')[0];
        byUrl[bare] = byUrl[bare] || { n: 0, tapped: TAP ? TAP.test(s.url) : null };
        byUrl[bare].n++;
      }
      for (const [u, v] of Object.entries(byUrl)) {
        console.log(`  ${v.tapped === false ? '❌ NOT tapped' : v.tapped === true ? '✅ tapped' : '?'}  ${u}  (${v.n}x)`);
      }
      if (Object.values(byUrl).some((v) => v.tapped === false)) {
        console.warn('  ^ at least one endpoint is INVISIBLE to TAP_URL_RE — that is the #25 bug again: fix the endpoint list, not the matcher.');
      }

      // Q3..Q6 — the shape, and whether the existing collectors would claim it.
      console.log('\n--- tray item shape ---');
      let sample = null, owner = null;
      for (const s of hits) {
        for (const p of parseChunks(s.text)) {
          const f = findHighlights(p);
          if (f.length) {
            console.log(`  ${f.length} highlight-ish object(s) in ${s.url.split('?')[0]}`);
            console.log('  paths:', f.slice(0, 8).map((x) => x.path));
            sample = sample || f[0];
            for (const cand of f) {                       // #22/#26: can we key these by OWNER?
              const u = cand.obj && (cand.obj.user || cand.obj.owner);
              if (u && u.username) { owner = u.username; break; }
            }
          }
        }
        if (sample) break;
      }
      if (!sample) {
        console.warn('  no highlight-shaped object found. Paste IGFM_HL._seen and inspect by hand.');
        return;
      }
      console.log('  KEYS:', sample.keys);
      console.log('  title:', sample.obj.title, '| id:', sample.obj.id, '| media_count:', sample.obj.media_count);
      const cover = firstUrl(sample.obj.cover_media || sample.obj);
      console.log('  cover url:', cover ? cover.slice(0, 110) + '…' : 'NOT FOUND');
      console.log('  cover is direct CDN (placeable like a post cover):', !!cover && /cdninstagram|fbcdn/.test(cover));
      console.log('  OWNER identifiable on the object:', owner || 'NO — ⚠️ see #22/#26: without an owner key we cannot tell the target profile\'s highlights from a suggested user\'s. A wrong value is worse than an empty one.');

      // The load-bearing question: is this a collector gap (#24 shape) or a matcher gap (#25 shape)?
      console.log('\n--- would the SHIPPED collectors keep it? ---');
      if (inj) {
        const m = inj.looksLikeMedia ? (() => { try { return inj.looksLikeMedia(sample.obj, null); } catch (e) { return 'threw: ' + e.message; } })() : 'n/a';
        const p = inj.looksLikeProfile ? (() => { try { return inj.looksLikeProfile(sample.obj); } catch (e) { return 'threw: ' + e.message; } })() : 'n/a';
        console.log('  looksLikeMedia:  ', m);
        console.log('  looksLikeProfile:', p);
        if (m === false && p === false) console.log('  → VERDICT: the tap SEES it and DISCARDS it. Same fix shape as #24: add a putHighlight collector to the SAME collectMedia walk (zero extra requests). Wire it into BOTH call sites.');
      }
      console.log('\nRaw: IGFM_HL._seen  ·  sample: copy(%o)', sample.obj);
      return { endpoints: byUrl, sample: sample.obj, owner };
    },
  };
  console.log('%c[HL] recorder armed — now CLICK through to the profile in this same tab, let the tray render, then run IGFM_HL.report()', 'color:#0a0;font-weight:bold');
})();
