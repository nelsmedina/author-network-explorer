// mobile-ui.js
// Mobile interactions on top of the existing fullpage.html / fullpage.js DOM.
//   - Mirrors real data from existing #authorName / #paperCount / etc. into
//     the new mobile sheet (#mobileSheet). No mock data — fullpage.js
//     remains the single source of truth.
//   - 3-snap-point bottom sheet (peek / half / full) with touch drag.
//   - Sheet tabs proxy clicks to the existing .tab-bar buttons.
//   - Hamburger toggles the existing left panel (drawer).
//   - Search FAB opens the existing search overlay.
// All behavior no-ops above 768px wide so desktop is untouched.

(function () {
  const MOBILE_BP = 768;
  const SNAP_HEIGHTS = { peek: 96, half: 380, full: 0 };
  const SNAP_ORDER = ['peek', 'half', 'full'];

  const isMobile = () => window.matchMedia(`(max-width: ${MOBILE_BP}px)`).matches;
  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ──────────────── Search overlay ────────────────
  // Clean overlay (#mobileSearchOverlay). Typing is mirrored to the
  // hidden #searchInput, the underlying #searchBtn drives the real
  // search, and rows from #searchResults are mirrored into #mSearchList.

  function setOverlayOpen(open) {
    const overlay = $('#mobileSearchOverlay');
    if (!overlay) return;
    overlay.hidden = !open;
    document.body.classList.toggle('mobile-search-open', open);
    if (open) {
      const input = $('#mSearchInput');
      if (input) setTimeout(() => input.focus(), 60);
    }
    updateFabPosition();
  }

  function toggleSearchOverlay(force) {
    const open = typeof force === 'boolean'
      ? force
      : !!($('#mobileSearchOverlay') && $('#mobileSearchOverlay').hidden);
    setOverlayOpen(open);
  }

  function wireSearchOverlay() {
    const overlay = $('#mobileSearchOverlay');
    const input = $('#mSearchInput');
    const back = $('#mSearchBack');
    const list = $('#mSearchList');
    const heading = $('#mSearchHeading');
    if (!overlay || !input || !back || !list) return;

    back.addEventListener('click', () => setOverlayOpen(false));

    // Typing → mirror to the real #searchInput; pressing Enter triggers
    // the real #searchBtn so fullpage.js's search engine runs.
    let debounce = null;
    function runRealSearch() {
      const realInput = $('#searchInput');
      const realBtn = $('#searchBtn');
      if (!realInput || !realBtn) return;
      realInput.value = input.value;
      realInput.dispatchEvent(new Event('input', { bubbles: true }));
      realBtn.click();
    }
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      const q = input.value.trim();
      if (heading) heading.textContent = q ? 'Searching…' : 'Type to search';
      if (!q) {
        list.textContent = '';
        return;
      }
      debounce = setTimeout(runRealSearch, 220);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(debounce);
        runRealSearch();
      }
    });

    // Mirror result rows from #searchResults → #mSearchList.
    const realResults = $('#searchResults');
    if (realResults) {
      const obs = new MutationObserver(() => mirrorSearchResults());
      obs.observe(realResults, { childList: true, subtree: true });
    }

    // Tap-outside (chrome above the overlay) is naturally swallowed by
    // the fullscreen overlay — no escape handler needed beyond the
    // back button.
  }

  function mirrorSearchResults() {
    const overlay = $('#mobileSearchOverlay');
    if (!overlay || overlay.hidden) return;
    const src = $('#searchResults');
    const list = $('#mSearchList');
    const heading = $('#mSearchHeading');
    if (!src || !list) return;

    const rows = $$('.search-result', src);
    list.textContent = '';

    if (!rows.length) {
      if (heading) heading.textContent = 'No results';
      return;
    }
    if (heading) heading.textContent = 'Results';

    rows.forEach((srcRow) => {
      const text = (srcRow.textContent || '').trim();
      if (!text) return;
      // Heuristic split: name on first non-empty line, rest as affiliation.
      const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
      const name = lines[0] || text;
      const aff = lines.slice(1).join(' · ');

      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'm-search-row';
      row.innerHTML =
        '<span class="m-search-dot"></span>' +
        '<div class="m-search-main">' +
          '<div class="m-search-name"></div>' +
          (aff ? '<div class="m-search-aff"></div>' : '') +
        '</div>';
      row.querySelector('.m-search-name').textContent = name;
      const affEl = row.querySelector('.m-search-aff');
      if (affEl) affEl.textContent = aff;

      row.addEventListener('click', () => {
        // Trigger the real row's click so fullpage.js selects/loads
        // the author. Then close the overlay.
        srcRow.click();
        setOverlayOpen(false);
      });
      list.appendChild(row);
    });
  }

  // ──────────────── Left panel drawer ────────────────
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

  // ──────────────── Bottom sheet snap points ────────────────
  function setSnap(snap) {
    if (!SNAP_ORDER.includes(snap)) snap = 'peek';
    const sheet = $('#mobileSheet');
    if (!sheet) return;
    sheet.dataset.snap = snap;
    updateFabPosition();
  }
  function nextSnap(current, dir) {
    let i = SNAP_ORDER.indexOf(current);
    if (i < 0) i = 0;
    i = Math.max(0, Math.min(SNAP_ORDER.length - 1, i + dir));
    return SNAP_ORDER[i];
  }
  function snapHeightPx(snap) {
    if (snap === 'full') return Math.max(window.innerHeight - 60, 400);
    return SNAP_HEIGHTS[snap] || 96;
  }
  function nearestSnap(px) {
    const candidates = SNAP_ORDER.map((s) => ({ s, h: snapHeightPx(s) }));
    candidates.sort((a, b) => Math.abs(a.h - px) - Math.abs(b.h - px));
    return candidates[0].s;
  }

  function wireSheet() {
    const sheet = $('#mobileSheet');
    if (!sheet) return;
    const handle = sheet.querySelector('.m-sheet-handle');
    if (!handle) return;

    let startY = null;
    let startH = null;
    let dragged = false;
    function onStart(ev) {
      if (!isMobile()) return;
      const t = (ev.touches && ev.touches[0]) || ev;
      startY = t.clientY;
      startH = sheet.getBoundingClientRect().height;
      dragged = false;
      sheet.style.transition = 'none';
    }
    function onMove(ev) {
      if (startY == null) return;
      const t = (ev.touches && ev.touches[0]) || ev;
      const dy = startY - t.clientY;
      const target = Math.max(60, Math.min(window.innerHeight - 40, startH + dy));
      sheet.style.height = target + 'px';
      if (Math.abs(dy) > 6) dragged = true;
      if (ev.cancelable) ev.preventDefault();
      updateFabPosition();
    }
    function onEnd() {
      if (startY == null) return;
      const finalH = sheet.getBoundingClientRect().height;
      sheet.style.transition = '';
      sheet.style.height = '';
      let snap;
      if (dragged) {
        snap = nearestSnap(finalH);
      } else {
        const cur = sheet.dataset.snap || 'peek';
        snap = SNAP_ORDER[(SNAP_ORDER.indexOf(cur) + 1) % SNAP_ORDER.length];
      }
      setSnap(snap);
      startY = null;
      startH = null;
    }

    handle.addEventListener('touchstart', onStart, { passive: false });
    handle.addEventListener('touchmove',  onMove,  { passive: false });
    handle.addEventListener('touchend',   onEnd);
    handle.addEventListener('touchcancel', onEnd);

    handle.addEventListener('mousedown', onStart);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
  }

  // ──────────────── FAB position ────────────────
  function updateFabPosition() {
    const fab = $('#mobileSearchBtn');
    if (!fab) return;
    if (!isMobile()) {
      fab.style.bottom = '';
      fab.removeAttribute('data-hidden');
      return;
    }
    const sheet = $('#mobileSheet');
    const snap = sheet ? (sheet.dataset.snap || 'peek') : 'peek';
    if (snap === 'full') {
      fab.setAttribute('data-hidden', 'true');
    } else {
      fab.removeAttribute('data-hidden');
      const h = SNAP_HEIGHTS[snap] || 96;
      fab.style.bottom = (h + 16) + 'px';
    }
  }

  // ──────────────── Sheet tabs proxy ────────────────
  function wireSheetTabs() {
    const tabs = $$('#mTabs .m-tab');
    if (!tabs.length) return;
    tabs.forEach((t) => {
      t.addEventListener('click', () => {
        const slug = t.dataset.mtab;
        const realTab = $('#' + slug + 'Tab');
        if (realTab) realTab.click();
      });
    });
    // Mirror active state from the existing .tab-bar
    function syncActive() {
      const active = $('.tab-bar .tab-btn.active');
      const slug = active && active.dataset && active.dataset.tab;
      tabs.forEach((t) => t.classList.toggle('active', t.dataset.mtab === slug));
    }
    const realBar = $('.tab-bar');
    if (realBar) {
      new MutationObserver(syncActive).observe(realBar, {
        subtree: true, attributes: true, attributeFilter: ['class'],
      });
    }
    syncActive();
  }

  // ──────────────── Mirror real data into the sheet ────────────────
  // The existing fullpage.js writes into specific elements. We read those
  // and reflect them into the sheet's m-* nodes. Pure visual layer.
  function pickText(sel) {
    const el = $(sel);
    return (el && el.textContent || '').trim();
  }
  function isPlaceholder(s) {
    return !s || s === '-' || s === '—' || /^select an author/i.test(s);
  }
  function fmtCount(s) {
    if (isPlaceholder(s)) return '—';
    return s;
  }
  function fmtAbbrev(s) {
    if (isPlaceholder(s)) return '0';
    const n = Number(String(s).replace(/[^\d.]/g, ''));
    if (!isFinite(n) || isNaN(n)) return s;
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function syncSheet() {
    if (!isMobile()) return;
    const sheet = $('#mobileSheet');
    if (!sheet) return;

    const name = pickText('#authorName');
    const papers = pickText('#paperCount');
    const cites = pickText('#citationCount');
    const h = pickText('#hIndex');
    const retracted = pickText('#retractionCount');

    const hasAuthor = !isPlaceholder(name);
    const displayName = hasAuthor ? name : 'Author Network';

    // Topbar centered title
    const topName = $('#mobileTopbarName');
    if (topName) topName.textContent = displayName;
    const topCluster = $('#mobileTopbarCluster');
    if (topCluster) topCluster.textContent = '';

    // Peek
    const peekName = $('#mPeekName');
    if (peekName) peekName.textContent = displayName;
    const peekStats = $('#mPeekStats');
    if (peekStats) {
      if (hasAuthor) {
        peekStats.hidden = false;
        $('#mPeekPapers').textContent  = (papers === '-' ? '—' : papers) + ' papers';
        $('#mPeekCites').textContent   = (fmtAbbrev(cites)) + ' cites';
        $('#mPeekH').textContent       = 'h=' + (h === '-' ? '—' : h);
      } else {
        peekStats.hidden = true;
      }
    }

    // Readout name + stats grid
    const roName = $('#mRoName');
    if (roName) roName.textContent = hasAuthor ? name : 'Select an author';

    const setStat = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    setStat('#mStatPapers',    fmtCount(papers));
    setStat('#mStatCites',     hasAuthor ? fmtAbbrev(cites) : '—');
    setStat('#mStatH',         fmtCount(h));
    setStat('#mStatRetracted', fmtCount(retracted));

    // Papers list — mirror children from #papersList
    syncPapersList();
    syncFavoriteState();
  }

  function syncPapersList() {
    const src = $('#papersList');
    const sec = $('#mSecPapers');
    const dst = $('#mPapersList');
    const count = $('#mPapersCount');
    if (!src || !dst || !sec) return;

    const items = $$('.paper-item', src);
    if (!items.length) {
      sec.hidden = true;
      return;
    }
    sec.hidden = false;
    if (count) count.textContent = String(items.length);

    // Cheap rebuild: only when item count or first title changes.
    const sig = items.length + '|' + (items[0].textContent || '').slice(0, 80);
    if (dst.dataset.sig === sig) return;
    dst.dataset.sig = sig;
    dst.textContent = '';

    items.slice(0, 12).forEach((src) => {
      const a = src.querySelector('.paper-title, a');
      const meta = src.querySelector('.paper-meta');
      const card = document.createElement('div');
      card.className = 'm-paper';
      const titleEl = document.createElement(a && a.tagName === 'A' ? 'a' : 'div');
      titleEl.className = 'm-paper-title';
      if (a && a.tagName === 'A') {
        titleEl.href = a.href;
        titleEl.target = '_blank';
        titleEl.rel = 'noreferrer';
      }
      titleEl.textContent = (a ? a.textContent : src.textContent).trim();
      card.appendChild(titleEl);
      if (meta) {
        const metaEl = document.createElement('div');
        metaEl.className = 'm-paper-meta mono';
        metaEl.textContent = meta.textContent.replace(/\s+/g, ' ').trim();
        card.appendChild(metaEl);
      }
      dst.appendChild(card);
    });
  }

  function syncFavoriteState() {
    // Reflect the existing #favoriteBtn state on the sheet's star.
    const src = $('#favoriteBtn');
    const dst = $('#mRoFav');
    if (!src || !dst) return;
    const txt = (src.textContent || '').trim();
    const isFav = txt === '★' || src.classList.contains('active');
    dst.classList.toggle('active', isFav);
  }

  function wireFavoriteProxy() {
    const dst = $('#mRoFav');
    if (!dst) return;
    dst.addEventListener('click', (e) => {
      e.stopPropagation();
      const src = $('#favoriteBtn');
      if (src) src.click();
      setTimeout(syncFavoriteState, 50);
    });
  }

  function startMirror() {
    const targets = [
      '#authorName', '#paperCount', '#citationCount', '#hIndex',
      '#retractionCount', '#favoriteBtn', '#papersList',
    ].map((s) => $(s)).filter(Boolean);

    const obs = new MutationObserver(() => syncSheet());
    targets.forEach((t) => obs.observe(t, {
      childList: true, characterData: true, subtree: true,
      attributes: true, attributeFilter: ['class', 'href'],
    }));
    syncSheet();
  }

  // ──────────────── Init ────────────────
  function init() {
    wireSheet();
    wireSheetTabs();
    wireLeftPanel();
    wireFavoriteProxy();

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

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setOverlayOpen(false);
    });

    wireSearchOverlay();

    window.addEventListener('resize', updateFabPosition);
    updateFabPosition();
    startMirror();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
