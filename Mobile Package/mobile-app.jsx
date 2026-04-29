// Mobile redesign of Author Network Explorer.
// Single screen: full-bleed graph + bottom sheet readout + side drawer.

const { useState, useEffect, useRef } = React;

const MOBILE_DATA = window.ANE_DATA;

// --- Bottom sheet with 3 snap points -------------------------------------
function BottomSheet({ snap, setSnap, children }) {
  const startY = useRef(null);
  const startSnap = useRef(null);
  const HEIGHTS = { peek: 96, half: 380, full: 720 };
  const h = HEIGHTS[snap];

  function onTouchStart(e) {
    startY.current = (e.touches?.[0] || e).clientY;
    startSnap.current = snap;
  }
  function onTouchEnd(e) {
    if (startY.current == null) return;
    const endY = (e.changedTouches?.[0] || e).clientY;
    const dy = startY.current - endY;
    const order = ["peek", "half", "full"];
    let i = order.indexOf(startSnap.current);
    if (dy > 50) i = Math.min(2, i + 1);
    if (dy < -50) i = Math.max(0, i - 1);
    setSnap(order[i]);
    startY.current = null;
  }

  return (
    <div
      className="m-sheet"
      style={{ height: h }}
      onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
      onMouseDown={onTouchStart} onMouseUp={onTouchEnd}
    >
      <div className="m-sheet-handle" />
      <div className="m-sheet-content">{children}</div>
    </div>
  );
}

function MobileApp() {
  const [selectedId, setSelectedId] = useState("a01");
  const [snap, setSnap] = useState("half");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [tab, setTab] = useState("authors");

  const author = MOBILE_DATA.AUTHORS.find((a) => a.id === selectedId);
  const cluster = MOBILE_DATA.CLUSTERS.find((c) => c.id === author?.cluster);
  const clusterCol = window.ANE_clusterColor
    ? window.ANE_clusterColor(author?.cluster ?? 0, 60, { L: 0.74, C: 0.10 })
    : "var(--accent)";

  // Coauthors
  const coauthors = author ? (() => {
    const list = [];
    MOBILE_DATA.EDGES.forEach((e) => {
      if (e.s === author.id) list.push({ id: e.t, w: e.w });
      else if (e.t === author.id) list.push({ id: e.s, w: e.w });
    });
    return list.sort((a, b) => b.w - a.w).slice(0, 8).map((x) => ({
      ...MOBILE_DATA.AUTHORS.find((a) => a.id === x.id), w: x.w,
    }));
  })() : [];

  // Search hits
  const hits = !searchQuery.trim()
    ? MOBILE_DATA.SEARCH_SAMPLE.slice(0, 8)
    : MOBILE_DATA.AUTHORS.filter((a) =>
        a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        a.affiliation.toLowerCase().includes(searchQuery.toLowerCase())
      ).slice(0, 8);

  return (
    <div className="m-root">
      {/* Top bar */}
      <div className="m-topbar">
        <button className="m-icon-btn" onClick={() => setDrawerOpen(true)}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <line x1="3" y1="5" x2="15" y2="5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <line x1="3" y1="9" x2="15" y2="9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <line x1="3" y1="13" x2="15" y2="13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        <div className="m-topbar-title">
          <div className="m-topbar-cluster mono" style={{ color: clusterCol }}>
            ● {cluster?.label || "—"}
          </div>
          <div className="m-topbar-name">{author?.name || "Author Network"}</div>
        </div>
        <button className="m-icon-btn" onClick={() => alert("More")}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <circle cx="4" cy="9" r="1.5" fill="currentColor" />
            <circle cx="9" cy="9" r="1.5" fill="currentColor" />
            <circle cx="14" cy="9" r="1.5" fill="currentColor" />
          </svg>
        </button>
      </div>

      {/* Full-bleed graph */}
      <div className="m-canvas">
        <NetworkGraph
          data={MOBILE_DATA}
          selectedId={selectedId}
          onSelect={(id) => { setSelectedId(id); setSnap("half"); }}
          hoveredId={null}
          onHover={() => {}}
          accentHue={60}
          nodeStyle="outlined"
          showLabels={true}
          useColor={true}
          edgeOpacity={0.5}
          highlightPath={null}
          centerFocus={true}
        />
      </div>

      {/* Floating search FAB (above sheet) */}
      <button
        className="m-fab"
        style={{ bottom: snap === "peek" ? 116 : (snap === "half" ? 400 : 0), opacity: snap === "full" ? 0 : 1 }}
        onClick={() => setSearchOpen(true)}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.6" />
          <line x1="12" y1="12" x2="15.5" y2="15.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>

      {/* Bottom sheet */}
      <BottomSheet snap={snap} setSnap={setSnap}>
        {/* Peek state: minimal */}
        {snap === "peek" && author && (
          <div className="m-peek">
            <div className="m-peek-name">{author.name}</div>
            <div className="m-peek-stats mono">
              <span>{author.papers} papers</span>
              <span className="m-peek-dot">·</span>
              <span>{(author.citations / 1000).toFixed(1)}k cites</span>
              <span className="m-peek-dot">·</span>
              <span>h={author.h}</span>
            </div>
          </div>
        )}

        {/* Half + Full: real readout */}
        {snap !== "peek" && author && (
          <div className="m-readout">
            <div className="m-tabs">
              <button className={"m-tab" + (tab === "authors" ? " active" : "")} onClick={() => setTab("authors")}>Authors</button>
              <button className={"m-tab" + (tab === "collections" ? " active" : "")} onClick={() => setTab("collections")}>Collections</button>
              <button className={"m-tab" + (tab === "fields" ? " active" : "")} onClick={() => setTab("fields")}>Fields</button>
            </div>

            <div className="m-ro-head">
              <div>
                <div className="m-ro-cluster mono" style={{ color: clusterCol }}>
                  {author.id.toUpperCase()} · cluster {author.cluster}
                </div>
                <div className="m-ro-name">{author.name}</div>
                <div className="m-ro-aff">{author.affiliation}</div>
              </div>
              <button className="m-ro-fav">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path d="M10 3 L12.2 7.5 L17 8 L13.4 11.5 L14.5 16 L10 13.5 L5.5 16 L6.6 11.5 L3 8 L7.8 7.5 Z"
                        stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                </svg>
              </button>
            </div>

            <div className="m-topics">
              {author.topics.map((t) => (
                <span key={t} className="m-topic" style={{ color: clusterCol, borderColor: clusterCol }}>{t}</span>
              ))}
            </div>

            <div className="m-stats">
              <div className="m-stat"><div className="m-stat-v mono">{author.papers}</div><div className="m-stat-l">papers</div></div>
              <div className="m-stat"><div className="m-stat-v mono accent">{(author.citations / 1000).toFixed(1)}k</div><div className="m-stat-l">citations</div></div>
              <div className="m-stat"><div className="m-stat-v mono">{author.h}</div><div className="m-stat-l">h-index</div></div>
              <div className="m-stat"><div className="m-stat-v mono">{(author.repeatRate * 100).toFixed(0)}%</div><div className="m-stat-l">repeat</div></div>
            </div>

            <div className="m-section">
              <div className="m-section-h">
                <span>Top coauthors</span>
                <span className="mono">{coauthors.length}</span>
              </div>
              {coauthors.slice(0, snap === "full" ? 8 : 4).map((c) => (
                <button key={c.id} className="m-coauthor"
                        onClick={() => setSelectedId(c.id)}>
                  <span className="m-coauthor-dot" style={{
                    borderColor: window.ANE_clusterColor(c.cluster, 60),
                    background: window.ANE_clusterColor(c.cluster, 60) + " 20"
                  }} />
                  <div className="m-coauthor-main">
                    <div className="m-coauthor-name">{c.name}</div>
                    <div className="m-coauthor-aff">{c.affiliation}</div>
                  </div>
                  <div className="m-coauthor-w mono">{c.w}</div>
                </button>
              ))}
            </div>

            {snap === "full" && (
              <div className="m-section">
                <div className="m-section-h"><span>Recent papers</span><span className="mono">{MOBILE_DATA.RECENT_PAPERS.length}</span></div>
                {MOBILE_DATA.RECENT_PAPERS.slice(0, 4).map((p, i) => (
                  <div key={i} className="m-paper">
                    <div className="m-paper-title">{p.title}</div>
                    <div className="m-paper-meta mono">
                      <span>{p.venue}</span><span>·</span><span>{p.year}</span><span>·</span><span>{p.cites} cites</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </BottomSheet>

      {/* Side drawer */}
      {drawerOpen && (
        <>
          <div className="m-scrim" onClick={() => setDrawerOpen(false)} />
          <div className="m-drawer">
            <div className="m-drawer-head">
              <div className="m-drawer-brand">
                <div className="m-drawer-mark">
                  <svg width="20" height="20" viewBox="0 0 22 22" fill="none">
                    <circle cx="4"  cy="11" r="2.4" stroke="currentColor" strokeWidth="1.2" />
                    <circle cx="18" cy="5"  r="2.4" stroke="currentColor" strokeWidth="1.2" />
                    <circle cx="18" cy="17" r="2.4" stroke="currentColor" strokeWidth="1.2" />
                    <line x1="6.2" y1="10.2" x2="15.8" y2="5.8"  stroke="currentColor" strokeWidth="1" />
                    <line x1="6.2" y1="11.8" x2="15.8" y2="16.2" stroke="currentColor" strokeWidth="1" />
                  </svg>
                </div>
                <div>
                  <div className="m-drawer-title">A. N. E.</div>
                  <div className="m-drawer-sub mono">v0.4 · OpenAlex</div>
                </div>
              </div>
              <button className="m-icon-btn" onClick={() => setDrawerOpen(false)}>×</button>
            </div>

            <div className="m-drawer-section">
              <div className="m-drawer-h">
                <span>New papers</span>
                <span className="mono m-drawer-badge">3</span>
              </div>
              <div className="m-drawer-paper">
                <div className="m-drawer-paper-title">Calibration of dense retrievers under distribution shift</div>
                <div className="m-drawer-paper-meta mono">M. Aritz Bilbao · SIGIR · 3d</div>
              </div>
              <div className="m-drawer-paper">
                <div className="m-drawer-paper-title">Cross-lingual ranking without parallel supervision</div>
                <div className="m-drawer-paper-meta mono">Chiamaka Okeke · ACL · 5d</div>
              </div>
            </div>

            <div className="m-drawer-section">
              <div className="m-drawer-h"><span>Favorites</span></div>
              {["a01", "a06", "a02"].map((id) => {
                const a = MOBILE_DATA.AUTHORS.find((x) => x.id === id);
                return (
                  <button key={id} className="m-drawer-fav"
                          onClick={() => { setSelectedId(id); setDrawerOpen(false); }}>
                    <span className="m-drawer-fav-dot" style={{ borderColor: window.ANE_clusterColor(a.cluster, 60) }} />
                    <div className="m-drawer-fav-main">
                      <div className="m-drawer-fav-name">{a.name}</div>
                      <div className="m-drawer-fav-aff">{a.affiliation}</div>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="m-drawer-section">
              <div className="m-drawer-h"><span>Collections</span><span className="mono">3</span></div>
              {["Retrieval evaluation", "Low-resource MT", "Search UX studies"].map((n, i) => (
                <button key={n} className="m-drawer-coll">
                  <span className="m-drawer-coll-dot" style={{ background: ["oklch(0.74 0.12 220)", "oklch(0.74 0.12 35)", "oklch(0.74 0.12 295)"][i] }} />
                  <span>{n}</span>
                  <span className="mono m-drawer-coll-c">{[12, 8, 5][i]}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Search overlay */}
      {searchOpen && (
        <div className="m-search-overlay">
          <div className="m-search-bar">
            <button className="m-icon-btn" onClick={() => setSearchOpen(false)}>
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <line x1="12" y1="4" x2="5" y2="9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                <line x1="5" y1="9" x2="12" y2="14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
            <input
              autoFocus
              placeholder="Search any researcher…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="m-search-results">
            <div className="m-search-section-h mono">{!searchQuery ? "RECENT" : "RESULTS"}</div>
            {hits.map((a) => (
              <button key={a.id} className="m-search-row"
                      onClick={() => { setSelectedId(a.id); setSearchOpen(false); setSnap("half"); setSearchQuery(""); }}>
                <span className="m-search-dot" style={{ borderColor: window.ANE_clusterColor(MOBILE_DATA.AUTHORS.find(x => x.id === a.id)?.cluster ?? 1, 60) }} />
                <div className="m-search-main">
                  <div className="m-search-name">{a.name}</div>
                  <div className="m-search-aff">{a.affiliation}</div>
                </div>
                <div className="m-search-stat mono">{(a.citations / 1000).toFixed(1)}k</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

window.MobileApp = MobileApp;
