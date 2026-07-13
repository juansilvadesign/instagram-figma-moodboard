// inject.js — runs in the page context (MAIN world).
// Resolves Instagram media directly from the React component tree (fiber).

(() => {
  function findFiberNode(container) {
    const key = Object.keys(container).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    );
    if (key && container[key]) return container[key];
    
    // check popular inner class selectors
    const el = container.querySelector('[class*="React"], [class*="react"], div');
    if (el) {
      const childKey = Object.keys(el).find(
        (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
      );
      if (childKey && el[childKey]) return el[childKey];
    }
    
    // search all descendants
    for (const descendant of container.querySelectorAll('*')) {
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

    for (const k in obj) {
      try {
        const val = obj[k];
        if (val && typeof val === 'object') {
          if (k === 'media' || k === 'post' || k === 'item' || k === 'publication') {
            if (val.carousel_media || val.edge_sidecar_to_children || val.video_versions || val.image_versions2 || val.display_resources) {
              return val;
            }
          }
          const found = searchProps(val, visited);
          if (found) return found;
        }
      } catch {
        // ignore security/access errors
      }
    }
    return null;
  }

  function findMediaInFiber(node, visited = new Set()) {
    if (!node || visited.has(node)) return null;
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
    if (!container) {
      container = document;
    }

    try {
      const fiber = findFiberNode(container);
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
