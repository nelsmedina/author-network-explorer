// Crossref API for Author Network Explorer fullpage
const CROSSREF_BASE = 'https://api.crossref.org';
const MAILTO = 'author-network-explorer@example.com';

// State
let network = null;
let nodes = new vis.DataSet();
let edges = new vis.DataSet();
let authorCache = new Map();
let selectedAuthorId = null;
let currentCentralAuthorId = null;
let currentPapersData = null;
let expandedNetworks = [];
let authorFilter = 'senior-first';
let favorites = [];
let clusterData = [];
let worker = null;

// DOM Elements
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const searchResults = document.getElementById('searchResults');
const loading = document.getElementById('loading');

// Cluster colors for visualization
const clusterColors = [
  '#00d4ff', '#ff6b35', '#a855f7', '#22c55e', '#f43f5e', '#eab308',
  '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#8b5cf6', '#14b8a6'
];

// ============================================
// Author ID Generation
// ============================================

function createAuthorId(author) {
  if (author.ORCID) {
    const orcid = author.ORCID.replace(/^https?:\/\/orcid\.org\//i, '');
    return `orcid:${orcid}`;
  }
  if (author.orcid) {
    return `orcid:${author.orcid}`;
  }
  const normalized = normalizeAuthorName(author.given, author.family);
  return `name:${normalized}`;
}

function normalizeAuthorName(given, family) {
  const normalize = (str) => {
    if (!str) return '';
    return str
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
  };

  const normalizedFamily = normalize(family) || 'unknown';
  const normalizedGiven = normalize(given) || '';

  return normalizedGiven ? `${normalizedFamily}-${normalizedGiven}` : normalizedFamily;
}

// Convert Crossref work to paper format
function workToPaper(work) {
  let year = null;
  if (work.published && work.published['date-parts'] && work.published['date-parts'][0]) {
    year = work.published['date-parts'][0][0];
  }

  return {
    doi: work.DOI,
    title: Array.isArray(work.title) ? work.title[0] : work.title,
    year,
    citationCount: work['is-referenced-by-count'] || 0,
    authors: (work.author || []).map(a => ({
      authorId: createAuthorId(a),
      name: a.given && a.family ? `${a.given} ${a.family}` : (a.name || a.family || 'Unknown'),
      orcid: a.ORCID ? a.ORCID.replace(/^https?:\/\/orcid\.org\//i, '') : null
    })),
    type: work.type,
    externalIds: { DOI: work.DOI }
  };
}

// ============================================
// Web Worker Initialization
// ============================================

function initWorker() {
  if (typeof Worker !== 'undefined') {
    try {
      worker = new Worker('network-worker.js');
      worker.onmessage = function(e) {
        console.log('Worker message:', e.data);
      };
      worker.onerror = function(e) {
        console.error('Worker error:', e);
      };
    } catch (error) {
      console.warn('Web Worker not available:', error);
    }
  }
}

// ============================================
// Network Visualization
// ============================================

function initNetwork() {
  const container = document.getElementById('network');
  if (!container) return;

  const options = {
    nodes: {
      shape: 'dot',
      scaling: { min: 10, max: 50, label: { enabled: true, min: 12, max: 24 } },
      font: { color: '#fff', size: 14 }
    },
    edges: {
      color: { color: '#333', highlight: '#4ecca3' },
      width: 1,
      smooth: { type: 'continuous' }
    },
    physics: {
      enabled: true,
      forceAtlas2Based: {
        gravitationalConstant: -60,
        centralGravity: 0.008,
        springLength: 100,
        springConstant: 0.06,
        damping: 0.5,
        avoidOverlap: 0.5
      },
      maxVelocity: 40,
      minVelocity: 0.5,
      solver: 'forceAtlas2Based',
      timestep: 0.35,
      stabilization: { enabled: true, iterations: 150 }
    },
    interaction: {
      hover: true,
      tooltipDelay: 200,
      dragView: true,
      zoomView: true,
      zoomSpeed: 0.8,
      dragNodes: true
    }
  };

  network = new vis.Network(container, { nodes, edges }, options);

  network.on('stabilized', () => {
    network.setOptions({ physics: { enabled: false } });
  });

  network.on('click', (params) => {
    if (params.nodes.length > 0) {
      selectAuthor(params.nodes[0]);
    }
  });

  network.on('doubleClick', (params) => {
    if (params.nodes.length > 0) {
      expandNetwork(params.nodes[0]);
    }
  });
}

// ============================================
// Search Authors using Crossref
// ============================================

async function searchAuthors(query) {
  if (!query.trim()) return;

  const limitSelect = document.getElementById('limitSelect');
  const limit = limitSelect ? limitSelect.value : 100;

  searchResults.innerHTML = '<div class="search-result">Searching...</div>';
  searchResults.classList.add('visible');

  try {
    const url = `${CROSSREF_BASE}/works?mailto=${MAILTO}&query.author=${encodeURIComponent(query)}&rows=${limit}&select=DOI,title,author,published,is-referenced-by-count`;

    const response = await fetch(url);

    if (!response.ok) {
      searchResults.innerHTML = `<div class="search-result" style="color: #ef4444;">API error (${response.status})</div>`;
      return;
    }

    const data = await response.json();
    const works = data.message?.items || [];

    // Extract unique authors
    const authorsMap = new Map();
    works.forEach(work => {
      if (!work.author) return;

      work.author.forEach(author => {
        const authorId = createAuthorId(author);
        const displayName = author.given && author.family
          ? `${author.given} ${author.family}`
          : author.name || author.family || 'Unknown';

        if (authorsMap.has(authorId)) {
          const existing = authorsMap.get(authorId);
          existing.paperCount++;
          existing.citationCount += work['is-referenced-by-count'] || 0;
        } else {
          authorsMap.set(authorId, {
            authorId,
            name: displayName,
            given: author.given || '',
            family: author.family || '',
            orcid: author.ORCID ? author.ORCID.replace(/^https?:\/\/orcid\.org\//i, '') : null,
            isVerified: !!author.ORCID,
            paperCount: 1,
            citationCount: work['is-referenced-by-count'] || 0,
            searchQuery: query
          });
        }
      });
    });

    const authors = Array.from(authorsMap.values())
      .filter(a => a.paperCount >= 1)
      .sort((a, b) => b.paperCount - a.paperCount || b.citationCount - a.citationCount);

    if (authors.length > 0) {
      searchResults.innerHTML = `
        <div class="combine-bar" id="combineBar" style="display: none;">
          <span class="combine-count"><span id="selectedCount">0</span> selected</span>
          <button class="combine-btn" id="combineBtn">Combine</button>
        </div>
        ${authors.map(author => `
          <div class="search-result" data-id="${author.authorId}">
            <input type="checkbox" class="author-checkbox" data-id="${author.authorId}" data-name="${author.name}">
            <span class="result-name">${author.name}${author.isVerified ? ' <span class="verified-badge" title="ORCID verified">&#x2713;</span>' : ''}</span>
            <span class="result-stats">${author.paperCount} papers | ${formatNumber(author.citationCount)} citations</span>
          </div>
        `).join('')}
      `;

      authors.forEach(author => authorCache.set(author.authorId, author));

      // Handle checkbox changes
      const checkboxes = searchResults.querySelectorAll('.author-checkbox');
      const combineBar = document.getElementById('combineBar');
      const selectedCount = document.getElementById('selectedCount');
      const combineBtn = document.getElementById('combineBtn');

      checkboxes.forEach(cb => {
        cb.addEventListener('change', (e) => {
          e.stopPropagation();
          const checked = searchResults.querySelectorAll('.author-checkbox:checked');
          selectedCount.textContent = checked.length;
          combineBar.style.display = checked.length >= 2 ? 'flex' : 'none';
        });
        cb.addEventListener('click', (e) => e.stopPropagation());
      });

      combineBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const checked = searchResults.querySelectorAll('.author-checkbox:checked');
        const authorIds = Array.from(checked).map(cb => cb.dataset.id);
        const authorNames = Array.from(checked).map(cb => cb.dataset.name);
        searchResults.classList.remove('visible');
        loadCombinedAuthorNetwork(authorIds, authorNames);
      });

      searchResults.querySelectorAll('.search-result').forEach(el => {
        el.addEventListener('click', (e) => {
          if (e.target.classList.contains('author-checkbox')) return;
          const authorId = el.dataset.id;
          searchResults.classList.remove('visible');
          loadAuthorNetwork(authorId);
        });
      });
    } else {
      searchResults.innerHTML = '<div class="search-result">No authors found</div>';
    }
  } catch (error) {
    console.error('Search error:', error);
    searchResults.innerHTML = '<div class="search-result">Error searching. Please try again.</div>';
  }
}

// ============================================
// Load Author Network
// ============================================

async function loadAuthorNetwork(authorId) {
  showLoading(true);
  expandedNetworks = [];

  try {
    const cachedAuthor = authorCache.get(authorId);

    let url;
    if (authorId.startsWith('orcid:')) {
      const orcid = authorId.substring(6);
      url = `${CROSSREF_BASE}/works?mailto=${MAILTO}&filter=orcid:${orcid}&rows=100&select=DOI,title,author,published,is-referenced-by-count`;
    } else {
      const name = cachedAuthor?.name || cachedAuthor?.searchQuery || '';
      url = `${CROSSREF_BASE}/works?mailto=${MAILTO}&query.author=${encodeURIComponent(name)}&rows=100&select=DOI,title,author,published,is-referenced-by-count`;
    }

    const response = await fetch(url);
    const data = await response.json();
    const works = data.message?.items || [];

    const papers = works.map(work => workToPaper(work));

    // Calculate stats
    let paperCount = 0;
    let citationCount = 0;
    papers.forEach(paper => {
      if (paper.authors.some(a => a.authorId === authorId)) {
        paperCount++;
        citationCount += paper.citationCount || 0;
      }
    });

    const author = {
      ...cachedAuthor,
      authorId,
      paperCount,
      citationCount
    };
    authorCache.set(authorId, author);

    currentPapersData = papers;
    currentCentralAuthorId = authorId;

    buildNetwork(authorId, papers);
    selectAuthor(authorId);

  } catch (error) {
    console.error('Error loading network:', error);
  } finally {
    showLoading(false);
  }
}

// Load combined network from multiple author profiles
async function loadCombinedAuthorNetwork(authorIds, authorNames) {
  if (!authorIds || authorIds.length < 2) return;

  showLoading(true);
  expandedNetworks = [];

  try {
    const paperPromises = authorIds.map(authorId => {
      const cachedAuthor = authorCache.get(authorId);
      let url;
      if (authorId.startsWith('orcid:')) {
        const orcid = authorId.substring(6);
        url = `${CROSSREF_BASE}/works?mailto=${MAILTO}&filter=orcid:${orcid}&rows=100&select=DOI,title,author,published,is-referenced-by-count`;
      } else {
        const name = cachedAuthor?.name || '';
        url = `${CROSSREF_BASE}/works?mailto=${MAILTO}&query.author=${encodeURIComponent(name)}&rows=100&select=DOI,title,author,published,is-referenced-by-count`;
      }
      return fetch(url).then(r => r.json()).then(d => d.message?.items || []);
    });

    const allWorkArrays = await Promise.all(paperPromises);

    const workMap = new Map();
    allWorkArrays.flat().forEach(work => {
      if (work.DOI && !workMap.has(work.DOI)) {
        workMap.set(work.DOI, work);
      }
    });

    const combinedWorks = Array.from(workMap.values());
    const combinedPapers = combinedWorks.map(work => workToPaper(work));

    const combinedName = authorNames.join(' / ');
    const combinedAuthorIds = new Set(authorIds);

    let totalCitations = 0;
    combinedPapers.forEach(paper => {
      totalCitations += paper.citationCount || 0;
    });

    const combinedAuthor = {
      authorId: `combined_${authorIds.join('_')}`,
      name: combinedName,
      paperCount: combinedPapers.length,
      citationCount: totalCitations,
      isCombined: true,
      combinedAuthorIds: combinedAuthorIds
    };

    authorCache.set(combinedAuthor.authorId, combinedAuthor);

    currentPapersData = combinedPapers;
    currentCentralAuthorId = combinedAuthor.authorId;

    buildCombinedNetwork(combinedAuthor.authorId, combinedAuthorIds, combinedPapers);
    selectAuthor(combinedAuthor.authorId);

  } catch (error) {
    console.error('Error loading combined network:', error);
  } finally {
    showLoading(false);
  }
}

// ============================================
// Build Network
// ============================================

function getAuthorPosition(authorId, authors) {
  if (!authors || authors.length === 0) return null;
  const firstAuthor = authors[0];
  const lastAuthor = authors[authors.length - 1];

  const isFirst = firstAuthor && firstAuthor.authorId === authorId;
  const isLast = lastAuthor && lastAuthor.authorId === authorId;

  if (isFirst && isLast) return 'both';
  if (isFirst) return 'first';
  if (isLast) return 'senior';
  return 'middle';
}

function shouldIncludeAuthor(authorId, authors) {
  if (authorFilter === 'all') return true;

  const position = getAuthorPosition(authorId, authors);

  switch (authorFilter) {
    case 'senior-first':
      return position === 'first' || position === 'senior' || position === 'both';
    case 'senior':
      return position === 'senior' || position === 'both';
    case 'first':
      return position === 'first' || position === 'both';
    default:
      return true;
  }
}

function buildNetwork(centralAuthorId, papers) {
  nodes.clear();
  edges.clear();
  clusterData = [];

  const coauthorMap = new Map();
  const centralAuthor = authorCache.get(centralAuthorId);

  papers.forEach((paper, paperIdx) => {
    if (!paper.authors) return;

    paper.authors.forEach(author => {
      if (author.authorId && author.authorId !== centralAuthorId) {
        if (!shouldIncludeAuthor(author.authorId, paper.authors)) return;

        if (coauthorMap.has(author.authorId)) {
          const data = coauthorMap.get(author.authorId);
          data.paperCount++;
          data.sharedPapers.add(paperIdx);
        } else {
          coauthorMap.set(author.authorId, {
            author: author,
            paperCount: 1,
            sharedPapers: new Set([paperIdx])
          });
        }
      }
    });
  });

  // Detect clusters
  const coauthorIds = Array.from(coauthorMap.keys());
  const clusterEdges = [];

  const MAX_FOR_CLUSTERING = 200;
  if (coauthorIds.length <= MAX_FOR_CLUSTERING) {
    for (let i = 0; i < coauthorIds.length; i++) {
      for (let j = i + 1; j < coauthorIds.length; j++) {
        const id1 = coauthorIds[i];
        const id2 = coauthorIds[j];
        const papers1 = coauthorMap.get(id1).sharedPapers;
        const papers2 = coauthorMap.get(id2).sharedPapers;

        const sharedPapers = [...papers1].filter(p => papers2.has(p));
        if (sharedPapers.length > 0) {
          clusterEdges.push({ from: id1, to: id2, weight: sharedPapers.length });
        }
      }
    }
  }

  const clusters = detectClusters(coauthorIds, clusterEdges);

  // Group by cluster
  const clusterMembers = new Map();
  clusters.forEach((clusterId, authorId) => {
    if (!clusterMembers.has(clusterId)) {
      clusterMembers.set(clusterId, []);
    }
    clusterMembers.get(clusterId).push(authorId);
  });

  const sortedClusters = Array.from(clusterMembers.entries())
    .sort((a, b) => b[1].length - a[1].length);
  const numClusters = sortedClusters.length;

  // Build clusterData for sidebar
  sortedClusters.forEach(([clusterId, members], index) => {
    const color = clusterColors[index % clusterColors.length];
    clusterData.push({
      id: clusterId,
      color: color,
      members: members,
      count: members.length
    });
  });

  // Add central node
  nodes.add({
    id: centralAuthorId,
    label: centralAuthor?.name || 'Unknown',
    color: '#e74c3c',
    size: 35,
    font: { size: 16 },
    cluster: -1,
    fixed: { x: true, y: true },
    x: 0,
    y: 0
  });

  // Position nodes by cluster
  sortedClusters.forEach(([clusterId, members], clusterIndex) => {
    const color = clusterColors[clusterIndex % clusterColors.length];
    const sectorAngle = (2 * Math.PI) / Math.max(numClusters, 1);
    const clusterCenterAngle = clusterIndex * sectorAngle;
    const baseRadius = 150 + (clusterIndex * 20);

    members.forEach((coauthorId, memberIndex) => {
      const data = coauthorMap.get(coauthorId);
      const size = Math.min(12 + data.paperCount * 4, 35);
      const angleSpread = sectorAngle * 0.7;
      const memberAngle = clusterCenterAngle +
        (memberIndex / Math.max(members.length - 1, 1) - 0.5) * angleSpread +
        (Math.random() - 0.5) * 0.2;
      const radius = baseRadius + (Math.random() - 0.5) * 50;

      nodes.add({
        id: coauthorId,
        label: data.author.name,
        color: color,
        size: size,
        title: `${data.paperCount} shared papers\nCluster ${clusterIndex + 1}`,
        cluster: clusterId,
        x: Math.cos(memberAngle) * radius,
        y: Math.sin(memberAngle) * radius
      });

      edges.add({
        from: centralAuthorId,
        to: coauthorId,
        width: Math.min(1 + data.paperCount * 0.5, 6),
        color: { color: '#555' }
      });

      if (!authorCache.has(coauthorId)) {
        authorCache.set(coauthorId, {
          authorId: coauthorId,
          name: data.author.name,
          orcid: data.author.orcid,
          paperCount: null,
          citationCount: null
        });
      }
    });
  });

  // Add cluster edges
  clusterEdges.forEach(edge => {
    edges.add({
      from: edge.from,
      to: edge.to,
      width: Math.min(1 + edge.weight * 0.5, 5),
      color: { color: '#444', opacity: 0.5 },
      length: 50
    });
  });

  // Update stats
  const author = authorCache.get(centralAuthorId);
  if (author) {
    author.coauthorCount = coauthorMap.size;
    authorCache.set(centralAuthorId, author);
  }

  updateClusterList();

  if (network) {
    network.fit({ animation: false });
    network.setOptions({ physics: { enabled: true } });
    setTimeout(() => {
      network.setOptions({ physics: { enabled: false } });
    }, 1500);
  }
}

function buildCombinedNetwork(combinedAuthorId, centralAuthorIds, papers) {
  nodes.clear();
  edges.clear();
  clusterData = [];

  const coauthorMap = new Map();

  papers.forEach((paper, paperIdx) => {
    if (!paper.authors) return;

    paper.authors.forEach(author => {
      if (author.authorId && !centralAuthorIds.has(author.authorId)) {
        if (!shouldIncludeAuthor(author.authorId, paper.authors)) return;

        if (coauthorMap.has(author.authorId)) {
          const data = coauthorMap.get(author.authorId);
          data.paperCount++;
          data.sharedPapers.add(paperIdx);
        } else {
          coauthorMap.set(author.authorId, {
            author: author,
            paperCount: 1,
            sharedPapers: new Set([paperIdx])
          });
        }
      }
    });
  });

  // Detect clusters
  const coauthorIds = Array.from(coauthorMap.keys());
  const clusterEdges = [];

  const MAX_FOR_CLUSTERING = 200;
  if (coauthorIds.length <= MAX_FOR_CLUSTERING) {
    for (let i = 0; i < coauthorIds.length; i++) {
      for (let j = i + 1; j < coauthorIds.length; j++) {
        const id1 = coauthorIds[i];
        const id2 = coauthorIds[j];
        const papers1 = coauthorMap.get(id1).sharedPapers;
        const papers2 = coauthorMap.get(id2).sharedPapers;

        const sharedPapers = [...papers1].filter(p => papers2.has(p));
        if (sharedPapers.length > 0) {
          clusterEdges.push({ from: id1, to: id2, weight: sharedPapers.length });
        }
      }
    }
  }

  const clusters = detectClusters(coauthorIds, clusterEdges);

  const clusterMembers = new Map();
  clusters.forEach((clusterId, authorId) => {
    if (!clusterMembers.has(clusterId)) {
      clusterMembers.set(clusterId, []);
    }
    clusterMembers.get(clusterId).push(authorId);
  });

  const sortedClusters = Array.from(clusterMembers.entries())
    .sort((a, b) => b[1].length - a[1].length);
  const numClusters = sortedClusters.length;

  sortedClusters.forEach(([clusterId, members], index) => {
    const color = clusterColors[index % clusterColors.length];
    clusterData.push({
      id: clusterId,
      color: color,
      members: members,
      count: members.length
    });
  });

  const combinedAuthor = authorCache.get(combinedAuthorId);

  nodes.add({
    id: combinedAuthorId,
    label: combinedAuthor?.name || 'Combined',
    color: '#e74c3c',
    size: 35,
    font: { size: 14 },
    cluster: -1,
    fixed: { x: true, y: true },
    x: 0,
    y: 0
  });

  sortedClusters.forEach(([clusterId, members], clusterIndex) => {
    const color = clusterColors[clusterIndex % clusterColors.length];
    const sectorAngle = (2 * Math.PI) / Math.max(numClusters, 1);
    const clusterCenterAngle = clusterIndex * sectorAngle;
    const baseRadius = 150 + (clusterIndex * 20);

    members.forEach((coauthorId, memberIndex) => {
      const data = coauthorMap.get(coauthorId);
      const size = Math.min(12 + data.paperCount * 4, 35);
      const angleSpread = sectorAngle * 0.7;
      const memberAngle = clusterCenterAngle +
        (memberIndex / Math.max(members.length - 1, 1) - 0.5) * angleSpread +
        (Math.random() - 0.5) * 0.2;
      const radius = baseRadius + (Math.random() - 0.5) * 50;

      nodes.add({
        id: coauthorId,
        label: data.author.name,
        color: color,
        size: size,
        title: `${data.paperCount} shared papers\nCluster ${clusterIndex + 1}`,
        cluster: clusterId,
        x: Math.cos(memberAngle) * radius,
        y: Math.sin(memberAngle) * radius
      });

      edges.add({
        from: combinedAuthorId,
        to: coauthorId,
        width: Math.min(1 + data.paperCount * 0.5, 6),
        color: { color: '#555' }
      });

      if (!authorCache.has(coauthorId)) {
        authorCache.set(coauthorId, {
          authorId: coauthorId,
          name: data.author.name,
          orcid: data.author.orcid,
          paperCount: null,
          citationCount: null
        });
      }
    });
  });

  clusterEdges.forEach(edge => {
    edges.add({
      from: edge.from,
      to: edge.to,
      width: Math.min(1 + edge.weight * 0.5, 5),
      color: { color: '#444', opacity: 0.5 },
      length: 50
    });
  });

  updateClusterList();

  if (network) {
    network.fit({ animation: false });
    network.setOptions({ physics: { enabled: true } });
    setTimeout(() => {
      network.setOptions({ physics: { enabled: false } });
    }, 1500);
  }
}

// Union-Find cluster detection
function detectClusters(nodeIds, clusterEdges) {
  const parent = new Map();
  nodeIds.forEach(id => parent.set(id, id));

  function find(x) {
    if (parent.get(x) !== x) {
      parent.set(x, find(parent.get(x)));
    }
    return parent.get(x);
  }

  function union(x, y) {
    const px = find(x);
    const py = find(y);
    if (px !== py) {
      parent.set(px, py);
    }
  }

  clusterEdges.forEach(e => union(e.from, e.to));

  const rootToCluster = new Map();
  let clusterNum = 0;
  const result = new Map();

  nodeIds.forEach(id => {
    const root = find(id);
    if (!rootToCluster.has(root)) {
      rootToCluster.set(root, clusterNum++);
    }
    result.set(id, rootToCluster.get(root));
  });

  return result;
}

// Update cluster list in sidebar
function updateClusterList() {
  const clusterList = document.getElementById('clusterList');
  if (!clusterList) return;

  clusterList.innerHTML = clusterData.map(cluster => `
    <div class="cluster-item" data-cluster="${cluster.id}">
      <div class="cluster-header">
        <span class="cluster-color" style="background: ${cluster.color};"></span>
        <span class="cluster-name">Cluster ${cluster.id + 1}</span>
        <span class="cluster-count">${cluster.count}</span>
      </div>
    </div>
  `).join('');

  clusterList.querySelectorAll('.cluster-item').forEach(el => {
    el.addEventListener('click', () => {
      const clusterId = parseInt(el.dataset.cluster);
      highlightCluster(clusterId);
    });
  });
}

// Highlight a specific cluster
function highlightCluster(clusterId) {
  const allNodes = nodes.get();
  allNodes.forEach(node => {
    if (node.cluster === clusterId || node.cluster === -1) {
      nodes.update({ id: node.id, opacity: 1 });
    } else {
      nodes.update({ id: node.id, opacity: 0.2 });
    }
  });

  const cluster = clusterData.find(c => c.id === clusterId);
  if (cluster && cluster.members.length > 0) {
    network.fit({ nodes: cluster.members, animation: true });
  }
}

// Expand network from a secondary node
async function expandNetwork(authorId) {
  showNodeLoading(authorId, true);

  try {
    const cachedAuthor = authorCache.get(authorId);
    let url;
    if (authorId.startsWith('orcid:')) {
      const orcid = authorId.substring(6);
      url = `${CROSSREF_BASE}/works?mailto=${MAILTO}&filter=orcid:${orcid}&rows=50&select=DOI,title,author,published,is-referenced-by-count`;
    } else {
      const name = cachedAuthor?.name || '';
      url = `${CROSSREF_BASE}/works?mailto=${MAILTO}&query.author=${encodeURIComponent(name)}&rows=50&select=DOI,title,author,published,is-referenced-by-count`;
    }

    const response = await fetch(url);
    const data = await response.json();
    const works = data.message?.items || [];
    const papers = works.map(work => workToPaper(work));

    expandedNetworks.push({ authorId, papers });
    addExpandedNodes(authorId, papers);

  } catch (error) {
    console.error('Error expanding network:', error);
  } finally {
    showNodeLoading(authorId, false);
  }
}

function addExpandedNodes(authorId, papers) {
  const parentPos = network.getPositions([authorId])[authorId] || { x: 0, y: 0 };
  const newCoauthorsMap = new Map();

  papers.forEach(paper => {
    if (!paper.authors) return;

    paper.authors.forEach(author => {
      if (author.authorId && author.authorId !== authorId) {
        if (!shouldIncludeAuthor(author.authorId, paper.authors)) return;

        const existingNode = nodes.get(author.authorId);
        if (!existingNode && !newCoauthorsMap.has(author.authorId)) {
          newCoauthorsMap.set(author.authorId, author);
        }
      }
    });
  });

  const newCoauthors = Array.from(newCoauthorsMap.values());
  const totalNodes = newCoauthors.length;

  newCoauthors.forEach((author, idx) => {
    const angle = (idx / Math.max(totalNodes, 1)) * 2 * Math.PI + Math.random() * 0.3;
    const radius = 80 + Math.random() * 50;

    nodes.add({
      id: author.authorId,
      label: author.name,
      color: '#6b7280',
      size: 10,
      expandedFrom: authorId,
      x: parentPos.x + Math.cos(angle) * radius,
      y: parentPos.y + Math.sin(angle) * radius
    });

    edges.add({
      from: authorId,
      to: author.authorId,
      color: '#444',
      width: 0.5
    });
  });

  nodes.update({ id: authorId, color: '#9b59b6' });

  if (newCoauthors.length > 0) {
    network.setOptions({
      physics: { enabled: true, stabilization: { enabled: false } }
    });
    setTimeout(() => {
      network.setOptions({ physics: { enabled: false } });
    }, 1500);
  }
}

function restoreExpandedNetworks() {
  expandedNetworks.forEach(({ authorId, papers }) => {
    if (nodes.get(authorId)) {
      addExpandedNodes(authorId, papers);
    }
  });
}

// ============================================
// Select Author
// ============================================

async function selectAuthor(authorId) {
  selectedAuthorId = authorId;

  // Close panels
  const papersPanel = document.getElementById('papersPanel');
  if (papersPanel) papersPanel.classList.remove('visible');
  const retractedPanel = document.getElementById('retractedPanel');
  if (retractedPanel) retractedPanel.classList.remove('visible');

  // Reset opacity
  nodes.get().forEach(node => {
    nodes.update({ id: node.id, opacity: 1 });
  });

  let author = authorCache.get(authorId);
  if (!author || author.paperCount === null) {
    try {
      const cachedAuthor = authorCache.get(authorId);
      let url;
      if (authorId.startsWith('orcid:')) {
        const orcid = authorId.substring(6);
        url = `${CROSSREF_BASE}/works?mailto=${MAILTO}&filter=orcid:${orcid}&rows=100&select=DOI,is-referenced-by-count`;
      } else {
        const name = cachedAuthor?.name || '';
        url = `${CROSSREF_BASE}/works?mailto=${MAILTO}&query.author=${encodeURIComponent(name)}&rows=100&select=DOI,is-referenced-by-count`;
      }

      const response = await fetch(url);
      const data = await response.json();
      const works = data.message?.items || [];

      let paperCount = works.length;
      let citationCount = works.reduce((sum, w) => sum + (w['is-referenced-by-count'] || 0), 0);

      author = {
        ...cachedAuthor,
        paperCount,
        citationCount
      };
      authorCache.set(authorId, author);
    } catch (e) {
      console.error('Error fetching author details:', e);
    }
  }

  updateInfoPanel(author);
  updateFavoriteButton(authorId);
  checkAuthorRetractions(authorId);
}

function updateInfoPanel(author) {
  if (!author) return;

  document.getElementById('authorName').textContent = author.name || 'Unknown';
  document.getElementById('paperCount').textContent = author.paperCount ?? '-';
  document.getElementById('citationCount').textContent = formatNumber(author.citationCount) || '-';

  // Reset retraction stat
  const retractionStat = document.getElementById('retractionStat');
  const retractionCount = document.getElementById('retractionCount');
  if (retractionStat && retractionCount) {
    retractionStat.classList.remove('clean');
    retractionStat.classList.add('loading');
    retractionCount.textContent = '-';
  }

  loadActivityTrends(author.authorId);
}

// Load activity trends
async function loadActivityTrends(authorId) {
  try {
    let papers;
    const currentAuthor = authorCache.get(currentCentralAuthorId);
    if ((authorId === currentCentralAuthorId || (currentAuthor && currentAuthor.isCombined)) && currentPapersData) {
      papers = currentPapersData;
    } else {
      return;
    }

    if (papers.length === 0) return;

    const currentYear = new Date().getFullYear();
    const papersByYear = new Map();
    const coauthorCounts = new Map();
    let totalTeamSize = 0;
    let papersWithAuthors = 0;

    papers.forEach(paper => {
      if (paper.year && paper.year >= 2000) {
        papersByYear.set(paper.year, (papersByYear.get(paper.year) || 0) + 1);
      }

      if (paper.authors && paper.authors.length > 0) {
        totalTeamSize += paper.authors.length;
        papersWithAuthors++;

        paper.authors.forEach(a => {
          if (a.authorId && a.authorId !== authorId) {
            coauthorCounts.set(a.authorId, (coauthorCounts.get(a.authorId) || 0) + 1);
          }
        });
      }
    });

    const totalCoauthors = coauthorCounts.size;
    const repeatCoauthors = Array.from(coauthorCounts.values()).filter(count => count >= 2).length;
    const repeatRate = totalCoauthors > 0 ? Math.round((repeatCoauthors / totalCoauthors) * 100) : 0;
    const avgTeam = papersWithAuthors > 0 ? (totalTeamSize / papersWithAuthors).toFixed(1) : '-';

    const repeatRateEl = document.getElementById('repeatCollabRate');
    const avgTeamEl = document.getElementById('avgTeamSize');
    if (repeatRateEl) repeatRateEl.textContent = `${repeatRate}%`;
    if (avgTeamEl) avgTeamEl.textContent = avgTeam;

    const recentYears = [currentYear - 1, currentYear - 2, currentYear - 3];
    const previousYears = [currentYear - 4, currentYear - 5, currentYear - 6];
    const recentPapers = recentYears.reduce((sum, y) => sum + (papersByYear.get(y) || 0), 0) / 3;
    const previousPapers = previousYears.reduce((sum, y) => sum + (papersByYear.get(y) || 0), 0) / 3;

    const paperCountEl = document.getElementById('paperCount');
    const paperTrend = getTrendIndicator(recentPapers, previousPapers);
    if (paperCountEl && paperTrend) {
      const currentValue = paperCountEl.textContent;
      paperCountEl.innerHTML = `${currentValue} <span class="${paperTrend.class}" style="font-size: 14px;" title="Publishing trend">${paperTrend.icon}</span>`;
    }

  } catch (error) {
    console.error('Error loading activity trends:', error);
  }
}

function getTrendIndicator(recent, previous) {
  if (previous === 0 && recent === 0) return null;
  if (previous === 0 && recent > 0) return { icon: '\u2191', class: 'trend-up' };

  const ratio = recent / previous;
  if (ratio > 1.15) return { icon: '\u2191', class: 'trend-up' };
  if (ratio < 0.85) return { icon: '\u2193', class: 'trend-down' };
  return { icon: '\u2192', class: 'trend-stable' };
}

// ============================================
// Retraction Checking
// ============================================

const retractionCache = new Map();
const authorRetractionCache = new Map();

async function checkRetraction(doi) {
  if (!doi) return null;

  const cleanDoi = doi.replace(/^https?:\/\/doi\.org\//i, '').replace(/^doi:/i, '').trim();

  if (retractionCache.has(cleanDoi)) {
    return retractionCache.get(cleanDoi);
  }

  try {
    const result = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'fetchCrossref', doi: cleanDoi },
        (response) => resolve(response)
      );
    });

    if (!result || !result.success) {
      retractionCache.set(cleanDoi, null);
      return null;
    }

    const work = result.data.message;
    let retractionInfo = null;

    // Check updated-by field
    if (work['updated-by'] && Array.isArray(work['updated-by'])) {
      const retraction = work['updated-by'].find(u =>
        u.type === 'retraction' || u.label?.toLowerCase().includes('retract')
      );
      if (retraction) {
        retractionInfo = {
          isRetracted: true,
          date: retraction.updated?.['date-parts']?.[0]?.join('-') || 'Unknown date',
          source: retraction.source || 'crossref'
        };
      }
    }

    // Check update-to field
    if (!retractionInfo && work['update-to'] && Array.isArray(work['update-to'])) {
      const retraction = work['update-to'].find(u =>
        u.type === 'retraction' || u.label?.toLowerCase().includes('retract')
      );
      if (retraction) {
        retractionInfo = {
          isRetracted: true,
          date: retraction.updated?.['date-parts']?.[0]?.join('-') || 'Unknown date',
          source: retraction.source || 'crossref'
        };
      }
    }

    // Check relation field
    if (!retractionInfo && work.relation && work.relation['is-retracted-by']) {
      retractionInfo = {
        isRetracted: true,
        date: 'See retraction notice',
        source: 'crossref-relation'
      };
    }

    // Check if work is a retraction notice
    if (!retractionInfo && work.type === 'retraction') {
      retractionInfo = {
        isRetracted: true,
        date: work.created?.['date-parts']?.[0]?.join('-') || 'Unknown date',
        source: 'crossref'
      };
    }

    // Check title prefix
    if (!retractionInfo) {
      const title = (work.title?.[0] || '');
      if (title.startsWith('RETRACTED:') || title.startsWith('Retracted:')) {
        retractionInfo = {
          isRetracted: true,
          date: 'See article',
          source: 'title-prefix'
        };
      }
    }

    retractionCache.set(cleanDoi, retractionInfo);
    return retractionInfo;

  } catch (error) {
    console.error('Error checking retraction:', error);
    retractionCache.set(cleanDoi, null);
    return null;
  }
}

async function checkAuthorRetractions(authorId) {
  const retractionStat = document.getElementById('retractionStat');
  const retractionCountEl = document.getElementById('retractionCount');

  if (!retractionStat || !retractionCountEl) return;

  retractionStat.classList.remove('clean', 'loading');
  retractionCountEl.textContent = '...';
  retractionStat.classList.add('loading');

  try {
    let allPapers = [];
    const currentAuthor = authorCache.get(currentCentralAuthorId);

    if (currentAuthor && currentAuthor.isCombined && currentPapersData) {
      allPapers = currentPapersData;
    } else if (authorId === currentCentralAuthorId && currentPapersData) {
      allPapers = currentPapersData;
    } else {
      const cachedAuthor = authorCache.get(authorId);
      let url;
      if (authorId.startsWith('orcid:')) {
        const orcid = authorId.substring(6);
        url = `${CROSSREF_BASE}/works?mailto=${MAILTO}&filter=orcid:${orcid}&rows=100&select=DOI,title`;
      } else {
        const name = cachedAuthor?.name || '';
        url = `${CROSSREF_BASE}/works?mailto=${MAILTO}&query.author=${encodeURIComponent(name)}&rows=100&select=DOI,title`;
      }

      const response = await fetch(url);
      const data = await response.json();
      allPapers = (data.message?.items || []).map(w => ({ doi: w.DOI, title: w.title?.[0] }));
    }

    if (allPapers.length === 0) {
      retractionStat.classList.remove('loading');
      retractionCountEl.textContent = '-';
      return;
    }

    const retractions = await checkRetractionsForPapers(allPapers);
    const count = retractions.size;

    retractionStat.classList.remove('loading');
    retractionCountEl.textContent = count;

    if (count === 0) {
      retractionStat.classList.add('clean');
      retractionStat.title = 'No retracted papers found';
    } else {
      retractionStat.classList.remove('clean');
      retractionStat.title = `${count} retracted paper${count > 1 ? 's' : ''}`;
    }

    authorRetractionCache.set(authorId, retractions);

  } catch (error) {
    console.error('Error checking author retractions:', error);
    retractionStat.classList.remove('loading');
    retractionCountEl.textContent = '-';
  }
}

async function checkRetractionsForPapers(papers) {
  const results = new Map();
  const papersWithDoi = papers.filter(p => p.doi || p.externalIds?.DOI);

  const BATCH_SIZE = 5;
  for (let i = 0; i < papersWithDoi.length; i += BATCH_SIZE) {
    const batch = papersWithDoi.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async paper => {
      const doi = paper.doi || paper.externalIds?.DOI;
      const retractionInfo = await checkRetraction(doi);
      if (retractionInfo) {
        results.set(paper.doi || i, retractionInfo);
      }
    });
    await Promise.all(promises);

    if (i + BATCH_SIZE < papersWithDoi.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  return results;
}

// ============================================
// Papers Panel
// ============================================

async function loadPapers(authorId) {
  const papersPanel = document.getElementById('papersPanel');
  const papersList = document.getElementById('papersList');

  papersList.innerHTML = '<div style="color: #888; padding: 10px;">Loading papers...</div>';
  papersPanel.classList.add('visible');

  try {
    let papers;

    const author = authorCache.get(authorId);
    if (author && author.isCombined && currentPapersData) {
      papers = currentPapersData.map(p => ({
        ...p,
        url: p.doi ? `https://doi.org/${p.doi}` : null,
        citationCount: p.citationCount || 0
      }));
    } else if (authorId === currentCentralAuthorId && currentPapersData) {
      papers = currentPapersData.map(p => ({
        ...p,
        url: p.doi ? `https://doi.org/${p.doi}` : null,
        citationCount: p.citationCount || 0
      }));
    } else {
      const cachedAuthor = authorCache.get(authorId);
      let url;
      if (authorId.startsWith('orcid:')) {
        const orcid = authorId.substring(6);
        url = `${CROSSREF_BASE}/works?mailto=${MAILTO}&filter=orcid:${orcid}&rows=100&select=DOI,title,published,is-referenced-by-count`;
      } else {
        const name = cachedAuthor?.name || '';
        url = `${CROSSREF_BASE}/works?mailto=${MAILTO}&query.author=${encodeURIComponent(name)}&rows=100&select=DOI,title,published,is-referenced-by-count`;
      }

      const response = await fetch(url);
      const data = await response.json();
      papers = (data.message?.items || []).map(w => ({
        doi: w.DOI,
        title: Array.isArray(w.title) ? w.title[0] : w.title,
        year: w.published?.['date-parts']?.[0]?.[0],
        citationCount: w['is-referenced-by-count'] || 0,
        url: w.DOI ? `https://doi.org/${w.DOI}` : null
      }));
    }

    if (papers.length > 0) {
      papers.sort((a, b) => (b.citationCount || 0) - (a.citationCount || 0));

      papersList.innerHTML = papers.map((paper, idx) => `
        <div class="paper-item" data-paper-id="${paper.doi || idx}">
          <div class="paper-title-row">
            <a class="paper-title" href="${paper.url || '#'}" target="_blank">
              ${paper.title || 'Untitled'}
            </a>
            <span class="retraction-badge" style="display: none;"></span>
          </div>
          <div class="paper-meta">
            <span>${paper.year || 'N/A'}</span>
            <span>${paper.citationCount || 0} citations</span>
          </div>
        </div>
      `).join('');

      // Check retractions in background
      const cachedRetractions = authorRetractionCache.get(authorId);
      const retractionsPromise = cachedRetractions
        ? Promise.resolve(cachedRetractions)
        : checkRetractionsForPapers(papers);

      retractionsPromise.then(retractions => {
        if (retractions.size > 0) {
          retractions.forEach((info, paperId) => {
            const paperEl = papersList.querySelector(`[data-paper-id="${paperId}"]`);
            if (paperEl) {
              paperEl.classList.add('retracted');
              const badge = paperEl.querySelector('.retraction-badge');
              if (badge) {
                badge.style.display = 'inline-block';
                badge.textContent = 'RETRACTED';
                badge.title = `Retracted: ${info.date} (source: ${info.source})`;
              }
            }
          });
        }
      });

    } else {
      papersList.innerHTML = '<div style="color: #888; padding: 10px;">No papers found</div>';
    }
  } catch (error) {
    console.error('Error loading papers:', error);
    papersList.innerHTML = '<div style="color: #e74c3c; padding: 10px;">Error loading papers</div>';
  }
}

async function loadRetractedPapers(authorId) {
  const retractedPanel = document.getElementById('retractedPanel');
  const retractedList = document.getElementById('retractedList');

  retractedList.innerHTML = '<div style="color: #888; padding: 10px;">Loading retracted papers...</div>';
  retractedPanel.classList.add('visible');

  try {
    const cachedRetractions = authorRetractionCache.get(authorId);

    if (cachedRetractions && cachedRetractions.size > 0) {
      const retractedPapers = [];

      // Get paper details from current papers data
      if (currentPapersData) {
        currentPapersData.forEach(paper => {
          if (cachedRetractions.has(paper.doi)) {
            retractedPapers.push({
              ...paper,
              retractionInfo: cachedRetractions.get(paper.doi)
            });
          }
        });
      }

      if (retractedPapers.length > 0) {
        retractedList.innerHTML = retractedPapers.map(paper => `
          <div class="paper-item retracted">
            <div class="paper-title-row">
              <a class="paper-title" href="${paper.doi ? `https://doi.org/${paper.doi}` : '#'}" target="_blank">
                ${paper.title || 'Untitled'}
              </a>
              <span class="retraction-badge">RETRACTED</span>
            </div>
            <div class="paper-meta">
              <span>${paper.year || 'N/A'}</span>
              <span>${paper.citationCount || 0} citations</span>
              <span class="retraction-info">${paper.retractionInfo?.date || ''}</span>
            </div>
          </div>
        `).join('');
      } else {
        retractedList.innerHTML = '<div style="color: #888; padding: 10px;">No retracted papers found</div>';
      }
    } else {
      retractedList.innerHTML = '<div style="color: #888; padding: 10px;">No retracted papers found. Try clicking on the author first.</div>';
    }
  } catch (error) {
    console.error('Error loading retracted papers:', error);
    retractedList.innerHTML = '<div style="color: #e74c3c; padding: 10px;">Error loading retracted papers</div>';
  }
}

// ============================================
// Loading Indicators
// ============================================

let nodeLoadingEl = null;
let loadingInterval = null;

function showNodeLoading(nodeId, show) {
  if (show && network) {
    const position = network.getPositions([nodeId])[nodeId];
    if (!position) return;

    const domPos = network.canvasToDOM(position);

    if (!nodeLoadingEl) {
      nodeLoadingEl = document.createElement('div');
      nodeLoadingEl.style.cssText = 'position: absolute; font-size: 11px; color: #4ecca3; z-index: 10; pointer-events: none;';
      document.querySelector('.main-content').appendChild(nodeLoadingEl);
    }

    nodeLoadingEl.style.left = domPos.x + 'px';
    nodeLoadingEl.style.top = (domPos.y - 25) + 'px';
    nodeLoadingEl.style.transform = 'translateX(-50%)';
    nodeLoadingEl.textContent = '...';
    nodeLoadingEl.style.display = 'block';

    let dots = 1;
    loadingInterval = setInterval(() => {
      dots = (dots % 3) + 1;
      nodeLoadingEl.textContent = '.'.repeat(dots);
    }, 250);
  } else {
    if (loadingInterval) {
      clearInterval(loadingInterval);
      loadingInterval = null;
    }
    if (nodeLoadingEl) {
      nodeLoadingEl.style.display = 'none';
    }
  }
}

// ============================================
// Favorites
// ============================================

async function loadFavorites() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['favorites'], (result) => {
      favorites = result.favorites || [];
      renderFavoritesList();
      resolve(favorites);
    });
  });
}

async function saveFavorites() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ favorites }, resolve);
  });
}

function toggleFavorite(authorId) {
  const author = authorCache.get(authorId);
  if (!author) return;

  const existingIndex = favorites.findIndex(f => f.authorId === authorId);

  if (existingIndex >= 0) {
    favorites.splice(existingIndex, 1);
  } else {
    favorites.push({
      authorId: authorId,
      name: author.name,
      orcid: author.orcid || null,
      paperCount: author.paperCount,
      citationCount: author.citationCount,
      lastChecked: Date.now(),
      lastPaperCount: author.paperCount,
      hasUpdates: false,
      newPapers: [],
      searchQuery: author.searchQuery || author.name
    });
  }

  saveFavorites();
  updateFavoriteButton(authorId);
  renderFavoritesList();
}

function updateFavoriteButton(authorId) {
  const btn = document.getElementById('favoriteBtn');
  if (!btn) return;

  const isFavorite = favorites.some(f => f.authorId === authorId);
  btn.textContent = isFavorite ? '\u2605' : '\u2606';
  btn.classList.toggle('active', isFavorite);
  btn.title = isFavorite ? 'Remove from favorites' : 'Add to favorites';
}

function renderFavoritesList() {
  const container = document.getElementById('favoritesListLeft');
  if (!container) return;

  if (favorites.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">\u2606</div>
        <div>No favorites yet</div>
        <div style="margin-top: 4px; font-size: 10px;">Click the star on any author to add them</div>
      </div>
    `;
    return;
  }

  container.innerHTML = favorites.map(fav => `
    <div class="favorite-item-left" data-id="${fav.authorId}">
      <div class="fav-info">
        <div class="fav-name">${fav.name}</div>
        <div class="fav-stats">${fav.paperCount || '?'} papers | ${formatNumber(fav.citationCount) || '?'} citations</div>
      </div>
      ${fav.hasUpdates ? '<span class="fav-badge">NEW</span>' : ''}
      <button class="remove-fav" data-id="${fav.authorId}" title="Remove">&times;</button>
    </div>
  `).join('');

  updateLeftPanelBadge();

  container.querySelectorAll('.favorite-item-left').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('remove-fav')) {
        e.stopPropagation();
        const authorId = e.target.dataset.id;
        removeFavorite(authorId);
      } else {
        const authorId = el.dataset.id;
        const fav = favorites.find(f => f.authorId === authorId);
        if (fav && fav.hasUpdates) {
          fav.hasUpdates = false;
          fav.newPapers = [];
          saveFavorites();
          renderFavoritesList();
          renderNewPapers();
        }
        loadAuthorNetwork(authorId);
      }
    });
  });
}

function removeFavorite(authorId) {
  const index = favorites.findIndex(f => f.authorId === authorId);
  if (index >= 0) {
    favorites.splice(index, 1);
    saveFavorites();
    renderFavoritesList();
    renderNewPapers();
    if (selectedAuthorId === authorId) {
      updateFavoriteButton(authorId);
    }
  }
}

function renderNewPapers() {
  const container = document.getElementById('newPapersList');
  const section = document.getElementById('newPapersSection');
  if (!container || !section) return;

  const allNewPapers = [];
  favorites.forEach(fav => {
    if (fav.newPapers && fav.newPapers.length > 0) {
      allNewPapers.push({ author: fav, papers: fav.newPapers });
    }
  });

  if (allNewPapers.length === 0) {
    section.classList.add('empty');
    container.innerHTML = '';
    return;
  }

  section.classList.remove('empty');
  container.innerHTML = allNewPapers.map(group => `
    <div class="new-paper-group">
      <div class="new-paper-author" data-id="${group.author.authorId}">${group.author.name}</div>
      ${group.papers.map(paper => `
        <div class="new-paper-item">
          <a class="new-paper-title" href="${paper.doi ? `https://doi.org/${paper.doi}` : '#'}" target="_blank">
            ${paper.title}
          </a>
          <div class="new-paper-meta">${paper.year || 'Recent'} | ${paper.citationCount || 0} citations</div>
        </div>
      `).join('')}
    </div>
  `).join('');

  container.querySelectorAll('.new-paper-author').forEach(el => {
    el.addEventListener('click', () => {
      loadAuthorNetwork(el.dataset.id);
    });
  });

  updateLeftPanelBadge();
}

function updateLeftPanelBadge() {
  const badge = document.getElementById('updatesBadge');
  if (!badge) return;

  let totalNew = 0;
  favorites.forEach(fav => {
    if (fav.newPapers && fav.newPapers.length > 0) {
      totalNew += fav.newPapers.length;
    }
  });

  if (totalNew > 0) {
    badge.textContent = totalNew;
    badge.style.display = 'block';
  } else {
    badge.style.display = 'none';
  }
}

function markAllPapersRead() {
  favorites.forEach(fav => {
    fav.hasUpdates = false;
    fav.newPapers = [];
  });
  saveFavorites();
  renderFavoritesList();
  renderNewPapers();
}

// ============================================
// Utility Functions
// ============================================

function formatNumber(num) {
  if (num === null || num === undefined) return null;
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

function showLoading(show) {
  loading.classList.toggle('visible', show);
}

// ============================================
// Event Listeners
// ============================================

searchBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  searchAuthors(searchInput.value);
});

searchInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') searchAuthors(searchInput.value);
});

document.addEventListener('click', (e) => {
  if (!searchResults.contains(e.target) && e.target !== searchInput && e.target !== searchBtn) {
    searchResults.classList.remove('visible');
  }
});

// Author filter handlers
function setAuthorFilter(filter) {
  authorFilter = filter;

  document.querySelectorAll('.toggle-btn').forEach(btn => btn.classList.remove('active'));

  const btnMap = {
    'senior-first': 'toggleSeniorFirst',
    'senior': 'toggleSenior',
    'first': 'toggleFirst',
    'all': 'toggleAll'
  };
  document.getElementById(btnMap[filter])?.classList.add('active');

  if (currentPapersData && currentCentralAuthorId) {
    const author = authorCache.get(currentCentralAuthorId);
    if (author && author.isCombined && author.combinedAuthorIds) {
      buildCombinedNetwork(currentCentralAuthorId, author.combinedAuthorIds, currentPapersData);
    } else {
      buildNetwork(currentCentralAuthorId, currentPapersData);
    }
    restoreExpandedNetworks();
    selectAuthor(currentCentralAuthorId);
  }
}

document.getElementById('toggleSeniorFirst')?.addEventListener('click', () => setAuthorFilter('senior-first'));
document.getElementById('toggleSenior')?.addEventListener('click', () => setAuthorFilter('senior'));
document.getElementById('toggleFirst')?.addEventListener('click', () => setAuthorFilter('first'));
document.getElementById('toggleAll')?.addEventListener('click', () => setAuthorFilter('all'));

// Pause motion
let physicsPaused = false;
document.getElementById('pauseMotion')?.addEventListener('click', () => {
  physicsPaused = !physicsPaused;
  const btn = document.getElementById('pauseMotion');
  if (physicsPaused) {
    network.setOptions({ physics: { enabled: false } });
    btn.textContent = 'Resume Motion';
    btn.classList.add('active');
  } else {
    network.setOptions({ physics: { enabled: true } });
    btn.textContent = 'Pause Motion';
    btn.classList.remove('active');
  }
});

// Papers panel handlers
document.getElementById('papersStat')?.addEventListener('click', () => {
  if (selectedAuthorId) {
    loadPapers(selectedAuthorId);
    setTimeout(() => {
      document.getElementById('papersPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  }
});

document.getElementById('retractionStat')?.addEventListener('click', () => {
  if (selectedAuthorId) {
    loadRetractedPapers(selectedAuthorId);
    setTimeout(() => {
      document.getElementById('retractedPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  }
});

document.getElementById('closePapersBtn')?.addEventListener('click', () => {
  document.getElementById('papersPanel').classList.remove('visible');
});

document.getElementById('closeRetractedBtn')?.addEventListener('click', () => {
  document.getElementById('retractedPanel').classList.remove('visible');
});

// Favorite button
document.getElementById('favoriteBtn')?.addEventListener('click', () => {
  if (selectedAuthorId) {
    toggleFavorite(selectedAuthorId);
  }
});

// Left panel toggle
document.getElementById('leftPanelToggle')?.addEventListener('click', () => {
  document.getElementById('leftPanel')?.classList.toggle('expanded');
});

// Mark all read
document.getElementById('markAllReadBtn')?.addEventListener('click', markAllPapersRead);

// ============================================
// Initialization
// ============================================

async function init() {
  const container = document.getElementById('network');
  if (container.offsetWidth === 0 || container.offsetHeight === 0) {
    setTimeout(init, 50);
    return;
  }

  initWorker();
  initNetwork();

  await loadFavorites();
  renderNewPapers();

  chrome.runtime.sendMessage({ type: 'clearBadge' }).catch(() => {});

  // Check for author parameter in URL
  const urlParams = new URLSearchParams(window.location.search);
  const authorFromUrl = urlParams.get('author');
  const paperTitle = urlParams.get('paperTitle');

  if (authorFromUrl) {
    searchInput.value = authorFromUrl;

    if (paperTitle) {
      showLoading(true);
      try {
        const authorId = await findAuthorByPaper(authorFromUrl, paperTitle);
        if (authorId) {
          await loadAuthorNetwork(authorId);
          showLoading(false);
          return;
        }
      } catch (error) {
        console.error('Cross-reference lookup failed:', error);
      }
      showLoading(false);
    }

    setTimeout(() => searchAuthors(authorFromUrl), 500);
    return;
  }

  // Load from storage
  chrome.storage.local.get(['networkData', 'authorCache'], (result) => {
    if (result.authorCache && Array.isArray(result.authorCache)) {
      result.authorCache.forEach(([key, value]) => {
        authorCache.set(key, value);
      });
    }
    if (result.networkData && result.networkData.papers && result.networkData.papers.length > 0) {
      currentPapersData = result.networkData.papers;
      currentCentralAuthorId = result.networkData.authorId;

      if (result.networkData.isCombined && result.networkData.authorIds) {
        const combinedAuthorIds = new Set(result.networkData.authorIds);
        buildCombinedNetwork(result.networkData.authorId, combinedAuthorIds, result.networkData.papers);
      } else {
        buildNetwork(result.networkData.authorId, result.networkData.papers);
      }
      selectAuthor(result.networkData.authorId);

      setTimeout(() => {
        network.fit();
        network.redraw();
      }, 100);
    }
    chrome.storage.local.remove(['networkData']);
  });
}

// Find author by paper title (for content script cross-referencing)
async function findAuthorByPaper(authorName, paperTitle) {
  try {
    const cleanTitle = paperTitle
      .replace(/^\[.*?\]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();

    const url = `${CROSSREF_BASE}/works?mailto=${MAILTO}&query.title=${encodeURIComponent(cleanTitle)}&rows=10&select=author,title`;
    const response = await fetch(url);

    if (!response.ok) return null;

    const data = await response.json();
    if (!data.message?.items?.length) return null;

    const normalizeAuthorName = (name) => {
      return name.toLowerCase()
        .replace(/[^a-z\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    };

    const targetNormalized = normalizeAuthorName(authorName);
    const targetParts = targetNormalized.split(' ').filter(p => p.length > 0);
    if (targetParts.length === 0) return null;

    const targetLast = targetParts[targetParts.length - 1];
    const targetFirst = targetParts.length > 1 ? targetParts[0] : '';

    for (const work of data.message.items) {
      if (!work.author) continue;

      for (const author of work.author) {
        const displayName = author.given && author.family
          ? `${author.given} ${author.family}`
          : author.name || author.family || '';

        const paperAuthorNormalized = normalizeAuthorName(displayName);
        const paperParts = paperAuthorNormalized.split(' ').filter(p => p.length > 0);
        if (paperParts.length === 0) continue;

        const paperLast = paperParts[paperParts.length - 1];
        const paperFirst = paperParts.length > 1 ? paperParts[0] : '';

        if (paperAuthorNormalized === targetNormalized) {
          return createAuthorId(author);
        }

        if (targetLast !== paperLast) {
          if (!targetLast.includes(paperLast) && !paperLast.includes(targetLast)) {
            continue;
          }
        }

        if (targetFirst && paperFirst) {
          if (targetFirst[0] === paperFirst[0]) {
            return createAuthorId(author);
          }
        } else if (!targetFirst || !paperFirst) {
          return createAuthorId(author);
        }
      }
    }

    return null;

  } catch (error) {
    console.error('Error in findAuthorByPaper:', error);
    return null;
  }
}

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
