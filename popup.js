// Crossref API for Author Network Explorer popup
const CROSSREF_BASE = 'https://api.crossref.org';
const MAILTO = 'author-network-explorer@example.com';

// State
let network = null;
let nodes = new vis.DataSet();
let edges = new vis.DataSet();
let authorCache = new Map();
let selectedAuthorId = null;
let currentFilter = 'all';
let currentNetworkData = null;
let currentPapersData = null;
let currentCentralAuthorId = null;
let authorFilter = 'senior-first';
let favorites = [];

// DOM Elements
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const searchResults = document.getElementById('searchResults');
const networkContainer = document.getElementById('network');
const loading = document.getElementById('loading');
const infoPanel = document.getElementById('infoPanel');

// Physics lock tracking
let physicsLockTimeout = null;

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

// ============================================
// Network Visualization
// ============================================

function initNetwork() {
  const options = {
    nodes: {
      shape: 'dot',
      scaling: {
        min: 10,
        max: 40,
        label: { enabled: true, min: 12, max: 20 }
      },
      font: { color: '#fff', size: 12 }
    },
    edges: {
      color: { color: '#333', highlight: '#4ecca3' },
      width: 1,
      smooth: { type: 'continuous' }
    },
    physics: {
      enabled: false,
      forceAtlas2Based: {
        gravitationalConstant: -40,
        centralGravity: 0.01,
        springLength: 80,
        springConstant: 0.08,
        damping: 0.6,
        avoidOverlap: 0.5
      },
      maxVelocity: 30,
      minVelocity: 0.5,
      solver: 'forceAtlas2Based',
      timestep: 0.3,
      stabilization: { enabled: false }
    },
    interaction: {
      hover: false,
      tooltipDelay: 300,
      dragView: true,
      zoomView: true,
      zoomSpeed: 1,
      dragNodes: true,
      navigationButtons: false,
      keyboard: false
    }
  };

  network = new vis.Network(networkContainer, { nodes, edges }, options);

  network.on('stabilized', () => {
    network.setOptions({ physics: { enabled: false } });
  });

  network.on('click', (params) => {
    if (params.nodes.length > 0) {
      const nodeId = params.nodes[0];
      selectAuthor(nodeId);
    }
  });

  network.on('doubleClick', (params) => {
    if (params.nodes.length > 0) {
      const nodeId = params.nodes[0];
      expandNetwork(nodeId);
    }
  });
}

function enablePhysicsTemporarily(duration = 1000) {
  if (physicsLockTimeout) {
    clearTimeout(physicsLockTimeout);
  }

  network.setOptions({ physics: { enabled: true } });

  physicsLockTimeout = setTimeout(() => {
    network.setOptions({ physics: { enabled: false } });
    physicsLockTimeout = null;
  }, duration);
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

    // Extract unique authors from works
    const authorsMap = new Map();
    works.forEach((work, workIndex) => {
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

    // Convert to array and sort
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
            <span class="result-name">${author.name}${author.isVerified ? ' <span style="color: #22c55e;" title="ORCID verified">&#x2713;</span>' : ''}</span>
            <span class="result-stats">${author.paperCount} papers | ${formatNumber(author.citationCount)} citations</span>
          </div>
        `).join('')}
      `;

      // Cache the results
      authors.forEach(author => {
        authorCache.set(author.authorId, author);
      });

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

      combineBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const checked = searchResults.querySelectorAll('.author-checkbox:checked');
        const authorIds = Array.from(checked).map(cb => cb.dataset.id);
        const authorNames = Array.from(checked).map(cb => cb.dataset.name);
        searchResults.classList.remove('visible');
        loadCombinedAuthorNetwork(authorIds, authorNames);
      });

      // Add click handlers
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

  try {
    // Get author from cache
    const cachedAuthor = authorCache.get(authorId);

    // Fetch works by this author
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

    // Convert works to papers format
    const papers = works.map(work => workToPaper(work));

    // Update author stats
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

    // Store for opening in new tab
    currentNetworkData = { authorId, papers };

    // Build the network
    buildNetwork(authorId, papers);
    selectAuthor(authorId);

  } catch (error) {
    console.error('Error loading network:', error);
  } finally {
    showLoading(false);
  }
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
    }))
  };
}

// Load combined network from multiple author profiles
async function loadCombinedAuthorNetwork(authorIds, authorNames) {
  if (!authorIds || authorIds.length < 2) return;

  showLoading(true);

  try {
    // Fetch papers from all author profiles in parallel
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

    // Merge works, deduplicating by DOI
    const workMap = new Map();
    allWorkArrays.flat().forEach(work => {
      if (work.DOI && !workMap.has(work.DOI)) {
        workMap.set(work.DOI, work);
      }
    });

    const combinedWorks = Array.from(workMap.values());
    const combinedPapers = combinedWorks.map(work => workToPaper(work));

    // Create combined author entry
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
      sourceAuthorIds: authorIds
    };

    authorCache.set(combinedAuthor.authorId, combinedAuthor);

    currentNetworkData = { authorId: combinedAuthor.authorId, papers: combinedPapers, isCombined: true, authorIds, authorNames };

    buildCombinedNetwork(combinedAuthor.authorId, combinedAuthorIds, combinedPapers);
    selectAuthor(combinedAuthor.authorId);

  } catch (error) {
    console.error('Error loading combined network:', error);
  } finally {
    showLoading(false);
  }
}

// Build network treating multiple author IDs as the central author
function buildCombinedNetwork(combinedAuthorId, centralAuthorIds, papers) {
  nodes.clear();
  edges.clear();

  const coauthorMap = new Map();

  papers.forEach(paper => {
    if (!paper.authors) return;

    paper.authors.forEach(author => {
      if (author.authorId && !centralAuthorIds.has(author.authorId)) {
        if (!shouldIncludeAuthor(author.authorId, paper.authors)) return;

        if (coauthorMap.has(author.authorId)) {
          coauthorMap.get(author.authorId).paperCount++;
        } else {
          coauthorMap.set(author.authorId, {
            author: author,
            paperCount: 1
          });
        }
      }
    });
  });

  const combinedAuthor = authorCache.get(combinedAuthorId);

  // Add central node
  nodes.add({
    id: combinedAuthorId,
    label: combinedAuthor.name,
    color: '#e74c3c',
    size: 30,
    font: { color: '#fff', size: 14 },
    title: `${combinedAuthor.paperCount} papers (combined)`,
    fixed: { x: true, y: true },
    x: 0,
    y: 0
  });

  // Add coauthor nodes
  const coauthorIds = Array.from(coauthorMap.keys());
  coauthorIds.forEach((authorId, i) => {
    const data = coauthorMap.get(authorId);
    const angle = (i / coauthorIds.length) * 2 * Math.PI;
    const radius = 200;

    nodes.add({
      id: authorId,
      label: data.author.name,
      color: '#00d4ff',
      size: 10 + data.paperCount * 2,
      font: { color: '#fff', size: 10 },
      title: `${data.paperCount} shared papers`,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius
    });

    edges.add({
      from: combinedAuthorId,
      to: authorId,
      width: Math.min(data.paperCount, 5),
      color: { color: '#333', opacity: 0.6 }
    });
  });

  if (network) {
    network.fit({ animation: { duration: 300 } });
  }
}

// Check if author is in a key position
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
  return position === 'first' || position === 'senior' || position === 'both';
}

// Build network from papers data with cluster detection
function buildNetwork(centralAuthorId, papers) {
  nodes.clear();
  edges.clear();

  currentPapersData = papers;
  currentCentralAuthorId = centralAuthorId;

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

  const clusters = assignClusters(coauthorIds, clusterEdges);
  const clusterColors = [
    '#00d4ff', '#ff6b35', '#a855f7', '#22c55e', '#f43f5e', '#eab308',
    '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#8b5cf6', '#14b8a6'
  ];

  // Group members by cluster
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

  // Add central node
  nodes.add({
    id: centralAuthorId,
    label: centralAuthor?.name || 'Unknown',
    color: '#e74c3c',
    size: 30,
    font: { size: 14 },
    cluster: -1,
    x: 0,
    y: 0
  });

  // Position nodes by cluster
  sortedClusters.forEach(([clusterId, members], clusterIndex) => {
    const color = clusterColors[clusterId % clusterColors.length];
    const sectorAngle = (2 * Math.PI) / Math.max(numClusters, 1);
    const clusterCenterAngle = clusterIndex * sectorAngle;
    const baseRadius = 120 + (clusterIndex * 15);

    members.forEach((coauthorId, memberIndex) => {
      const data = coauthorMap.get(coauthorId);
      const size = Math.min(10 + data.paperCount * 3, 25);
      const angleSpread = sectorAngle * 0.7;
      const memberAngle = clusterCenterAngle +
        (memberIndex / Math.max(members.length - 1, 1) - 0.5) * angleSpread +
        (Math.random() - 0.5) * 0.15;
      const radius = baseRadius + (Math.random() - 0.5) * 40;

      nodes.add({
        id: coauthorId,
        label: data.author.name,
        color: color,
        size: size,
        title: `${data.paperCount} shared papers\nCluster ${clusterId + 1}`,
        cluster: clusterId,
        x: Math.cos(memberAngle) * radius,
        y: Math.sin(memberAngle) * radius
      });

      edges.add({
        from: centralAuthorId,
        to: coauthorId,
        width: Math.min(1 + data.paperCount * 0.5, 5),
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
      width: Math.min(1 + edge.weight * 0.5, 4),
      color: { color: '#444', opacity: 0.6 },
      length: 40
    });
  });

  // Calculate network stats
  const networkStats = {
    coauthorCount: coauthorMap.size,
    clusterCount: new Set(clusters.values()).size,
    interconnections: clusterEdges.length,
    density: coauthorMap.size > 1 ?
      (clusterEdges.length / (coauthorMap.size * (coauthorMap.size - 1) / 2) * 100).toFixed(1) : 0
  };

  const author = authorCache.get(centralAuthorId);
  if (author) {
    author.coauthorCount = coauthorMap.size;
    author.networkStats = networkStats;
    authorCache.set(centralAuthorId, author);
  }

  updateClusterInfo(networkStats);

  if (network) {
    network.fit({ animation: false });
    enablePhysicsTemporarily(1200);
  }
}

function assignClusters(nodeIds, edges) {
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

  edges.forEach(e => union(e.from, e.to));

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

function updateClusterInfo(stats) {
  let clusterInfo = document.getElementById('clusterInfo');
  if (!clusterInfo) {
    clusterInfo = document.createElement('div');
    clusterInfo.id = 'clusterInfo';
    clusterInfo.className = 'cluster-info';
    document.getElementById('infoPanel').appendChild(clusterInfo);
  }

  clusterInfo.innerHTML = `
    <div class="cluster-stats">
      <span><strong>${stats.clusterCount}</strong> clusters</span>
      <span><strong>${stats.interconnections}</strong> cross-links</span>
      <span><strong>${stats.density}%</strong> density</span>
    </div>
  `;
}

// Expand network from a secondary node
async function expandNetwork(authorId) {
  showLoading(true);

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

    const parentPos = network.getPositions([authorId])[authorId] || { x: 0, y: 0 };
    const newCoauthorsMap = new Map();

    papers.forEach(paper => {
      if (!paper.authors) return;
      paper.authors.forEach(author => {
        if (author.authorId && author.authorId !== authorId) {
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
      const radius = 60 + Math.random() * 40;

      nodes.add({
        id: author.authorId,
        label: author.name,
        color: '#95a5a6',
        size: 8,
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

    nodes.update({
      id: authorId,
      color: '#9b59b6'
    });

    if (newCoauthors.length > 0) {
      enablePhysicsTemporarily(800);
    }

  } catch (error) {
    console.error('Error expanding network:', error);
  } finally {
    showLoading(false);
  }
}

// Select and highlight an author
async function selectAuthor(authorId) {
  selectedAuthorId = authorId;

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
  network.selectNodes([authorId]);
}

function updateInfoPanel(author) {
  if (!author) return;

  document.getElementById('authorName').textContent = author.name || 'Unknown';
  document.getElementById('paperCount').textContent = author.paperCount ?? '-';
  document.getElementById('citationCount').textContent = formatNumber(author.citationCount) || '-';

  // Update link - use ORCID link if available, otherwise DOI.org search
  const link = document.getElementById('scholarLink');
  if (author.orcid) {
    link.href = `https://orcid.org/${author.orcid}`;
    link.textContent = 'View on ORCID';
  } else {
    link.href = `https://search.crossref.org/?q=${encodeURIComponent(author.name)}&from_ui=yes`;
    link.textContent = 'Search on Crossref';
  }
  link.style.display = 'inline';

  // Load activity trends
  loadActivityTrends(author.authorId);

  updateFavoriteButton(author.authorId);
}

// Load activity trends
async function loadActivityTrends(authorId) {
  try {
    let papers;
    if (authorId === currentCentralAuthorId && currentPapersData) {
      papers = currentPapersData;
    } else {
      return; // Don't load for non-central authors in popup
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
      paperCountEl.innerHTML = `${currentValue} <span class="${paperTrend.class}" style="font-size: 12px;" title="Publishing trend">${paperTrend.icon}</span>`;
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

// Open network in full tab
function openInTab() {
  chrome.storage.local.set({
    networkData: currentNetworkData || null,
    authorCache: Array.from(authorCache.entries())
  }, () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('fullpage.html') });
  });
}

// Utility functions
function formatNumber(num) {
  if (num === null || num === undefined) return null;
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

function showLoading(show) {
  loading.classList.toggle('visible', show);
}

// Event listeners
searchBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  searchAuthors(searchInput.value);
});

searchInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') searchAuthors(searchInput.value);
});

searchInput.addEventListener('click', (e) => {
  e.stopPropagation();
});

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => applyFilter(btn.dataset.filter));
});

const openTabBtn = document.getElementById('openTabBtn');
if (openTabBtn) {
  openTabBtn.addEventListener('click', openInTab);
}

document.addEventListener('click', (e) => {
  if (!searchResults.contains(e.target) && e.target !== searchInput && e.target !== searchBtn) {
    searchResults.classList.remove('visible');
  }
});

// Author filter toggle handlers
function setAuthorFilter(filter) {
  authorFilter = filter;

  document.querySelectorAll('.author-toggle').forEach(btn => {
    btn.classList.remove('active');
  });

  if (filter === 'senior-first') {
    document.getElementById('toggleSeniorFirst')?.classList.add('active');
  } else {
    document.getElementById('toggleAll')?.classList.add('active');
  }

  if (currentPapersData && currentCentralAuthorId) {
    buildNetwork(currentCentralAuthorId, currentPapersData);
    selectAuthor(currentCentralAuthorId);
  }
}

document.getElementById('toggleSeniorFirst')?.addEventListener('click', () => setAuthorFilter('senior-first'));
document.getElementById('toggleAll')?.addEventListener('click', () => setAuthorFilter('all'));

// Favorite button handler
document.getElementById('favoriteBtn')?.addEventListener('click', () => {
  if (selectedAuthorId) {
    toggleFavorite(selectedAuthorId);
  }
});

// Favorites management
async function loadFavorites() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['favorites'], (result) => {
      favorites = result.favorites || [];
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
      searchQuery: author.searchQuery || author.name
    });
  }

  saveFavorites();
  updateFavoriteButton(authorId);
}

function updateFavoriteButton(authorId) {
  const btn = document.getElementById('favoriteBtn');
  if (!btn) return;

  const isFavorite = favorites.some(f => f.authorId === authorId);
  btn.textContent = isFavorite ? '\u2605' : '\u2606';
  btn.classList.toggle('active', isFavorite);
  btn.title = isFavorite ? 'Remove from favorites' : 'Add to favorites';
}

// Initialize
loadFavorites().then(() => {
  chrome.runtime.sendMessage({ type: 'clearBadge' });
});
initNetwork();
