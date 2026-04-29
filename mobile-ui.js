// mobile-ui.js
// Wires up the mobile-only header icons + bottom-sheet / drawer interactions.
// No-ops on screens wider than 768px — the desktop UI is unchanged there.

(function () {
  const MOBILE_BP = 768;
  const isMobile = () => window.matchMedia(`(max-width: ${MOBILE_BP}px)`).matches;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  // --------- Search overlay toggle ---------
  function toggleSearchOverlay(force) {
    const open = typeof force === 'boolean'
      ? force
      : !document.body.classList.contains('mobile-search-open');
    document.body.classList.toggle('mobile-search-open', open);

    // Mark which input box is the active one based on visible mode.
    const single = $('#singleSearchBox');
    const path = $('#pathFinderBox');
    if (single) single.removeAttribute('data-mode-active');
    if (path) path.removeAttribute('data-mode-active');
    const pathVisible = path && path.style.display !== 'none' && getComputedStyle(path).display !== 'none';
    const target = pathVisible ? path : single;
    if (target) target.setAttribute('data-mode-active', 'true');

    if (open && target) {
      const input = target.querySelector('input');
      if (input) setTimeout(() => input.focus(), 50);
    }
    const btn = $('#mobileSearchBtn');
    if (btn) btn.classList.toggle('active', open);
  }

  // --------- Left panel: backdrop + close-on-tap ---------
  function syncLeftPanelClass() {
    const panel = $('#leftPanel');
    document.body.classList.toggle(
      'mobile-leftpanel-open',
      !!(panel && panel.classList.contains('expanded'))
    );
  }

  function wireLeftPanel() {
    const panel = $('#leftPanel');
    if (!panel) return;
    // React to class changes that the existing toggle button performs.
    const obs = new MutationObserver(syncLeftPanelClass);
    obs.observe(panel, { attributes: true, attributeFilter: ['class'] });

    // Close when tapping the backdrop (anywhere outside the panel).
    document.addEventListener('click', (e) => {
      if (!isMobile()) return;
      if (!panel.classList.contains('expanded')) return;
      if (panel.contains(e.target)) return;
      // Don't close if the tap was the toggle itself.
      if (e.target.closest && e.target.closest('.left-panel-toggle')) return;
      panel.classList.remove('expanded');
      syncLeftPanelClass();
    });
    syncLeftPanelClass();
  }

  // --------- Bottom-sheet sidebars ---------
  function wireBottomSheet(sidebar) {
    if (!sidebar || sidebar.dataset.mobileWired === '1') return;
    sidebar.dataset.mobileWired = '1';

    // Add a tap target spanning the top strip.
    let handle = sidebar.querySelector(':scope > .mobile-sheet-handle');
    if (!handle) {
      handle = document.createElement('div');
      handle.className = 'mobile-sheet-handle';
      handle.setAttribute('aria-label', 'Toggle details panel');
      sidebar.insertBefore(handle, sidebar.firstChild);
    }

    handle.addEventListener('click', () => {
      if (!isMobile()) return;
      sidebar.classList.toggle('mobile-expanded');
    });

    // Mark sheet as having content so the handle highlights.
    const updateHasContent = () => {
      const hasText = (sidebar.innerText || '').trim().length > 0;
      sidebar.classList.toggle('mobile-has-content', hasText);
    };
    const obs = new MutationObserver(updateHasContent);
    obs.observe(sidebar, { childList: true, subtree: true, characterData: true });
    updateHasContent();
  }

  // --------- Init ---------
  function init() {
    // Find any existing sidebar elements and wire them as bottom sheets.
    $$('.sidebar, .collections-sidebar, .fields-sidebar').forEach(wireBottomSheet);

    // Re-scan periodically — viewports may be created lazily by the app.
    const rescan = new MutationObserver(() => {
      $$('.sidebar, .collections-sidebar, .fields-sidebar').forEach(wireBottomSheet);
    });
    rescan.observe(document.body, { childList: true, subtree: true });

    wireLeftPanel();

    const searchBtn = $('#mobileSearchBtn');
    if (searchBtn) {
      searchBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSearchOverlay();
      });
    }

    const menuBtn = $('#mobileMenuBtn');
    const leftPanel = $('#leftPanel');
    if (menuBtn && leftPanel) {
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        leftPanel.classList.toggle('expanded');
        syncLeftPanelClass();
      });
    }
    // Close the search overlay on Escape or after submitting.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') toggleSearchOverlay(false);
    });
    // When user taps the actual search/find-path button, close the overlay.
    document.addEventListener('click', (e) => {
      if (!isMobile()) return;
      if (!document.body.classList.contains('mobile-search-open')) return;
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('#searchBtn, #findPathBtn')) {
        toggleSearchOverlay(false);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
