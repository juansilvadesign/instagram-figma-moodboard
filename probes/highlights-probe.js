/* IGFM — HIGHLIGHTS PROBE v2 (zero requests, throwaway diagnostic)
 *
 * v1 result (2026-07-18, @solarity.studio which HAS 3 highlights): the tray endpoint IS tapped —
 * `data.highlights` arrived over `/api/graphql` — but the object was an EMPTY connection
 * (`edges: []`, no owner). Two v1 flaws explain it: (a) it stopped at the FIRST highlight-shaped
 * object (that empty connection) instead of hunting a POPULATED one, and (b) it never captured the
 * REQUEST side, where the owner (which user was asked for) actually lives.
 *
 * v2 fixes both:
 *  - captures each /api/graphql REQUEST body → query `fb_api_req_friendly_name` + `variables`
 *    (the OWNER signal: user_id / username the query was fired for) + `doc_id`
 *  - scans EVERY response (graphql AND REST), collects ALL highlight-shaped nodes, prefers a
 *    POPULATED one (has a `title` or an `id` like `highlight:123…`)
 *  - for the populated tray: item shape (id / title / cover CDN url), the query it came from, the
 *    request variables, and every `username` co-located in that same response
 *
 * This stays a throwaway console recorder — inject.js is the ONLY real tap; do not port this in.
 * It exists because the question is "what does the tap THROW AWAY", which the caches can't answer.
 *
 * HOW TO RUN (~2 min)
 *   1. Open instagram.com — the HOME feed, NOT the target profile.
 *   2. Paste this whole file into the DevTools console → it prints "[HL] v2 armed".
 *   3. CLICK through to a profile that HAS highlights (e.g. @solarity.studio) in that SAME tab.
 *      Do not reload.
 *   4. Let the highlights circles render, then **hover them and click one OPEN, then close it** —
 *      this forces the tray/reel data to load if it's lazy.
 *   5. Run:  IGFM_HL.report()
 *   6. Paste the whole report back. (If it still says "no POPULATED tray", also paste
 *      `copy(IGFM_HL._seen.filter(s => /highlight/i.test(s.text)).map(s => s.url))`.)
 */
(() => {
  const seen = []; // { url, req, text }

  const of = window.fetch;
  window.fetch = function (...a) {
    const url = (a[0] && a[0].url) || a[0];
    let req = null;
    try { req = (a[1] && a[1].body) || null; } catch { /* ignore */ }
    return of.apply(this, a).then((r) => {
      try { r.clone().text().then((t) => seen.push({ url: String(url), req, text: t })).catch(() => {}); } catch { /* ignore */ }
      return r;
    });
  };
  const oo = XMLHttpRequest.prototype.open;
  const os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__u = u; return oo.call(this, m, u, ...r); };
  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener('load', () => {
      try { seen.push({ url: String(this.__u), req: body || null, text: this.responseText || '' }); } catch { /* ignore */ }
    });
    return os.apply(this, arguments);
  };

  // @defer streams arrive newline-chunked — parse per line, keep whatever parses (gotcha #13).
  function parseChunks(text) {
    const out = [];
    for (const line of String(text).split('\n')) {
      const s = line.trim();
      if (s && (s[0] === '{' || s[0] === '[')) { try { out.push(JSON.parse(s)); } catch { /* not a chunk */ } }
    }
    if (!out.length) { try { out.push(JSON.parse(text)); } catch { /* not json */ } }
    return out;
  }

  // IG graphql POST body is url-encoded form data: fb_api_req_friendly_name / variables / doc_id.
  function parseReq(req) {
    if (typeof req !== 'string') return null;
    let p; try { p = new URLSearchParams(req); } catch { return null; }
    const name = p.get('fb_api_req_friendly_name');
    const doc_id = p.get('doc_id');
    let variables = p.get('variables');
    if (!name && !variables && !doc_id) return null;
    try { variables = variables ? JSON.parse(variables) : null; } catch { /* leave as string */ }
    return { name, doc_id, variables };
  }

  const firstUrl = (o, d = 0) => {
    if (!o || typeof o !== 'object' || d > 7) return null;
    if (typeof o.url === 'string' && /^https?:/.test(o.url)) return o.url;
    for (const k of Object.keys(o)) { const r = firstUrl(o[k], d + 1); if (r) return r; }
    return null;
  };

  // Collect every highlight-shaped node + every co-located username, no early break.
  function walk(root, onHit, onOwner) {
    const stack = [root]; const visited = new Set(); let budget = 300000;
    while (stack.length && --budget > 0) {
      const v = stack.pop();
      if (!v || typeof v !== 'object' || visited.has(v)) continue;
      visited.add(v);
      if (Array.isArray(v)) { for (const x of v) stack.push(x); continue; }
      const id = typeof v.id === 'string' ? v.id : '';
      const looksHl = /^highlight:/.test(id) ||
        (typeof v.title === 'string' && (v.cover_media || v.cover_cropped_image || v.cover_media_cropped_thumbnail));
      if (looksHl) onHit(v);
      if (typeof v.username === 'string') onOwner(v.username);
      for (const k of Object.keys(v)) { const val = v[k]; if (val && typeof val === 'object') stack.push(val); }
    }
  }

  window.IGFM_HL = {
    _seen: seen,
    report() {
      const inj = window.IGFM_INJECT, TAP = inj && inj.TAP_URL_RE;
      console.log('%c=== IGFM HIGHLIGHTS PROBE v2 ===', 'font-weight:bold');
      console.log(`responses recorded: ${seen.length} · IGFM_INJECT present: ${!!inj}`);

      // Scan EVERY response for populated highlight nodes; note the endpoint + request each came from.
      const trays = [];
      for (const s of seen) {
        const rq = parseReq(s.req);
        let hits = 0, sample = null;
        for (const p of parseChunks(s.text)) {
          walk(p, (h) => { hits++; if (!sample && (h.title || /^highlight:/.test(h.id || ''))) sample = h; }, () => {});
        }
        if (hits && sample) trays.push({ url: s.url, name: rq && rq.name, vars: rq && rq.variables, node: sample, text: s.text, tapped: TAP ? TAP.test(s.url) : '?' });
      }

      if (!trays.length) {
        console.warn('  no POPULATED tray in any response. Open a highlight (click a circle), then re-run.');
        const names = new Set(), urls = new Set();
        for (const s of seen) {
          if (/\/api\/graphql|\/graphql\/query/.test(s.url)) { const rq = parseReq(s.req); if (rq && rq.name) names.add(rq.name); }
          if (/highlight/i.test(s.text)) urls.add(s.url.split('?')[0]);
        }
        console.log('  graphql queries that fired:', [...names]);
        console.log('  responses whose TEXT mentions "highlight":', [...urls]);
        return { trays: [] };
      }

      // Q1 — which endpoint/query carries the tray, and is TAP_URL_RE already on it?
      console.log('\n--- populated tray found ---');
      for (const t of trays) {
        console.log(`  ${t.tapped === true ? '✅ tapped' : t.tapped === false ? '❌ NOT tapped' : '?'}  ${t.url.split('?')[0]}  · query=${t.name || '(REST/none)'}`);
      }
      const t = trays[0];

      // Q2 — item shape
      console.log('\n--- tray item shape ---');
      console.log('  KEYS:', Object.keys(t.node));
      console.log('  id:', t.node.id, '| title:', t.node.title, '| media_count:', t.node.media_count);
      const cover = firstUrl(t.node.cover_media || t.node);
      console.log('  cover url:', cover ? cover.slice(0, 110) + '…' : 'NOT FOUND');
      console.log('  cover is direct CDN (placeable like a post cover):', !!cover && /cdninstagram|fbcdn/.test(cover));

      // Q3 — OWNER (#22/#26): request variables (who was asked for) + usernames in the same response
      console.log('\n--- OWNER signal (the #22/#26 question) ---');
      console.log('  request variables (who the query asked for):', JSON.stringify(t.vars));
      const owners = new Set();
      for (const p of parseChunks(t.text)) walk(p, () => {}, (u) => owners.add(u));
      console.log('  usernames co-located in the SAME response:', [...owners]);
      console.log('  → keyable if the request vars name the target user (then the tap must cache the');
      console.log('    request too), or if a tray item / sibling carries the username. If NEITHER,');
      console.log('    highlights are UNSAFE to place (can\'t tell target vs a suggested user — #22/#26).');
      console.log('\nRaw: IGFM_HL._seen  ·  sample node: copy(%o)', t.node);
      return { query: t.name, url: t.url, vars: t.vars, node: t.node, cover, ownersInResponse: [...owners] };
    },
  };
  console.log('%c[HL] v2 armed — click to a profile WITH highlights, let the tray render, HOVER + OPEN one highlight, then run IGFM_HL.report()', 'color:#0a0;font-weight:bold');
})();
