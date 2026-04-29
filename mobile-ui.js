// mobile-ui.js
// Mobile interactions on top of the existing fullpage.html / fullpage.js DOM.
//   - 3-snap-point bottom sheet (peek / half / full) with touch-drag
//   - Hamburger toggles the existing left panel
//   - Search FAB opens a full-screen search overlay
//   - Topbar centered title mirrors the currently selected author
// All behavior no-ops above 768px wide so desktop is untouched.

(function () {
  const MOBILE_BP = 768;
  const SNAP_HEIGHTS = { peek: 96, half: 380, full: 0 /* full is css calc */ };
  const SNAP_ORDER = ['peek', 'half', 'full'];

  const isMobile = () => window.matchMedia(`(max-width: ${MOBILE_BP}px)`).matches;
  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ---------- Search overlay ----------
  function toggleSearchOverlay(force) {
    const open = typeof force === 'boolean'
      ? force
      : !document.body.classList.contains('mobile-search-open');
    document.body.classList.toggle('mobile-search-open', open);

    const single = $('#singleSearchBox');
    const path = $('#pathFinderBox');
    if (single) single.removeAttribute('data-mode-active');
    if (path) path.removeAttribute('data-mode-active');

    const pathVisible = path && path.style.display !== 'none' &&
      getComputedStyle(path).display !== 'none';
    const target = pathVisible ? path : single;
    if (target) target.setAttribute('data-mode-active', 'true');

    if (open && target) {
      const input = target.querySelector('input');
      if (input) setTimeout(() => input.focus(), 50);
    }
  }

  // ---------- Left panel drawer ----------
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
    new MutationObserver(syncLeftPanelClass)
      .observe(panel, { attributes: true, attributeFilter: ['class'] });

    document.addEventListener('click', (e) => {
      if (!isMobile()) return;
      if (!panel.classList.contains('expanded')) return;
      if (panel.contains(e.target)) return;
      if (e.target.closest && e.target.closest('#mobileMenuBtn')) return;
      panel.classList.remove('expanded');
      syncLeftPanelClass();
    });
    syncLeftPanelClass();
  }

  // ---------- Bottom sheet (3 snap points) ----------
  function setSnap(sheet, snap) {
    if (!SNAP_ORDER.includes(snap)) snap = 'peek';
    sheet.dataset.snap = snap;
    sheet.dispatchEvent(new CustomEvent('snapchange', { detail: { snap } }));
    updateFabPosition();
  }

  function nextSnap(current, dir) {
    let i = SNAP_ORDER.indexOf(current);
    if (i < 0) i = 0;
    i = Math.max(0, Math.min(SNAP_ORDER.length - 1, i + dir));
    return SNAP_ORDER[i];
  }

  function wireBottomSheet(sheet) {
    if (!sheet || sheet.dataset.mobileWired === '1') return;
    sheet.dataset.mobileWired = '1';
    if (!sheet.dataset.snap) sheet.dataset.snap = 'peek';

    let handle = sheet.querySelector(':scope > .mobile-sheet-handle');
    if (!handle) {
      handle = document.createElement('div');
      handle.className = 'mobile-sheet-handle';
      handle.setAttribute('aria-label', 'Adjust details panel');
      sheet.insertBefore(handle, sheet.firstChild);
    }

    // Tap to cycle peek -> half -> full -> peek
    handle.addEventListener('click', (e) => {
      if (!isMobile()) return;
      if (handle.dataset.dragging === '1') {
        delete handle.dataset.dragging;
        return;
      }
      const cur = sheet.dataset.snap || 'peek';
      const i = SNAP_ORDER.indexOf(cur);
      const next = SNAP_ORDER[(i + 1) % SNAP_ORDER.length];
      setSnap(sheet, next);
    });

    // Drag handler — touchstart/end (and mouse fallbacks for testing)
    let startY = null;
    let startSnap = null;
    function onStart(ev) {
      if (!isMobile()) return;
      const t = (ev.touches && ev.touches[0]) || ev;
      startY = t.clientY;
      startSnap = sheet.dataset.snap || 'peek';
    }
    function onEnd(ev) {
      if (startY == null) return;
      const t = (ev.changedTouches && ev.changedTouches[0]) || ev;
      const dy = startY - t.clientY;
      if (Math.abs(dy) > 40) {
        handle.dataset.dragging = '1';
        const dir = dy > 0 ? +1 : -1; // up = grow snap
        setSnap(sheet, nextSnap(startSnap, dir));
      }
      startY = null;
      startSnap = null;
    }
    handle.addEventListener('touchstart', onStart, { passive: true });
    handle.addEventListener('touchend', onEnd);
    handle.addEventListener('mousedown', onStart);
    document.addEventListener('mouseup', onEnd);
  }

  // ---------- FAB position ----------
  function updateFabPosition() {
    const fab = $('#mobileSearchBtn');
    if (!fab) return;
    if (!isMobile()) {
      fab.style.bottom = '';
      fab.removeAttribute('data-hidden');
      return;
    }
    const sheets = $$('.sidebar[data-snap], .collections-sidebar[data-snap], .fields-sidebar[data-snap]')
      .filter((s) => s.offsetParent !== null);
    const activeSheet = sheets[0];
    const snap = activeSheet ? (activeSheet.dataset.snap || 'peek') : 'peek';

    if (snap === 'full') {
      fab.setAttribute('data-hidden', 'true');
    } else {
      fab.removeAttribute('data-hidden');
      const h = SNAP_HEIGHTS[snap] || 96;
      fab.style.bottom = (h + 16) + 'px';
    }
  }

  // ---------- Topbar title sync ----------
  function syncTopbarTitle() {
    if (!isMobile()) return;
    const nameEl = $('#mobileTopbarName');
    const clusterEl = $('#mobileTopbarCluster');
    if (!nameEl) return;

    const sidebar = $('#authorsViewport .sidebar') || $('.viewport.active .sidebar');
    if (!sidebar) {
      nameEl.textContent = 'Author Network';
      if (clusterEl) clusterEl.textContent = '';
      return;
    }
    const name = (sidebar.querySelector('.author-name, h3') || {}).textContent;
    if (name && name.trim()) {
      nameEl.textContent = name.trim();
    } else {
      nameEl.textContent = 'Author Network';
    }
    if (clusterEl) clusterEl.textContent = '';
  }

  // ---------- Init ----------
  function init() {
    $$('.sidebar, .collections-sidebar, .fields-sidebar').forEach(wireBottomSheet);

    new MutationObserver(() => {
      $$('.sidebar, .collections-sidebar, .fields-sidebar').forEach(wireBottomSheet);
      syncTopbarTitle();
    }).observe(document.body, { childList: true, subtree: true });

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

    // Close search overlay on Escape or when the user submits a search.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') toggleSearchOverlay(false);
    });
    document.addEventListener('click', (e) => {
      if (!isMobile()) return;
      if (!document.body.classList.contains('mobile-search-open')) return;
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('#searchBtn, #findPathBtn')) {
        setTimeout(() => toggleSearchOverlay(false), 0);
      }
    });

    // FAB reposition on viewport changes
    window.addEventListener('resize', updateFabPosition);
    updateFabPosition();
    syncTopbarTitle();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
