// inject.js — runs in the page context (MAIN world).
// Resolves Instagram media directly from the React component tree (fiber).

(() => {
  function findFiberNode(container) {
    if (!container) return null;
    const key = Object.keys(container).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    );
    if (key && container[key]) return container[key];
    
    // search descendants up to a safe limit to prevent hangs on large documents
    const descendants = container.querySelectorAll('*');
    const limit = Math.min(descendants.length, 150);
    for (let i = 0; i < limit; i++) {
      const descendant = descendants[i];
      const k = Object.keys(descendant).find(
        (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
      );
      if (k && descendant[k]) return descendant[k];
    }
    return null;
  }

  function searchProps(obj, visited) {
    if (!obj || typeof obj !== 'object' || visited.has(obj)) return null;
    visited.add(obj);

    if (obj.shortcode || obj.code) {
      if (obj.carousel_media || obj.edge_sidecar_to_children || obj.video_versions || obj.image_versions2 || obj.display_resources) {
        return obj;
      }
    }

    // Inspect child properties at depth 1 only (no deep recursion into props to avoid circular loops)
    for (const k in obj) {
      if (k.startsWith('__react') || k === '_owner' || k === 'stateNode' || k === 'child' || k === 'sibling' || k === 'return') {
        continue;
      }
      try {
        const val = obj[k];
        if (val && typeof val === 'object' && !visited.has(val)) {
          if (val.shortcode || val.code) {
            if (val.carousel_media || val.edge_sidecar_to_children || val.video_versions || val.image_versions2 || val.display_resources) {
              return val;
            }
          }
        }
      } catch {
        // ignore security/access errors
      }
    }
    return null;
  }

  function findMediaInFiber(node, visited = new Set()) {
    // Limit visited nodes to 500 to prevent performance lag or stack overflows
    if (!node || visited.has(node) || visited.size > 500) return null;
    visited.add(node);

    for (const propsKey of ['memoizedProps', 'pendingProps']) {
      const props = node[propsKey];
      if (props && typeof props === 'object') {
        const found = searchProps(props, new Set());
        if (found) return found;
      }
    }

    if (node.child) {
      const found = findMediaInFiber(node.child, visited);
      if (found) return found;
    }
    if (node.sibling) {
      const found = findMediaInFiber(node.sibling, visited);
      if (found) return found;
    }
    return null;
  }

  document.addEventListener('igfm-request-react', (e) => {
    const { shortcode } = e.detail;
    console.log('[IGFM-Inject] Received request for shortcode:', shortcode);
    
    // Find the container corresponding to this shortcode
    let container = null;
    for (const article of document.querySelectorAll('article')) {
      if (article.innerHTML.includes(shortcode)) {
        container = article;
        break;
      }
    }
    if (!container) {
      for (const dialog of document.querySelectorAll('div[role="dialog"]')) {
        if (dialog.innerHTML.includes(shortcode)) {
          container = dialog;
          break;
        }
      }
    }
    if (!container) {
      const main = document.querySelector('main');
      if (main && location.pathname.includes(shortcode)) {
        container = main;
      }
    }

    try {
      const fiber = container ? findFiberNode(container) : null;
      const rawMedia = fiber ? findMediaInFiber(fiber) : null;
      let media = null;
      if (rawMedia) {
        const R = globalThis.IGFM_RESOLVER;
        if (R) {
          media = R.normalizeShortcodeMedia(rawMedia) || R.normalizeApiV1Item(rawMedia);
          if (media) {
            media.source = 'react_fiber';
          }
        }
      }
      
      console.log('[IGFM-Inject] Resolved media from React:', media);
      document.dispatchEvent(new CustomEvent('igfm-response-react', {
        detail: { shortcode, media }
      }));
    } catch (err) {
      console.error('[IGFM-Inject] Error extracting from React:', err);
      document.dispatchEvent(new CustomEvent('igfm-response-react', {
        detail: { shortcode, media: null, error: err.message }
      }));
    }
  });
})();
