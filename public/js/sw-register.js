// Service worker registration — network-first updates, reload when a new version activates.
(function () {
  if (!('serviceWorker' in navigator)) return;
  // Chrome 83 WebView (inkPalmPlus/zxh_wv_te): when a SW controls the page, any
  // same-origin fetch() that the SW handles with return-without-respondWith hangs
  // forever. Skip SW registration entirely on this WebView so all requests go native.
  if (/Chrome\/8[0-3].*\bwv\b/.test(navigator.userAgent)) return;

  let reloading = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    // Never force-reload the reader mid-session. clients.claim() in sw.js already lets the new
    // service worker start serving fresh requests immediately, so nothing actually needs this
    // page to reload right now — the update applies naturally the next time the user navigates
    // (e.g. closes the book). Reloading here was actively harmful: it fires beforeunload, which
    // reader.js can't distinguish from a real close, so it ran the ephemeral-peek cleanup
    // (deleting a peeked book's temp file/row) even though the user never left the book — the
    // reload that followed then found nothing to re-fetch ("book not found").
    if (location.pathname.startsWith('/reader.html')) return;
    reloading = true;
    location.reload();
  });

  function checkForUpdates(reg) {
    try { reg.update(); } catch { /* ignore */ }
  }

  navigator.serviceWorker.register('/sw.js')
    .then((reg) => {
      checkForUpdates(reg);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdates(reg);
      });
      window.addEventListener('focus', () => checkForUpdates(reg));
    })
    .catch(() => {});
})();
