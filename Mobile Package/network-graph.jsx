// Outlined-node graph: SVG-rendered, simple force layout, calm-modernist aesthetic.
// Node = circle with stroke; size scales with citations; selected = filled.
// Edge = thin line with opacity proportional to coauthorship weight.

const { useEffect, useRef, useState, useMemo } = React;

// --- Force-directed layout (deterministic seed) ---------------------------
function layoutGraph(nodes, edges, opts = {}) {
  const W = opts.width || 1200;
  const H = opts.height || 800;
  const iters = opts.iters || 380;

  // Seeded RNG so layout is stable across reloads
  let seed = 7;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };

  // --- Compute cluster centers in a ring around the central node ---------
  const clusterIds = [...new Set(nodes.map(n => n.cluster).filter(c => c != null && c !== 0))];
  clusterIds.sort();
  const clusterCenter = {};
  // Cluster 0 (or central) sits in the middle
  clusterCenter[0] = { x: W / 2, y: H / 2 };
  const ringR = Math.min(W, H) * 0.32;
  clusterIds.forEach((cid, i) => {
    const ang = (i / clusterIds.length) * Math.PI * 2 - Math.PI / 2;
    clusterCenter[cid] = {
      x: W / 2 + Math.cos(ang) * ringR,
      y: H / 2 + Math.sin(ang) * ringR,
    };
  });

  const pos = {};
  nodes.forEach((n) => {
    // Seed each node near its cluster center so layout converges cleanly
    const c = clusterCenter[n.cluster] || clusterCenter[0];
    pos[n.id] = {
      x: c.x + (rand() - 0.5) * 60,
      y: c.y + (rand() - 0.5) * 60,
      vx: 0, vy: 0,
    };
  });

  // Pin central node near middle
  const central = nodes.find((n) => n.central);
  if (central) {
    pos[central.id].x = W / 2;
    pos[central.id].y = H / 2;
  }

  const adj = {};
  edges.forEach((e) => {
    (adj[e.s] = adj[e.s] || []).push({ id: e.t, w: e.w });
    (adj[e.t] = adj[e.t] || []).push({ id: e.s, w: e.w });
  });

  const k = 110;          // ideal edge length
  const repulsion = 9000;
  const damping = 0.82;

  for (let it = 0; it < iters; it++) {
    const t = 1 - it / iters;
    // Repulsion (all pairs)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = pos[nodes[i].id], b = pos[nodes[j].id];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy + 0.01;
        let d = Math.sqrt(d2);
        // Inter-cluster pairs repel harder so clusters stay separated
        const sameCluster = nodes[i].cluster === nodes[j].cluster;
        const f = (repulsion * (sameCluster ? 1 : 1.6)) / d2;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }
    // Spring (edges)
    edges.forEach((e) => {
      const a = pos[e.s], b = pos[e.t];
      let dx = b.x - a.x, dy = b.y - a.y;
      let d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const idealLen = k * (1 - Math.min(0.6, e.w / 40)); // strong ties pull closer
      const f = (d - idealLen) * 0.06 * Math.min(2.0, 0.4 + e.w / 12);
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    });
    // Cluster gravity — each node pulled toward its cluster's center
    nodes.forEach((n) => {
      const p = pos[n.id];
      const c = clusterCenter[n.cluster] || clusterCenter[0];
      p.vx += (c.x - p.x) * 0.012;
      p.vy += (c.y - p.y) * 0.012;
    });
    // Center gravity (weaker — cluster gravity does most of the work)
    nodes.forEach((n) => {
      const p = pos[n.id];
      p.vx += (W / 2 - p.x) * 0.0008;
      p.vy += (H / 2 - p.y) * 0.0008;
    });
    // Integrate
    nodes.forEach((n) => {
      if (n.central) { pos[n.id].vx = 0; pos[n.id].vy = 0; return; }
      const p = pos[n.id];
      p.vx *= damping; p.vy *= damping;
      // Cooling
      const speed = Math.min(8 * t + 1, 12);
      const v = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      if (v > speed) { p.vx = (p.vx / v) * speed; p.vy = (p.vy / v) * speed; }
      p.x += p.vx; p.y += p.vy;
    });
  }

  return pos;
}

// --- Cluster colors — desaturated jewel tones, same L/C, hue rotates -----
const CLUSTER_HUES = { 0: null /* accent */, 1: 220, 2: 35, 3: 160, 4: 295, 5: 5 };
function clusterColor(cluster, accentHue, opts = {}) {
  const { L = 0.72, C = 0.10 } = opts;
  if (cluster === 0) return `oklch(${L} ${C + 0.04} ${accentHue})`;
  const h = CLUSTER_HUES[cluster] ?? 220;
  return `oklch(${L} ${C} ${h})`;
}
function clusterStroke(cluster, accentHue, useColor) {
  if (!useColor) return "var(--fg-2)";
  return clusterColor(cluster, accentHue);
}
window.ANE_clusterColor = clusterColor;

// --- Component ------------------------------------------------------------
function NetworkGraph({
  data,
  selectedId,
  onSelect,
  hoveredId,
  onHover,
  accentHue = 60,
  nodeStyle = "outlined",   // outlined | filled | constellation
  showLabels = true,
  useColor = false,
  edgeOpacity = 0.55,
  highlightPath = null,     // [id, id, id, ...] for path-finder mode
  centerFocus = false,      // if true: alpha + label visibility falls off from viewBox center
}) {
  const svgRef = useRef(null);
  const [vb, setVb] = useState({ x: 0, y: 0, w: 1200, h: 800 });
  const [dragging, setDragging] = useState(null);
  // Track on-screen rect so focal alpha can use real screen-pixel distance.
  const [rect, setRect] = useState({ w: 1, h: 1 });
  useEffect(() => {
    if (!svgRef.current) return;
    const ro = new ResizeObserver(() => {
      const r = svgRef.current.getBoundingClientRect();
      setRect({ w: r.width, h: r.height });
    });
    ro.observe(svgRef.current);
    const r = svgRef.current.getBoundingClientRect();
    setRect({ w: r.width, h: r.height });
    return () => ro.disconnect();
  }, []);

  const basePositions = useMemo(
    () => layoutGraph(data.AUTHORS, data.EDGES, { width: 1200, height: 800 }),
    [data]
  );
  // User-applied per-cluster offsets — drag any node in a cluster to translate the whole cluster.
  const [clusterOffsets, setClusterOffsets] = useState({});
  const clusterOffsetsRef = useRef(clusterOffsets);
  clusterOffsetsRef.current = clusterOffsets;

  // Final positions = base + cluster offset
  const positions = useMemo(() => {
    const out = {};
    for (const n of data.AUTHORS) {
      const bp = basePositions[n.id];
      if (!bp) continue;
      const off = clusterOffsets[n.cluster] || { dx: 0, dy: 0 };
      out[n.id] = { x: bp.x + off.dx, y: bp.y + off.dy };
    }
    return out;
  }, [basePositions, clusterOffsets, data]);

  // Reset cluster offsets when the dataset changes
  useEffect(() => { setClusterOffsets({}); }, [data]);

  // Build adjacency for hover-fade
  const adjSet = useMemo(() => {
    const m = {};
    data.EDGES.forEach((e) => {
      (m[e.s] = m[e.s] || new Set()).add(e.t);
      (m[e.t] = m[e.t] || new Set()).add(e.s);
    });
    return m;
  }, [data]);

  // When centerFocus is on, viewport center governs label alpha — selecting a node
  // shouldn't fade everything. Only hover triggers adjacency dimming.
  const focusId = centerFocus ? hoveredId : (hoveredId || selectedId);
  const isAdjacent = (id) =>
    !focusId || id === focusId || (adjSet[focusId] && adjSet[focusId].has(id));

  // Pan/zoom + cluster drag.
  // When the mouse/touch goes down on a node, dragging moves that node's whole CLUSTER.
  // When it goes down on the background, dragging pans the viewport.
  function eventClusterFromTarget(target) {
    const g = target.closest && target.closest("g[data-cluster]");
    if (!g) return null;
    const c = g.getAttribute("data-cluster");
    return c == null ? null : Number(c);
  }
  function onWheel(e) {
    e.preventDefault();
    const scale = e.deltaY > 0 ? 1.12 : 1 / 1.12;
    const rect = svgRef.current.getBoundingClientRect();
    const mx = vb.x + ((e.clientX - rect.left) / rect.width) * vb.w;
    const my = vb.y + ((e.clientY - rect.top) / rect.height) * vb.h;
    const nw = Math.max(300, Math.min(3000, vb.w * scale));
    const nh = Math.max(200, Math.min(2000, vb.h * scale));
    setVb({
      x: mx - ((e.clientX - rect.left) / rect.width) * nw,
      y: my - ((e.clientY - rect.top) / rect.height) * nh,
      w: nw, h: nh
    });
  }
  function onMouseDown(e) {
    const cluster = eventClusterFromTarget(e.target);
    if (cluster != null) {
      const cur = clusterOffsetsRef.current[cluster] || { dx: 0, dy: 0 };
      setDragging({ kind: "cluster", cluster, x: e.clientX, y: e.clientY, startOffset: cur, vb });
      return;
    }
    setDragging({ kind: "pan", x: e.clientX, y: e.clientY, vb });
  }
  function onMouseMove(e) {
    if (!dragging) return;
    const rect = svgRef.current.getBoundingClientRect();
    const dx = ((e.clientX - dragging.x) / rect.width) * dragging.vb.w;
    const dy = ((e.clientY - dragging.y) / rect.height) * dragging.vb.h;
    if (dragging.kind === "cluster") {
      // Suppress click after a real drag
      if (Math.abs(e.clientX - dragging.x) + Math.abs(e.clientY - dragging.y) > 4) {
        dragging.moved = true;
      }
      setClusterOffsets((prev) => ({
        ...prev,
        [dragging.cluster]: {
          dx: dragging.startOffset.dx + dx,
          dy: dragging.startOffset.dy + dy,
        },
      }));
      return;
    }
    setVb({ x: dragging.vb.x - dx, y: dragging.vb.y - dy, w: dragging.vb.w, h: dragging.vb.h });
  }
  function onMouseUp() { setDragging(null); }

  // Touch: 1 finger pans (or drags a cluster if started on a node), 2 fingers pinch-zoom.
  const [touchState, setTouchState] = useState(null);
  function onTouchStart(e) {
    if (e.touches.length === 1) {
      const cluster = eventClusterFromTarget(e.target);
      if (cluster != null) {
        const cur = clusterOffsetsRef.current[cluster] || { dx: 0, dy: 0 };
        setTouchState({
          kind: "clusterDrag", cluster,
          x: e.touches[0].clientX, y: e.touches[0].clientY,
          startOffset: cur, vb,
        });
        return;
      }
      setTouchState({ kind: "pan", x: e.touches[0].clientX, y: e.touches[0].clientY, vb });
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      setTouchState({ kind: "pinch", dist, cx, cy, vb });
    }
  }
  function onTouchMove(e) {
    if (!touchState) return;
    e.preventDefault();
    const rect = svgRef.current.getBoundingClientRect();
    if (touchState.kind === "clusterDrag" && e.touches.length === 1) {
      const dx = ((e.touches[0].clientX - touchState.x) / rect.width) * touchState.vb.w;
      const dy = ((e.touches[0].clientY - touchState.y) / rect.height) * touchState.vb.h;
      if (Math.abs(e.touches[0].clientX - touchState.x) + Math.abs(e.touches[0].clientY - touchState.y) > 4) {
        touchState.moved = true;
      }
      setClusterOffsets((prev) => ({
        ...prev,
        [touchState.cluster]: {
          dx: touchState.startOffset.dx + dx,
          dy: touchState.startOffset.dy + dy,
        },
      }));
    } else if (touchState.kind === "pan" && e.touches.length === 1) {
      const dx = ((e.touches[0].clientX - touchState.x) / rect.width) * touchState.vb.w;
      const dy = ((e.touches[0].clientY - touchState.y) / rect.height) * touchState.vb.h;
      setVb({ x: touchState.vb.x - dx, y: touchState.vb.y - dy, w: touchState.vb.w, h: touchState.vb.h });
    } else if (touchState.kind === "pinch" && e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const scale = touchState.dist / dist;
      const nw = Math.max(300, Math.min(3000, touchState.vb.w * scale));
      const nh = Math.max(200, Math.min(2000, touchState.vb.h * scale));
      const mx = touchState.vb.x + ((touchState.cx - rect.left) / rect.width) * touchState.vb.w;
      const my = touchState.vb.y + ((touchState.cy - rect.top) / rect.height) * touchState.vb.h;
      setVb({
        x: mx - ((touchState.cx - rect.left) / rect.width) * nw,
        y: my - ((touchState.cy - rect.top) / rect.height) * nh,
        w: nw, h: nh,
      });
    }
  }
  function onTouchEnd() { setTouchState(null); }

  function nodeRadius(n) {
    // sqrt scale to keep big authors from dominating
    const r = 4 + Math.sqrt(n.citations) / 6;
    return Math.min(28, Math.max(5, r));
  }

  // Path highlight set
  const pathSet = highlightPath ? new Set(highlightPath) : null;
  const pathEdgeSet = new Set();
  if (highlightPath) {
    for (let i = 0; i < highlightPath.length - 1; i++) {
      pathEdgeSet.add(`${highlightPath[i]}|${highlightPath[i + 1]}`);
      pathEdgeSet.add(`${highlightPath[i + 1]}|${highlightPath[i]}`);
    }
  }

  return (
    <svg
      ref={svgRef}
      className="ane-graph"
      viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
      preserveAspectRatio="xMidYMid meet"
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
      style={{ cursor: dragging ? "grabbing" : "grab", touchAction: "none" }}
    >
      <defs>
        <radialGradient id="haloGrad">
          <stop offset="0%"   stopColor={`oklch(0.78 0.14 ${accentHue})`} stopOpacity="0.35" />
          <stop offset="100%" stopColor={`oklch(0.78 0.14 ${accentHue})`} stopOpacity="0" />
        </radialGradient>
        <pattern id="gridDots" width="40" height="40" patternUnits="userSpaceOnUse">
          <circle cx="0.5" cy="0.5" r="0.5" fill="var(--fg-3)" opacity="0.4" />
        </pattern>
      </defs>

      <rect className="graph-bg" x={vb.x - 100} y={vb.y - 100} width={vb.w + 200} height={vb.h + 200} fill="url(#gridDots)" />

      {/* Edges */}
      <g className="edges">
        {data.EDGES.map((e, i) => {
          const a = positions[e.s], b = positions[e.t];
          if (!a || !b) return null;
          const nodeS = data.AUTHORS.find(x => x.id === e.s);
          const nodeT = data.AUTHORS.find(x => x.id === e.t);
          const inFocus = !focusId || e.s === focusId || e.t === focusId;
          const onPath = pathEdgeSet.has(`${e.s}|${e.t}`);
          const w = 0.4 + Math.min(2.0, e.w / 14);
          let opacity = inFocus ? edgeOpacity : edgeOpacity * 0.18;
          if (pathSet && !onPath) opacity = 0.06;
          if (onPath) opacity = 0.95;
          // Same-cluster edges get the cluster color (when color is on),
          // cross-cluster stays neutral grey.
          let stroke = "var(--fg-3)";
          if (onPath) {
            stroke = `oklch(0.78 0.14 ${accentHue})`;
          } else if (useColor && nodeS && nodeT && nodeS.cluster === nodeT.cluster && nodeS.cluster !== 0) {
            stroke = clusterColor(nodeS.cluster, accentHue, { L: 0.55, C: 0.08 });
          } else if (useColor && (nodeS?.central || nodeT?.central)) {
            // Edges from central — accent-tinted
            stroke = `oklch(0.55 0.10 ${accentHue})`;
          }
          return (
            <line key={i}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={stroke}
              strokeWidth={onPath ? Math.max(1.4, w) : w}
              opacity={opacity}
            />
          );
        })}
      </g>

      {/* Nodes (circles only — labels are in a top layer below so they always render on top) */}
      <g className="nodes">
        {data.AUTHORS.map((n) => {
          const p = positions[n.id];
          if (!p) return null;
          const r = nodeRadius(n);
          const isSelected = n.id === selectedId;
          const isHovered  = n.id === hoveredId;
          const isFaded    = !centerFocus && focusId && !isAdjacent(n.id);
          const inPath     = pathSet && pathSet.has(n.id);
          const dimmed     = (pathSet && !inPath) || isFaded;

          const stroke = clusterStroke(n.cluster, accentHue, useColor);
          const accent = `oklch(0.78 0.14 ${accentHue})`;
          const fill =
            nodeStyle === "filled"
              ? (n.central || isSelected ? accent : "var(--fg-2)")
              : (isSelected ? accent : (n.central ? "var(--surf-1)" : "var(--surf-0)"));
          const strokeColor = (isSelected || n.central || inPath) ? accent : stroke;
          const strokeW =
            isSelected || n.central ? 2.25 : (inPath ? 2.0 : (isHovered ? 1.8 : 1.25));

          return (
            <g key={n.id}
               data-cluster={n.cluster}
               transform={`translate(${p.x},${p.y})`}
               opacity={dimmed ? 0.22 : 1}
               style={{ cursor: "grab", transition: "opacity 0.15s" }}
               onMouseEnter={() => onHover(n.id)}
               onMouseLeave={() => onHover(null)}
               onClick={(e) => {
                 // Suppress click if the user just dragged the cluster.
                 if ((dragging && dragging.moved) || (touchState && touchState.moved)) return;
                 e.stopPropagation();
                 onSelect(n.id);
               }}
            >
              {nodeStyle === "constellation" && (
                <circle r={r * 2.4} fill="url(#haloGrad)" />
              )}
              {(isSelected || n.central) && nodeStyle !== "constellation" && (
                <circle r={r + 4} fill="none" stroke={accent} strokeWidth="0.6" opacity="0.5" />
              )}
              <circle r={r} fill={fill} stroke={strokeColor} strokeWidth={strokeW} />

              {/* Inner dot for central */}
              {n.central && nodeStyle !== "constellation" && (
                <circle r={2.5} fill={accent} />
              )}
            </g>
          );
        })}
      </g>

      {/* Labels — rendered AFTER nodes so they sit on top of every circle and edge */}
      <g className="labels" style={{ pointerEvents: "none" }}>
        {data.AUTHORS.map((n) => {
          if (!showLabels) return null;
          const p = positions[n.id];
          if (!p) return null;
          const r = nodeRadius(n);
          const isSelected = n.id === selectedId;
          const isHovered  = n.id === hoveredId;
          if (!(isSelected || isHovered || n.central || r > 5)) return null;

          const isFaded = !centerFocus && focusId && !isAdjacent(n.id);
          const inPath  = pathSet && pathSet.has(n.id);
          const dimmed  = (pathSet && !inPath) || isFaded;

          // Label alpha based on REAL on-screen pixel distance to viewport center.
          let focalAlpha = 1;
          if (centerFocus) {
            const cx = vb.x + vb.w / 2;
            const cy = vb.y + vb.h / 2;
            const pxScale = Math.min(rect.w / vb.w, rect.h / vb.h);
            const dxPx = (p.x - cx) * pxScale;
            const dyPx = (p.y - cy) * pxScale;
            const distPx = Math.sqrt(dxPx * dxPx + dyPx * dyPx);
            const halfDiagPx = Math.sqrt(rect.w * rect.w + rect.h * rect.h) / 2;
            const t = Math.min(1, distPx / halfDiagPx);
            focalAlpha = Math.max(0, 1 - Math.pow(t, 0.6));
          }

          const baseOpacity = (isSelected || isHovered || n.central) ? 1 : focalAlpha;
          const finalOpacity = dimmed ? baseOpacity * 0.22 : baseOpacity;

          return (
            <text
              key={n.id}
              x={p.x + r + 6}
              y={p.y + 4}
              fontSize={Math.max(9, Math.min(13, r * 0.7))}
              fill={isSelected || n.central ? "var(--fg-0)" : "var(--fg-1)"}
              opacity={finalOpacity}
              style={{
                fontFamily: "var(--font-sans)",
                fontWeight: isSelected ? 500 : 400,
                pointerEvents: "none",
                paintOrder: "stroke",
                stroke: "var(--bg)",
                strokeWidth: 3,
                strokeOpacity: 0.9,
                strokeLinejoin: "round",
                transition: "opacity 0.2s",
              }}
            >
              {n.name}
            </text>
          );
        })}
      </g>
    </svg>
  );
}

window.NetworkGraph = NetworkGraph;
