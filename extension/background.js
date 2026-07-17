// background.js — thin MV3 service worker: receives a download plan from the content script and
// saves each file via chrome.downloads into Downloads/instagram-captures/.
//
// Resolution deliberately does NOT live here: the content script's fetches ride the page's
// logged-in same-origin session, and the SW has no DOMParser and would need extra host
// permissions to fetch instagram.com with credentials. The CDN media URLs themselves are signed
// (query params), so chrome.downloads needs no host permissions and no cookies.

console.log('[IGFM] service worker up');

// Defense-in-depth on the relative path built by the content script: keep it inside the
// Downloads folder and free of characters chrome.downloads rejects on Windows.
function safeRelativePath(p) {
  return (
    String(p || '')
      .replace(/\\/g, '/')
      .split('/')
      .filter((seg) => seg && seg !== '.' && seg !== '..')
      .map((seg) => seg.replace(/[^A-Za-z0-9._ -]+/g, '-'))
      .join('/') || 'instagram-captures/capture'
  );
}

function downloadOne(item) {
  return new Promise((resolve) => {
    chrome.downloads.download(
      {
        url: item.url,
        filename: safeRelativePath(item.filename),
        // Media uniquifies (never clobber an earlier capture); capture.json asks for 'overwrite',
        // because a re-capture that left 'capture (1).json' would be silently ignored by the
        // placement CLI, which reads capture.json by name.
        conflictAction: item.conflictAction === 'overwrite' ? 'overwrite' : 'uniquify',
        saveAs: false,
      },
      (id) => {
        if (chrome.runtime.lastError || typeof id !== 'number') {
          resolve({
            ok: false,
            error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'download did not start',
          });
        } else {
          resolve({ ok: true, id });
        }
      },
    );
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'igfm-download') return;
  (async () => {
    const items = Array.isArray(msg.items) ? msg.items : [];
    if (!items.length) {
      sendResponse({ ok: false, error: 'empty download plan' });
      return;
    }
    const results = [];
    for (const item of items) results.push(await downloadOne(item)); // sequential keeps the shelf orderly
    const failed = results.filter((r) => !r.ok);
    if (failed.length === results.length) {
      sendResponse({ ok: false, error: failed[0].error });
    } else {
      sendResponse({
        ok: true,
        saved: results.length - failed.length,
        failed: failed.length,
        error: failed.length ? failed[0].error : undefined,
      });
    }
  })();
  return true; // keep the message channel open for the async sendResponse
});
