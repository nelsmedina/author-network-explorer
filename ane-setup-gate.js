// Setup gate: if no OpenAlex API key is configured, cover the UI with a short
// explanation and a route to the settings page. Without this, a fresh install
// would just look broken — every search would fail with an opaque API error.
//
// Injected as an overlay from script rather than as markup, so popup.html and
// fullpage.html share one implementation.

(function () {
  'use strict';

  const OVERLAY_ID = 'ane-setup-gate';

  function buildOverlay() {
    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '99999',
      background: 'rgba(15, 15, 26, 0.97)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    });

    const card = document.createElement('div');
    Object.assign(card.style, {
      background: '#16213e',
      borderLeft: '3px solid #4ecca3',
      borderRadius: '10px',
      padding: '22px',
      maxWidth: '380px',
      textAlign: 'left',
      color: '#eee'
    });

    const title = document.createElement('h2');
    title.textContent = 'One-time setup needed';
    Object.assign(title.style, {
      color: '#4ecca3',
      fontSize: '16px',
      margin: '0 0 10px'
    });

    const body = document.createElement('p');
    body.textContent =
      'A.N.E reads publication data from OpenAlex, which requires a free API key. ' +
      'Grab one in about 30 seconds, paste it into settings, and you’re set.';
    Object.assign(body.style, {
      fontSize: '13px',
      lineHeight: '1.5',
      margin: '0 0 16px',
      color: '#c8cee0'
    });

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Open settings';
    Object.assign(button.style, {
      background: '#4ecca3',
      color: '#1a1a2e',
      border: 'none',
      borderRadius: '6px',
      padding: '10px 16px',
      fontSize: '13px',
      fontWeight: '600',
      cursor: 'pointer',
      fontFamily: 'inherit'
    });
    button.addEventListener('click', () => chrome.runtime.openOptionsPage());

    card.append(title, body, button);
    overlay.appendChild(card);
    return overlay;
  }

  async function sync() {
    const existing = document.getElementById(OVERLAY_ID);
    if (await ANE.hasKey()) {
      if (existing) existing.remove();
    } else if (!existing) {
      document.body.appendChild(buildOverlay());
    }
  }

  // Lift the gate as soon as the key is saved in the settings page, so an
  // already-open popup or tab starts working without a manual reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[ANE.STORAGE_KEY]) sync();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sync);
  } else {
    sync();
  }
})();
