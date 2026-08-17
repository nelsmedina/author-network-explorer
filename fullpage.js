// OpenAlex API for Author Network Explorer fullpage
const OPENALEX_BASE = 'https://api.openalex.org';

// Authenticate OpenAlex requests (key from ane-key.js) and track daily budget.
ANE.installFetch({
  onRateLimit: (rateLimitData) => chrome.storage.local.set({ rateLimitData })
});

// State
let network = null;
let nodes = new vis.DataSet();
let edges = new vis.DataSet();
let authorCache = new Map();
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_MAX_ENTRIES = 200;
let selectedAuthorId = null;
let currentCentralAuthorId = null;
let currentPapersData = null;
let expandedNetworks = [];
let authorFilter = 'senior-first';
let favorites = [];
let clusterData = [];
let worker = null;

// Collections state (paper playlists for discovery)
let collections = [];
let activeCollectionId = null;
let collectionPaperCache = new Map(); // Cache for paper details
let addedSuggestionIds = new Set(); // Track added suggestions to persist UI state

// Tab state
let activeTab = 'authors'; // 'authors' | 'collections' | 'fields'
let paperNetwork = null; // vis.Network for collections view
let paperNodes = null;
let paperEdges = null;

// Collections subtab state
let collectionSubTab = 'papers'; // 'papers' | 'authors'
let collectionAuthorNetwork = null;
let collectionAuthorNodes = null;
let collectionAuthorEdges = null;
let showLinkerPapers = true; // Toggle for shared reference (yellow hexagon) nodes

// Fields state
let selectedField = null;
let currentSearchScope = null;
let fieldTopologyViz = null;

// Path finder state
let pathFinderMode = false;
let pathAuthor1 = null; // { authorId, name }
let pathAuthor2 = null; // { authorId, name }
let pathSearchResults1 = [];
let pathSearchResults2 = [];
let nameMatchMode = 'full'; // 'full', 'first', 'last', 'all'

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
// OpenAlex Data Normalization
// ============================================

/**
 * Normalize OpenAlex author object
 */
function normalizeAuthor(author) {
  if (!author) return null;

  const shortId = author.id ? author.id.replace('https://openalex.org/', '') : null;

  return {
    authorId: shortId,
    openAlexId: author.id,
    name: author.display_name || 'Unknown',
    orcid: author.orcid ? author.orcid.replace('https://orcid.org/', '') : null,
    paperCount: author.works_count || 0,
    citationCount: author.cited_by_count || 0,
    hIndex: author.summary_stats?.h_index || null,
    i10Index: author.summary_stats?.i10_index || null,
    affiliations: (author.last_known_institutions || []).map(inst => ({
      id: inst.id,
      name: inst.display_name,
      country: inst.country_code
    })),
    concepts: (author.x_concepts || []).slice(0, 5).map(c => ({
      id: c.id,
      name: c.display_name,
      score: c.score
    })),
    countsByYear: author.counts_by_year || []
  };
}

/**
 * Normalize OpenAlex work object
 */
function normalizeWork(work) {
  if (!work) return null;

  const shortId = work.id ? work.id.replace('https://openalex.org/', '') : null;

  return {
    workId: shortId,
    openAlexId: work.id,
    doi: work.doi ? work.doi.replace('https://doi.org/', '') : null,
    title: work.display_name || work.title || 'Untitled',
    year: work.publication_year,
    citationCount: work.cited_by_count || 0,
    type: work.type,
    authors: (work.authorships || []).map(authorship => ({
      authorId: authorship.author?.id?.replace('https://openalex.org/', ''),
      openAlexId: authorship.author?.id,
      name: authorship.author?.display_name || 'Unknown',
      orcid: authorship.author?.orcid?.replace('https://orcid.org/', ''),
      position: authorship.author_position // 'first', 'middle', 'last'
    })),
    concepts: (work.concepts || []).slice(0, 5).map(c => ({
      id: c.id,
      name: c.display_name,
      score: c.score,
      level: c.level
    })),
    isRetracted: work.is_retracted || false,
    externalIds: { DOI: work.doi ? work.doi.replace('https://doi.org/', '') : null }
  };
}

// ============================================
// Persistent Author Cache
// ============================================

async function loadPersistentCache() {
  const result = await chrome.storage.local.get(['cachedAuthors']);
  const cached = result.cachedAuthors || {};
  const now = Date.now();
  for (const [id, entry] of Object.entries(cached)) {
    if (now - entry.cachedAt < CACHE_TTL) {
      authorCache.set(id, entry.data);
    }
  }
}

function cacheAuthor(id, authorData) {
  authorCache.set(id, authorData);
  // Persist to storage (async, fire-and-forget)
  chrome.storage.local.get(['cachedAuthors'], (result) => {
    const cached = result.cachedAuthors || {};
    cached[id] = { data: authorData, cachedAt: Date.now() };
    const entries = Object.entries(cached);
    if (entries.length > CACHE_MAX_ENTRIES) {
      entries.sort((a, b) => a[1].cachedAt - b[1].cachedAt);
      const trimmed = Object.fromEntries(entries.slice(-CACHE_MAX_ENTRIES));
      chrome.storage.local.set({ cachedAuthors: trimmed });
    } else {
      chrome.storage.local.set({ cachedAuthors: cached });
    }
  });
}

function saveNetworkState() {
  if (!currentCentralAuthorId) return;
  chrome.storage.local.set({ lastNetwork: {
    authorId: currentCentralAuthorId,
    timestamp: Date.now()
  }});
}

async function restoreLastNetwork() {
  const result = await chrome.storage.local.get(['lastNetwork']);
  if (result.lastNetwork && Date.now() - result.lastNetwork.timestamp < CACHE_TTL) {
    loadAuthorNetwork(result.lastNetwork.authorId);
  }
}

// ============================================
// Web Worker Initialization
// ============================================

async function initWorker() {
  if (typeof Worker === 'undefined') return;
  try {
    const w = new Worker('network-worker.js');
    w.onmessage = function(e) {
      if (e.data && e.data.type === 'rateLimitUpdate') {
        chrome.storage.local.set({ rateLimitData: e.data.data });
      }
    };
    w.onerror = function(e) {
      console.error('Worker error:', e);
    };

    // The worker cannot read chrome.storage, so pass the key in. Assign the
    // shared `worker` only afterwards, so nothing can dispatch an
    // unauthenticated request through it in the meantime.
    w.postMessage({ type: 'setApiKey', payload: { key: await ANE.getKey() } });
    worker = w;
  } catch (error) {
    console.warn('Web Worker not available:', error);
  }
}

// Keep the worker's copy of the key current if it changes in the settings page.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[ANE.STORAGE_KEY] && worker) {
    worker.postMessage({
      type: 'setApiKey',
      payload: { key: changes[ANE.STORAGE_KEY].newValue || '' }
    });
  }
});

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
// Search Authors using OpenAlex
// ============================================

async function searchAuthors(query) {
  if (!query.trim()) return;

  const limitSelect = document.getElementById('limitSelect');
  const limit = limitSelect ? limitSelect.value : 25;

  searchResults.innerHTML = '<div class="search-result">Searching...</div>';
  searchResults.classList.add('visible');

  try {
    // OpenAlex direct author search
    const url = `${OPENALEX_BASE}/authors?search=${encodeURIComponent(query)}&per_page=${limit}`;

    const response = await fetch(url);

    if (!response.ok) {
      searchResults.innerHTML = `<div class="search-result" style="color: #ef4444;">API error (${response.status})</div>`;
      return;
    }

    const data = await response.json();
    const authors = (data.results || []).map(author => normalizeAuthor(author));

    if (authors.length > 0) {
      searchResults.innerHTML = `
        <div class="combine-bar" id="combineBar" style="display: none;">
          <span class="combine-count"><span id="selectedCount">0</span> selected</span>
          <button class="combine-btn" id="combineBtn">Combine</button>
        </div>
        ${authors.map(author => `
          <div class="search-result" data-id="${author.authorId}">
            <input type="checkbox" class="author-checkbox" data-id="${author.authorId}" data-name="${author.name}">
            <span class="result-name">${author.name}${author.orcid ? ' <span class="verified-badge" title="ORCID verified">&#x2713;</span>' : ''}</span>
            <span class="result-stats">${author.paperCount} papers | ${formatNumber(author.citationCount)} citations${author.hIndex ? ' | h:' + author.hIndex : ''}</span>
          </div>
        `).join('')}
      `;

      authors.forEach(author => cacheAuthor(author.authorId, author));

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
  // Hide placeholder when loading a network
  const placeholder = document.getElementById('networkPlaceholder');
  if (placeholder) placeholder.style.display = 'none';

  showLoading(true);
  expandedNetworks = [];

  try {
    const cleanId = authorId.replace('https://openalex.org/', '');

    // Get author details if not cached or missing h-index
    let author = authorCache.get(cleanId);
    if (!author || !author.hIndex) {
      const authorUrl = `${OPENALEX_BASE}/authors/${cleanId}`;
      const authorResponse = await fetch(authorUrl);
      const authorData = await authorResponse.json();
      author = normalizeAuthor(authorData);
      cacheAuthor(cleanId, author);
    }

    // Fetch works by this author
    const worksUrl = `${OPENALEX_BASE}/works?filter=author.id:${cleanId}&per_page=100&sort=publication_year:desc`;
    const worksResponse = await fetch(worksUrl);
    const worksData = await worksResponse.json();
    const works = worksData.results || [];

    const papers = works.map(work => normalizeWork(work));

    currentPapersData = papers;
    currentCentralAuthorId = cleanId;

    buildNetwork(cleanId, papers);
    selectAuthor(cleanId);
    saveNetworkState();

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
      const cleanId = authorId.replace('https://openalex.org/', '');
      const url = `${OPENALEX_BASE}/works?filter=author.id:${cleanId}&per_page=100`;
      return fetch(url).then(r => r.json()).then(d => d.results || []);
    });

    const allWorkArrays = await Promise.all(paperPromises);

    const workMap = new Map();
    allWorkArrays.flat().forEach(work => {
      if (work.id && !workMap.has(work.id)) {
        workMap.set(work.id, work);
      }
    });

    const combinedWorks = Array.from(workMap.values());
    const combinedPapers = combinedWorks.map(work => normalizeWork(work));

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

    cacheAuthor(combinedAuthor.authorId, combinedAuthor);

    currentPapersData = combinedPapers;
    currentCentralAuthorId = combinedAuthor.authorId;

    buildCombinedNetwork(combinedAuthor.authorId, combinedAuthorIds, combinedPapers);
    selectAuthor(combinedAuthor.authorId);
    saveNetworkState();

  } catch (error) {
    console.error('Error loading combined network:', error);
  } finally {
    showLoading(false);
  }
}

// ============================================
// Build Network
// ============================================

// Check if author should be included based on position filter
// OpenAlex provides author_position: 'first', 'middle', 'last'
function shouldIncludeAuthor(author, authors) {
  if (authorFilter === 'all') return true;

  // OpenAlex provides position directly on the author object
  const position = author.position;

  switch (authorFilter) {
    case 'senior-first':
      return position === 'first' || position === 'last';
    case 'senior':
      return position === 'last';
    case 'first':
      return position === 'first';
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
        if (!shouldIncludeAuthor(author, paper.authors)) return;

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

  // Build clusterData for sidebar with topic labels
  sortedClusters.forEach(([clusterId, members], index) => {
    const color = clusterColors[index % clusterColors.length];

    // Collect concepts from papers associated with this cluster's members
    const conceptCounts = new Map();
    members.forEach(authorId => {
      const coauthorData = coauthorMap.get(authorId);
      if (coauthorData && coauthorData.sharedPapers) {
        coauthorData.sharedPapers.forEach(paperIdx => {
          const paper = papers[paperIdx];
          if (paper && paper.concepts) {
            paper.concepts.forEach(concept => {
              // Weight by score and prefer higher-level (more specific) concepts
              const weight = (concept.score || 0.5) * (concept.level >= 1 ? 1.5 : 1);
              conceptCounts.set(concept.name, (conceptCounts.get(concept.name) || 0) + weight);
            });
          }
        });
      }
    });

    // Find top concepts for this cluster
    const sortedConcepts = Array.from(conceptCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);

    clusterData.push({
      id: clusterId,
      color: color,
      members: members,
      count: members.length,
      topics: sortedConcepts
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
    cacheAuthor(centralAuthorId, author);
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
        if (!shouldIncludeAuthor(author, paper.authors)) return;

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

  // Build clusterData with topic labels (same as buildNetwork)
  sortedClusters.forEach(([clusterId, members], index) => {
    const color = clusterColors[index % clusterColors.length];

    const conceptCounts = new Map();
    members.forEach(authorId => {
      const coauthorData = coauthorMap.get(authorId);
      if (coauthorData && coauthorData.sharedPapers) {
        coauthorData.sharedPapers.forEach(paperIdx => {
          const paper = papers[paperIdx];
          if (paper && paper.concepts) {
            paper.concepts.forEach(concept => {
              const weight = (concept.score || 0.5) * (concept.level >= 1 ? 1.5 : 1);
              conceptCounts.set(concept.name, (conceptCounts.get(concept.name) || 0) + weight);
            });
          }
        });
      }
    });

    const sortedConcepts = Array.from(conceptCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);

    clusterData.push({
      id: clusterId,
      color: color,
      members: members,
      count: members.length,
      topics: sortedConcepts
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

  clusterList.innerHTML = clusterData.map(cluster => {
    const topicLabel = cluster.topics && cluster.topics.length > 0
      ? cluster.topics[0]
      : `Cluster ${cluster.id + 1}`;
    const topicTags = cluster.topics && cluster.topics.length > 1
      ? cluster.topics.slice(1, 3).map(t => `<span class="cluster-topic-tag">${t}</span>`).join('')
      : '';

    return `
      <div class="cluster-item" data-cluster="${cluster.id}">
        <div class="cluster-header">
          <span class="cluster-color" style="background: ${cluster.color};"></span>
          <span class="cluster-name" title="${cluster.topics ? cluster.topics.join(', ') : ''}">${topicLabel}</span>
          <span class="cluster-count">${cluster.count}</span>
        </div>
        ${topicTags ? `<div class="cluster-topics">${topicTags}</div>` : ''}
      </div>
    `;
  }).join('');

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
    const cleanId = authorId.replace('https://openalex.org/', '');
    const url = `${OPENALEX_BASE}/works?filter=author.id:${cleanId}&per_page=50`;

    const response = await fetch(url);
    const data = await response.json();
    const works = data.results || [];
    const papers = works.map(work => normalizeWork(work));

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
        if (!shouldIncludeAuthor(author, paper.authors)) return;

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
      const cleanId = authorId.replace('https://openalex.org/', '');
      const url = `${OPENALEX_BASE}/authors/${cleanId}`;

      const response = await fetch(url);
      const data = await response.json();

      author = normalizeAuthor(data);
      cacheAuthor(authorId, author);
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

  // Update h-index
  const hIndexEl = document.getElementById('hIndex');
  if (hIndexEl) {
    hIndexEl.textContent = author.hIndex ?? '-';
  }

  // Update link - use ORCID if available, otherwise OpenAlex profile
  const link = document.getElementById('scholarLink');
  if (link) {
    if (author.orcid) {
      link.href = `https://orcid.org/${author.orcid}`;
      link.textContent = 'View on ORCID';
    } else if (author.authorId) {
      link.href = `https://openalex.org/authors/${author.authorId}`;
      link.textContent = 'View on OpenAlex';
    } else {
      link.href = `https://openalex.org/authors?search=${encodeURIComponent(author.name)}`;
      link.textContent = 'Search on OpenAlex';
    }
    link.style.display = 'inline';
  }

  // Reset retraction stat
  const retractionStat = document.getElementById('retractionStat');
  const retractionCount = document.getElementById('retractionCount');
  if (retractionStat && retractionCount) {
    retractionStat.classList.remove('clean');
    retractionStat.classList.add('loading');
    retractionCount.textContent = '-';
  }

  // Render citation timeline
  renderCitationTimeline(author);

  // Render obscure papers
  renderObscurePapers(author.authorId);

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

// Find "obscure" papers - papers with concepts that differ most from the author's typical research
/**
 * Get all author IDs currently in the network (central author + all coauthors)
 */
function getNetworkAuthorIds() {
  const authorIds = new Set();

  // Add central author
  if (currentCentralAuthorId) {
    authorIds.add(currentCentralAuthorId);
  }

  // Add all authors from nodes
  nodes.forEach(node => {
    if (node.authorId) {
      authorIds.add(node.authorId);
    }
  });

  return authorIds;
}

/**
 * Fetch papers that cite the central author's work
 */
async function fetchCitingWorks(authorId, limit = 50) {
  try {
    // Get works that cite this author's papers
    const url = `${OPENALEX_BASE}/works?filter=cites:${authorId}&per_page=${limit}&select=id,doi,display_name,publication_year,cited_by_count,authorships,concepts`;
    const response = await fetch(url);
    if (!response.ok) return [];

    const data = await response.json();
    return (data.results || []).map(normalizeWork);
  } catch (error) {
    console.error('Error fetching citing works:', error);
    return [];
  }
}

/**
 * Find papers citing this author that are from OUTSIDE the network
 * These are truly "unexpected" - papers from unrelated researchers citing this author's work
 */
function findObscurePapers(citingPapers, networkAuthorIds, authorConceptProfile) {
  if (!citingPapers || citingPapers.length === 0) return [];

  // Filter out papers by any author in the network
  const outsidePapers = citingPapers.filter(paper => {
    if (!paper.authors || paper.authors.length === 0) return true;
    // Check if ANY author of this paper is in the network
    const hasNetworkAuthor = paper.authors.some(author =>
      author.authorId && networkAuthorIds.has(author.authorId)
    );
    return !hasNetworkAuthor;
  });

  if (outsidePapers.length === 0) return [];

  // Calculate "obscurity" score for each paper (how different from central author's profile)
  const paperScores = outsidePapers.map(paper => {
    if (!paper.concepts || paper.concepts.length === 0 || !authorConceptProfile || authorConceptProfile.size === 0) {
      return { paper, obscurityScore: 0.5 }; // Default score for papers without concepts
    }

    // Calculate how much this paper's concepts deviate from the author's profile
    let profileMatch = 0;
    let paperConceptWeight = 0;

    paper.concepts.forEach(concept => {
      const weight = concept.score || 0.5;
      const profileWeight = authorConceptProfile.get(concept.name) || 0;
      profileMatch += weight * profileWeight;
      paperConceptWeight += weight;
    });

    // Lower match = more obscure
    const normalizedMatch = paperConceptWeight > 0 ? profileMatch / paperConceptWeight : 0;
    const obscurityScore = 1 - normalizedMatch;

    return { paper, obscurityScore };
  });

  // Sort by obscurity (highest first) and return top 3
  return paperScores
    .filter(p => p.obscurityScore > 0.2) // Only papers that are at least somewhat obscure
    .sort((a, b) => b.obscurityScore - a.obscurityScore)
    .slice(0, 3)
    .map(p => ({
      ...p.paper,
      obscurityScore: p.obscurityScore
    }));
}

/**
 * Build concept profile from an author's papers
 */
function buildConceptProfile(papers) {
  const conceptProfile = new Map();
  let totalConceptWeight = 0;

  papers.forEach(paper => {
    if (paper.concepts) {
      paper.concepts.forEach(concept => {
        const weight = concept.score || 0.5;
        conceptProfile.set(concept.name, (conceptProfile.get(concept.name) || 0) + weight);
        totalConceptWeight += weight;
      });
    }
  });

  // Normalize profile
  if (totalConceptWeight > 0) {
    conceptProfile.forEach((weight, name) => {
      conceptProfile.set(name, weight / totalConceptWeight);
    });
  }

  return conceptProfile;
}

// Render obscure papers section - papers citing this author from OUTSIDE the network
async function renderObscurePapers(authorId) {
  const container = document.getElementById('obscurePapers');
  if (!container) return;

  // Only show for central author
  if (authorId !== currentCentralAuthorId || !currentPapersData) {
    container.style.display = 'none';
    return;
  }

  // Show loading state
  container.style.display = 'block';
  container.innerHTML = `
    <h3 style="font-size: 12px; margin-bottom: 8px; color: #888;">Unexpected Citations</h3>
    <div style="font-size: 11px; color: #666;">Loading...</div>
  `;

  // Get network author IDs to exclude
  const networkAuthorIds = getNetworkAuthorIds();

  // Build concept profile from central author's papers
  const authorConceptProfile = buildConceptProfile(currentPapersData);

  // Fetch papers that cite this author's work
  const citingWorks = await fetchCitingWorks(currentCentralAuthorId, 100);

  // Find obscure papers from outside the network
  const obscurePapers = findObscurePapers(citingWorks, networkAuthorIds, authorConceptProfile);

  if (obscurePapers.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.innerHTML = `
    <h3 style="font-size: 12px; margin-bottom: 8px; color: #888;">Unexpected Citations</h3>
    <p style="font-size: 9px; color: #666; margin-bottom: 8px;">Papers citing this author from outside the network</p>
    <div class="obscure-papers-list">
      ${obscurePapers.map(paper => `
        <div class="obscure-paper-item" title="Topical difference: ${Math.round(paper.obscurityScore * 100)}%">
          <a href="${paper.doi ? `https://doi.org/${paper.doi}` : '#'}" target="_blank" class="obscure-paper-title">
            ${paper.title || 'Untitled'}
          </a>
          <div class="obscure-paper-meta">
            ${paper.authors && paper.authors.length > 0 ? `<span class="obscure-author">${paper.authors[0].name}${paper.authors.length > 1 ? ' et al.' : ''}</span>` : ''}
            ${paper.year ? `<span class="obscure-year">(${paper.year})</span>` : ''}
          </div>
          <div class="obscure-paper-concepts">
            ${(paper.concepts || []).slice(0, 2).map(c => `<span class="concept-tag">${c.name}</span>`).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// Render citation timeline using OpenAlex counts_by_year data
function renderCitationTimeline(author) {
  const container = document.getElementById('citationTimeline');
  const chartEl = document.getElementById('timelineChart');
  const startLabel = document.getElementById('timelineStart');
  const endLabel = document.getElementById('timelineEnd');
  const trendEl = document.getElementById('citationTrend');

  if (!container || !chartEl) return;

  const countsByYear = author.countsByYear || [];
  if (countsByYear.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';

  // Sort by year and get last 10 years
  const sortedData = countsByYear
    .filter(d => d.year && d.cited_by_count !== undefined)
    .sort((a, b) => a.year - b.year)
    .slice(-10);

  if (sortedData.length < 2) {
    container.style.display = 'none';
    return;
  }

  const years = sortedData.map(d => d.year);
  const citations = sortedData.map(d => d.cited_by_count);
  const maxCitations = Math.max(...citations, 1);

  // Update labels
  startLabel.textContent = years[0];
  endLabel.textContent = years[years.length - 1];

  // Calculate trend (last 3 years vs previous 3 years)
  const recent = citations.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const previous = citations.slice(-6, -3).reduce((a, b) => a + b, 0) / 3;
  const trend = getTrendIndicator(recent, previous);
  if (trend && trendEl) {
    trendEl.innerHTML = `<span class="${trend.class}">${trend.icon} ${recent > previous ? 'Up' : recent < previous ? 'Down' : 'Stable'}</span>`;
  } else if (trendEl) {
    trendEl.textContent = '-';
  }

  // Create SVG chart
  const width = chartEl.offsetWidth || 250;
  const height = 50;
  const padding = 4;

  // Build path for line and area
  const points = citations.map((c, i) => {
    const x = padding + (i / (citations.length - 1)) * (width - padding * 2);
    const y = height - padding - (c / maxCitations) * (height - padding * 2);
    return { x, y };
  });

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const areaPath = linePath + ` L ${points[points.length - 1].x} ${height} L ${points[0].x} ${height} Z`;

  chartEl.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgb(6, 182, 212)" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="rgb(6, 182, 212)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path class="timeline-area" d="${areaPath}"/>
      <path class="timeline-line" d="${linePath}"/>
      ${points.map((p, i) => `
        <circle class="timeline-dot" cx="${p.x}" cy="${p.y}" r="4">
          <title>${years[i]}: ${formatNumber(citations[i])} citations</title>
        </circle>
      `).join('')}
    </svg>
  `;
}

// ============================================
// Retraction Checking (uses OpenAlex is_retracted field)
// ============================================

const authorRetractionCache = new Map();

async function checkAuthorRetractions(authorId) {
  const retractionStat = document.getElementById('retractionStat');
  const retractionCountEl = document.getElementById('retractionCount');

  if (!retractionStat || !retractionCountEl) return;

  // Use papers we already have if this is the central author
  let allPapers = [];
  const currentAuthor = authorCache.get(currentCentralAuthorId);

  if (currentAuthor && currentAuthor.isCombined && currentPapersData) {
    allPapers = currentPapersData;
  } else if (authorId === currentCentralAuthorId && currentPapersData) {
    allPapers = currentPapersData;
  } else {
    // Coauthor — fetch their papers from API
    try {
      const cleanId = authorId.replace('https://openalex.org/', '');
      const url = `${OPENALEX_BASE}/works?filter=author.id:${cleanId}&per_page=100&sort=publication_year:desc`;
      const response = await fetch(url);
      const data = await response.json();
      allPapers = (data.results || []).map(work => normalizeWork(work));
    } catch (e) {
      console.error('Error fetching papers for retraction check:', e);
    }
  }

  // Guard against stale results if user clicked another author while fetching
  if (selectedAuthorId !== authorId) return;

  if (allPapers.length === 0) {
    retractionStat.classList.remove('clean', 'loading');
    retractionCountEl.textContent = '-';
    return;
  }

  const retractedPapers = allPapers.filter(p => p.isRetracted);
  const count = retractedPapers.length;

  retractionStat.classList.remove('loading');
  retractionCountEl.textContent = count;

  if (count === 0) {
    retractionStat.classList.add('clean');
    retractionStat.title = 'No retracted papers found';
  } else {
    retractionStat.classList.remove('clean');
    retractionStat.title = `${count} retracted paper${count > 1 ? 's' : ''}`;
  }

  // Cache for the retracted papers panel
  const retractionMap = new Map();
  retractedPapers.forEach(p => {
    retractionMap.set(p.doi || p.workId, { isRetracted: true, source: 'openalex' });
  });
  authorRetractionCache.set(authorId, retractionMap);
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
      // Fetch from OpenAlex for secondary authors
      const cleanId = authorId.replace('https://openalex.org/', '');
      const url = `${OPENALEX_BASE}/works?filter=author.id:${cleanId}&per_page=100&sort=cited_by_count:desc`;

      const response = await fetch(url);
      const data = await response.json();
      papers = (data.results || []).map(w => ({
        ...normalizeWork(w),
        url: w.doi ? w.doi : null
      }));
    }

    if (papers.length > 0) {
      papers.sort((a, b) => (b.citationCount || 0) - (a.citationCount || 0));

      // Store papers reference for collection add
      papersList._papersData = papers;

      papersList.innerHTML = papers.map((paper, idx) => `
        <div class="paper-item${paper.isRetracted ? ' retracted' : ''}" data-paper-id="${paper.doi || idx}" data-paper-idx="${idx}" draggable="true">
          <div class="paper-title-row">
            <a class="paper-title" href="${paper.url || '#'}" target="_blank">
              ${paper.title || 'Untitled'}
            </a>
            ${paper.isRetracted ? '<span class="retraction-badge">RETRACTED</span>' : ''}
            <img class="paper-collect-btn" data-paper-idx="${idx}" title="Add to collection" src="icons/ane-collection-icon.svg" alt="Add to collection">
          </div>
          <div class="paper-meta">
            <span>${paper.year || 'N/A'}</span>
            <span>${paper.citationCount || 0} citations</span>
          </div>
        </div>
      `).join('');

      // Collection icon click handlers
      papersList.querySelectorAll('.paper-collect-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const idx = parseInt(btn.dataset.paperIdx);
          const paper = papers[idx];
          if (paper) addPaperToQuickCollection(paper);
          // Animate
          btn.style.transform = 'scale(1.3)';
          btn.style.opacity = '0.5';
          setTimeout(() => { btn.style.transform = ''; btn.style.opacity = ''; }, 300);
        });
      });

      // Prevent links from hijacking drag
      papersList.querySelectorAll('.paper-item a').forEach(a => {
        a.setAttribute('draggable', 'false');
      });

      // Drag start for papers (to drag into collections in left panel)
      papersList.querySelectorAll('.paper-item[draggable]').forEach(el => {
        el.addEventListener('dragstart', (e) => {
          // Don't drag if clicking the collection icon or a link
          if (e.target.classList.contains('paper-collect-btn')) {
            e.preventDefault();
            return;
          }
          const idx = parseInt(el.dataset.paperIdx);
          const paper = papers[idx];
          if (!paper) return;
          e.dataTransfer.setData('text/plain', JSON.stringify({
            workId: paper.workId || null,
            doi: paper.doi || null,
            title: paper.title,
            year: paper.year,
            citationCount: paper.citationCount || 0,
            authors: paper.authors || [],
            concepts: paper.concepts || [],
            fromAuthorPanel: true
          }));
        });
      });

    } else {
      papersList.innerHTML = '<div style="color: #888; padding: 10px;">No papers found</div>';
    }
  } catch (error) {
    console.error('Error loading papers:', error);
    papersList.innerHTML = '<div style="color: #e74c3c; padding: 10px;">Error loading papers</div>';
  }
}

function loadRetractedPapers(authorId) {
  const retractedPanel = document.getElementById('retractedPanel');
  const retractedList = document.getElementById('retractedList');

  retractedPanel.classList.add('visible');

  // Use current papers data directly (isRetracted comes from OpenAlex)
  const retractedPapers = (currentPapersData || []).filter(p => p.isRetracted);

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
        </div>
      </div>
    `).join('');
  } else {
    retractedList.innerHTML = '<div style="color: #888; padding: 10px;">No retracted papers found</div>';
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
// Collections (Paper Discovery)
// ============================================

async function loadCollections() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['paperCollections'], (result) => {
      collections = result.paperCollections || [];
      renderCollectionsList();
      resolve(collections);
    });
  });
}

async function saveCollections() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ paperCollections: collections }, resolve);
  });
}

function createCollection(name) {
  const collection = {
    id: `col_${Date.now()}`,
    name: name || 'New Collection',
    papers: [],
    createdAt: Date.now()
  };
  collections.push(collection);
  saveCollections();
  renderCollectionsList();
  return collection;
}

function deleteCollection(collectionId) {
  const index = collections.findIndex(c => c.id === collectionId);
  if (index >= 0) {
    collections.splice(index, 1);
    if (activeCollectionId === collectionId) {
      activeCollectionId = null;
    }
    saveCollections();
    renderCollectionsList();
    renderCollectionView();
  }
}

function addPaperToCollection(collectionId, paper) {
  const collection = collections.find(c => c.id === collectionId);
  if (!collection) return false;

  // Check if paper already exists
  if (collection.papers.some(p => p.workId === paper.workId)) {
    return false;
  }

  collection.papers.push({
    workId: paper.workId,
    doi: paper.doi,
    title: paper.title,
    year: paper.year,
    citationCount: paper.citationCount,
    authors: (paper.authors || []).slice(0, 5).map(a => ({ authorId: a.authorId, name: a.name })),
    concepts: paper.concepts || [],
    references: paper.references || [],
    addedAt: Date.now()
  });

  saveCollections();
  renderCollectionView();
  return true;
}

function addPaperToQuickCollection(paper) {
  // Find or create Quick Collection
  let qc = collections.find(c => isQuickCollection(c));
  if (!qc) {
    qc = {
      id: `col_${Date.now()}`,
      name: 'Quick Collection',
      isQuickCollection: true,
      papers: [],
      createdAt: Date.now()
    };
    collections.push(qc);
    saveCollections();
  }
  addPaperToCollection(qc.id, paper);
  renderCollectionsList();
  renderCollectionsList2();
}

function removePaperFromCollection(collectionId, workId) {
  const collection = collections.find(c => c.id === collectionId);
  if (!collection) return;

  const index = collection.papers.findIndex(p => p.workId === workId);
  if (index >= 0) {
    collection.papers.splice(index, 1);
    saveCollections();
    renderCollectionView();
    renderCollectionsList();
    renderCollectionsList2();
  }
}

// Search papers for adding to collections
async function searchPapersForCollection(query) {
  const resultsContainer = document.getElementById('paperSearchResults');
  if (!resultsContainer) return;

  resultsContainer.innerHTML = '<div class="paper-search-loading">Searching papers...</div>';

  try {
    const url = `${OPENALEX_BASE}/works?search=${encodeURIComponent(query)}&per_page=20`;
    const response = await fetch(url);
    const data = await response.json();

    const papers = (data.results || []).map(work => ({
      workId: work.id?.replace('https://openalex.org/', ''),
      doi: work.doi?.replace('https://doi.org/', ''),
      title: work.display_name || work.title || 'Untitled',
      year: work.publication_year,
      citationCount: work.cited_by_count || 0,
      authors: (work.authorships || []).map(a => ({
        authorId: a.author?.id?.replace('https://openalex.org/', ''),
        name: a.author?.display_name || 'Unknown'
      })),
      concepts: (work.concepts || []).slice(0, 5).map(c => ({
        id: c.id,
        name: c.display_name,
        score: c.score
      })),
      references: work.referenced_works || []
    }));

    if (papers.length === 0) {
      resultsContainer.innerHTML = '<div class="paper-search-empty">No papers found</div>';
      return;
    }

    resultsContainer.innerHTML = papers.map(paper => {
      const authorStr = paper.authors.slice(0, 3).map(a => a.name).join(', ');
      const inCollection = activeCollectionId &&
        collections.find(c => c.id === activeCollectionId)?.papers.some(p => p.workId === paper.workId);

      return `
        <div class="paper-search-item ${inCollection ? 'in-collection' : ''}" data-work-id="${paper.workId}">
          <div class="paper-search-title">${paper.title}</div>
          <div class="paper-search-meta">
            <span>${paper.year || 'N/A'}</span>
            <span>${paper.citationCount} citations</span>
            <span>${authorStr}${paper.authors.length > 3 ? '...' : ''}</span>
          </div>
          <button class="add-to-collection-btn" data-work-id="${paper.workId}" ${inCollection ? 'disabled' : ''}>
            ${inCollection ? '✓ Added' : '+ Add'}
          </button>
        </div>
      `;
    }).join('');

    // Cache papers for adding
    papers.forEach(p => collectionPaperCache.set(p.workId, p));

    // Add click handlers
    resultsContainer.querySelectorAll('.add-to-collection-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!activeCollectionId) {
          alert('Please select or create a collection first');
          return;
        }
        const workId = btn.dataset.workId;
        const paper = collectionPaperCache.get(workId);
        if (paper && addPaperToCollection(activeCollectionId, paper)) {
          btn.textContent = '✓ Added';
          btn.disabled = true;
          btn.closest('.paper-search-item').classList.add('in-collection');
        }
      });
    });

  } catch (error) {
    console.error('Paper search error:', error);
    resultsContainer.innerHTML = '<div class="paper-search-error">Search failed. Please try again.</div>';
  }
}

// Discovery algorithm - find papers connected to collection but not in it
async function discoverMissingPapers(collectionId) {
  const collection = collections.find(c => c.id === collectionId);
  if (!collection || collection.papers.length === 0) return [];

  const suggestionsContainer = document.getElementById('discoverySuggestions');
  if (suggestionsContainer) {
    suggestionsContainer.innerHTML = '<div class="discovery-loading">Analyzing connections...</div>';
  }

  try {
    // Get all paper IDs in collection
    const collectionWorkIds = new Set(collection.papers.map(p => p.workId));

    // Collect all references from collection papers
    const referenceCounts = new Map();
    const authorCounts = new Map();

    // Fetch full details for papers to get references
    const paperDetailsPromises = collection.papers.slice(0, 30).map(async (paper) => {
      if (paper.references && paper.references.length > 0) {
        return paper;
      }
      // Fetch full paper details
      try {
        const url = `${OPENALEX_BASE}/works/${paper.workId}`;
        const response = await fetch(url);
        const data = await response.json();
        return {
          ...paper,
          references: data.referenced_works || [],
          citedBy: data.cited_by_api_url
        };
      } catch (e) {
        return paper;
      }
    });

    const papersWithRefs = await Promise.all(paperDetailsPromises);

    // Count reference frequencies
    papersWithRefs.forEach(paper => {
      // Count references
      (paper.references || []).forEach(refId => {
        const cleanId = refId.replace('https://openalex.org/', '');
        if (!collectionWorkIds.has(cleanId)) {
          referenceCounts.set(cleanId, (referenceCounts.get(cleanId) || 0) + 1);
        }
      });

      // Count author co-occurrences
      (paper.authors || []).forEach(author => {
        if (author.authorId) {
          authorCounts.set(author.authorId, (authorCounts.get(author.authorId) || 0) + 1);
        }
      });
    });

    // Get top referenced papers (cited by multiple papers in collection)
    const topReferences = Array.from(referenceCounts.entries())
      .filter(([_, count]) => count >= 2) // At least 2 papers reference it
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    if (topReferences.length === 0) {
      if (suggestionsContainer) {
        suggestionsContainer.innerHTML = '<div class="discovery-empty">Add more papers to get suggestions</div>';
      }
      return [];
    }

    // Fetch details for suggested papers
    const suggestionIds = topReferences.map(([id]) => id);
    const filterStr = suggestionIds.slice(0, 50).join('|');
    const suggestUrl = `${OPENALEX_BASE}/works?filter=ids.openalex:${filterStr}&per_page=50`;

    const suggestResponse = await fetch(suggestUrl);
    const suggestData = await suggestResponse.json();

    const suggestions = (suggestData.results || []).map(work => {
      const workId = work.id?.replace('https://openalex.org/', '');
      const connectionCount = referenceCounts.get(workId) || 0;

      return {
        workId,
        doi: work.doi?.replace('https://doi.org/', ''),
        title: work.display_name || 'Untitled',
        year: work.publication_year,
        citationCount: work.cited_by_count || 0,
        authors: (work.authorships || []).slice(0, 3).map(a => ({
          authorId: a.author?.id?.replace('https://openalex.org/', ''),
          name: a.author?.display_name || 'Unknown'
        })),
        concepts: (work.concepts || []).slice(0, 3).map(c => ({
          name: c.display_name
        })),
        connectionCount,
        references: work.referenced_works || []
      };
    }).sort((a, b) => b.connectionCount - a.connectionCount);

    renderDiscoverySuggestions(suggestions, collectionId);
    return suggestions;

  } catch (error) {
    console.error('Discovery error:', error);
    if (suggestionsContainer) {
      suggestionsContainer.innerHTML = '<div class="discovery-error">Discovery failed. Please try again.</div>';
    }
    return [];
  }
}

// Check if a collection is a Quick Collection
function isQuickCollection(col) {
  return col.isQuickCollection === true || col.name === 'Quick Collection';
}

// Render collections list (left panel) with Quick Collection section
function renderCollectionsList() {
  const container = document.getElementById('collectionsList');
  if (!container) return;

  const quickCollections = collections.filter(c => isQuickCollection(c));
  const regularCollections = collections.filter(c => !isQuickCollection(c));

  if (collections.length === 0) {
    container.innerHTML = `
      <div class="collections-empty">
        <img src="icons/ane-collection-icon.svg" style="width:24px;height:24px;margin-bottom:8px;">
        <div>No collections yet</div>
        <div style="font-size: 10px; margin-top: 4px;">Create one to start discovering papers</div>
      </div>
    `;
    return;
  }

  let html = '';

  // Quick Collection section
  quickCollections.forEach(qc => {
    html += `<div class="quick-collection-section" data-quick-id="${qc.id}">
      <div class="quick-collection-header">
        Quick Collection (${qc.papers.length} papers)
      </div>`;

    if (qc.papers.length > 0) {
      html += qc.papers.map(paper => `
        <div class="quick-paper-item" draggable="true" data-work-id="${paper.workId}" data-quick-collection-id="${qc.id}">
          <span class="paper-title" title="${paper.title}">${paper.title}</span>
          <button class="remove-btn" draggable="false" data-work-id="${paper.workId}" data-collection-id="${qc.id}">&times;</button>
        </div>
      `).join('');

      html += `<div class="quick-collection-actions">
        <button class="convert-collection-btn" data-quick-id="${qc.id}">Turn into Collection</button>
        <button class="clear-collection-btn" data-quick-id="${qc.id}">Clear</button>
      </div>`;
    } else {
      html += '<div style="font-size: 10px; color: #666; padding: 8px;">Add papers from Google Scholar</div>';
    }

    html += '</div>';
  });

  // Regular collections
  html += regularCollections.map(col => `
    <div class="collection-item ${activeCollectionId === col.id ? 'active' : ''}" data-id="${col.id}">
      <div class="collection-info">
        <div class="collection-name">${col.name}</div>
        <div class="collection-count">${col.papers.length} papers</div>
      </div>
      <button class="delete-collection-btn" data-id="${col.id}" title="Delete">&times;</button>
    </div>
  `).join('');

  container.innerHTML = html;

  // Quick Collection: remove paper buttons
  container.querySelectorAll('.quick-paper-item .remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removePaperFromCollection(btn.dataset.collectionId, btn.dataset.workId);
      if (activeTab === 'collections') {
        renderCollectionView2();
        buildActiveCollectionNetwork();
      }
    });
  });

  // Quick Collection: drag start
  container.querySelectorAll('.quick-paper-item[draggable]').forEach(el => {
    el.addEventListener('dragstart', (e) => {
      if (e.target.classList.contains('remove-btn')) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData('text/plain', JSON.stringify({
        workId: el.dataset.workId,
        quickCollectionId: el.dataset.quickCollectionId
      }));
    });
  });

  // Regular collection items: click + drag-over/drop handlers
  container.querySelectorAll('.collection-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('delete-collection-btn')) return;
      const id = el.dataset.id;
      activeCollectionId = id;
      addedSuggestionIds.clear();
      renderCollectionsList();
      renderCollectionView();
      if (activeTab === 'collections') {
        renderCollectionsList2();
        renderCollectionView2();
        buildActiveCollectionNetwork();
      }
    });

    // Drag-and-drop: allow dropping Quick Collection papers
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('drag-over');
    });

    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) {
        el.classList.remove('drag-over');
      }
    });

    el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drag-over');
      try {
        const data = JSON.parse(e.dataTransfer.getData('text/plain'));
        const targetCollectionId = el.dataset.id;

        if (data.fromAuthorPanel) {
          // Dropped from author papers panel
          addPaperToCollection(targetCollectionId, data);
          renderCollectionsList();
          renderCollectionView();
          if (activeTab === 'collections') {
            renderCollectionsList2();
            renderCollectionView2();
            buildActiveCollectionNetwork();
          }
        } else {
          // Dropped from Quick Collection
          const sourceCollection = collections.find(c => c.id === data.quickCollectionId);
          if (!sourceCollection) return;

          const paper = sourceCollection.papers.find(p => p.workId === data.workId);
          if (!paper) return;

          if (addPaperToCollection(targetCollectionId, paper)) {
            removePaperFromCollection(data.quickCollectionId, data.workId);
            if (activeTab === 'collections') {
              renderCollectionView2();
              buildActiveCollectionNetwork();
            }
          }
        }
      } catch (err) {
        console.error('Drop error:', err);
      }
    });
  });

  // Delete collection handlers
  container.querySelectorAll('.delete-collection-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Delete this collection?')) {
        deleteCollection(btn.dataset.id);
        if (activeTab === 'collections') {
          renderCollectionsList2();
          renderCollectionView2();
          buildActiveCollectionNetwork();
        }
      }
    });
  });

  // "Turn into Collection" button
  container.querySelectorAll('.convert-collection-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const quickId = btn.dataset.quickId;
      const qc = collections.find(c => c.id === quickId);
      if (!qc || qc.papers.length === 0) return;

      const name = prompt('Collection name:');
      if (!name || !name.trim()) return;

      const newCol = createCollection(name.trim());
      // Move papers from Quick Collection to new collection
      qc.papers.forEach(paper => addPaperToCollection(newCol.id, paper));
      qc.papers = [];
      saveCollections();
      activeCollectionId = newCol.id;
      renderCollectionsList();
      renderCollectionView();
      if (activeTab === 'collections') {
        renderCollectionsList2();
        renderCollectionView2();
        buildActiveCollectionNetwork();
      }
    });
  });

  // "Clear" button
  container.querySelectorAll('.clear-collection-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Clear all papers from Quick Collection?')) return;
      const quickId = btn.dataset.quickId;
      const qc = collections.find(c => c.id === quickId);
      if (!qc) return;
      qc.papers = [];
      saveCollections();
      renderCollectionsList();
      if (activeTab === 'collections') {
        renderCollectionsList2();
        renderCollectionView2();
        buildActiveCollectionNetwork();
      }
    });
  });
}

// Render active collection view
function renderCollectionView() {
  const container = document.getElementById('collectionView');
  if (!container) return;

  if (!activeCollectionId) {
    container.innerHTML = '<div class="collection-view-empty">Select a collection to view</div>';
    return;
  }

  const collection = collections.find(c => c.id === activeCollectionId);
  if (!collection) return;

  container.innerHTML = `
    <div class="collection-header">
      <h3>${collection.name}</h3>
      <button class="export-collection-btn" id="exportCollectionBtn" title="Export as CSV">&#x2B07;</button>
      <button class="discover-btn" id="discoverBtn">🔍 Find Missing</button>
    </div>
    <div class="collection-papers">
      ${collection.papers.length === 0 ?
        '<div class="collection-papers-empty">Search and add papers above</div>' :
        collection.papers.map(paper => `
          <div class="collection-paper-item" data-work-id="${paper.workId}">
            <div class="collection-paper-title">
              <a href="${paper.doi ? `https://doi.org/${paper.doi}` : '#'}" target="_blank">${paper.title}</a>
            </div>
            <div class="collection-paper-meta">
              ${paper.year || 'N/A'} · ${paper.citationCount} citations
            </div>
            <button class="remove-paper-btn" data-work-id="${paper.workId}">&times;</button>
          </div>
        `).join('')
      }
    </div>
    <div class="discovery-section">
      <h4>Suggestions</h4>
      <div id="discoverySuggestions" class="discovery-suggestions">
        <div class="discovery-hint">Click "Find Missing" to discover related papers</div>
      </div>
    </div>
  `;

  // Add handlers
  document.getElementById('exportCollectionBtn')?.addEventListener('click', () => {
    exportCollectionCSV(activeCollectionId);
  });
  document.getElementById('discoverBtn')?.addEventListener('click', () => {
    discoverMissingPapers(activeCollectionId);
  });

  container.querySelectorAll('.remove-paper-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removePaperFromCollection(activeCollectionId, btn.dataset.workId);
    });
  });
}

// Render discovery suggestions
function renderDiscoverySuggestions(suggestions, collectionId) {
  const container = document.getElementById('discoverySuggestions');
  if (!container) return;

  if (suggestions.length === 0) {
    container.innerHTML = '<div class="discovery-empty">No suggestions found. Add more papers to your collection.</div>';
    return;
  }

  container.innerHTML = suggestions.map(paper => {
    const isAdded = addedSuggestionIds.has(paper.workId);
    return `
      <div class="suggestion-item ${isAdded ? 'added' : ''}" data-work-id="${paper.workId}">
        <div class="suggestion-connection">
          <span class="connection-badge">${paper.connectionCount} links</span>
        </div>
        <div class="suggestion-title">
          <a href="${paper.doi ? `https://doi.org/${paper.doi}` : '#'}" target="_blank">${paper.title}</a>
        </div>
        <div class="suggestion-meta">
          ${paper.year || 'N/A'} · ${paper.citationCount} citations
          ${paper.authors.length > 0 ? ' · ' + paper.authors.map(a => a.name).join(', ') : ''}
        </div>
        <div class="suggestion-concepts">
          ${paper.concepts.map(c => `<span class="concept-tag">${c.name}</span>`).join('')}
        </div>
        <button class="add-suggestion-btn" data-work-id="${paper.workId}" ${isAdded ? 'disabled' : ''}>
          ${isAdded ? '✓ Added' : '+ Add to collection'}
        </button>
      </div>
    `;
  }).join('');

  // Cache and add handlers
  suggestions.forEach(p => collectionPaperCache.set(p.workId, p));

  container.querySelectorAll('.add-suggestion-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const workId = btn.dataset.workId;
      const paper = collectionPaperCache.get(workId);
      if (paper && addPaperToCollection(collectionId, paper)) {
        // Track added suggestion and update UI without re-rendering all
        addedSuggestionIds.add(workId);
        btn.textContent = '✓ Added';
        btn.disabled = true;
        btn.closest('.suggestion-item').classList.add('added');
        // Only update the collection papers list
        updateCollectionPapersList();
      }
    });
  });
}

// Update just the papers list in collection view (without clearing suggestions)
function updateCollectionPapersList() {
  const collection = collections.find(c => c.id === activeCollectionId);
  if (!collection) return;

  const papersContainer = document.querySelector('#collectionView .collection-papers');
  if (!papersContainer) return;

  papersContainer.innerHTML = collection.papers.length === 0 ?
    '<div class="collection-papers-empty">Search and add papers above</div>' :
    collection.papers.map(paper => `
      <div class="collection-paper-item" data-work-id="${paper.workId}">
        <div class="collection-paper-title">
          <a href="${paper.doi ? `https://doi.org/${paper.doi}` : '#'}" target="_blank">${paper.title}</a>
        </div>
        <div class="collection-paper-meta">
          ${paper.year || 'N/A'} · ${paper.citationCount} citations
        </div>
        <button class="remove-paper-btn" data-work-id="${paper.workId}">&times;</button>
      </div>
    `).join('');

  papersContainer.querySelectorAll('.remove-paper-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removePaperFromCollection(activeCollectionId, btn.dataset.workId);
    });
  });
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
// Tab System
// ============================================

function setActiveTab(tab) {
  activeTab = tab;

  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  // Update viewport visibility
  document.getElementById('authorsViewport')?.classList.toggle('active', tab === 'authors');
  document.getElementById('collectionsViewport')?.classList.toggle('active', tab === 'collections');
  document.getElementById('fieldsViewport')?.classList.toggle('active', tab === 'fields');

  // Update left panel visibility for authors + collections tabs
  const leftPanel = document.getElementById('leftPanel');
  if (leftPanel) {
    leftPanel.style.display = (tab === 'authors' || tab === 'collections') ? '' : 'none';
  }

  // Tab-specific initialization
  if (tab === 'collections') {
    initCollectionsTab();
  } else if (tab === 'fields') {
    initFieldsTab();
  }
}

function initCollectionsTab() {
  renderCollectionsList2();
  createCollectionSubtabs();

  // Always sync linker toggle state when entering collections tab
  const linkerToggle = document.getElementById('linkerToggle');
  if (linkerToggle) {
    linkerToggle.style.background = showLinkerPapers ? '#eab308' : '#1a1a2e';
    linkerToggle.style.color = showLinkerPapers ? '#1a1a2e' : '#888';
    linkerToggle.style.borderColor = showLinkerPapers ? '#eab308' : '#333';
    linkerToggle.style.display = collectionSubTab === 'papers' ? '' : 'none';
  }

  if (activeCollectionId) {
    renderCollectionView2();
    // Wait for container to be visible and have dimensions
    setTimeout(() => {
      if (collectionSubTab === 'papers') {
        buildPaperNetwork();
      } else {
        buildCollectionAuthorNetwork();
      }
    }, 100);
  }
}

function initFieldsTab() {
  // Wait for container to be visible before initializing
  setTimeout(() => {
    if (typeof FieldTopologyVisualizer !== 'undefined' && !fieldTopologyViz) {
      fieldTopologyViz = new FieldTopologyVisualizer('fieldsCanvas');
    } else if (fieldTopologyViz && fieldTopologyViz.network) {
      // Redraw if already initialized
      fieldTopologyViz.network.redraw();
      fieldTopologyViz.network.fit();
    }
  }, 100);
}

// ============================================
// Paper Network Visualization (Collections)
// ============================================

function initPaperNetwork() {
  const container = document.getElementById('collectionPaperNetworkContainer');
  if (!container) return;

  // Make sure container has dimensions
  if (container.offsetWidth === 0 || container.offsetHeight === 0) {
    setTimeout(() => initPaperNetwork(), 100);
    return;
  }

  paperNodes = new vis.DataSet();
  paperEdges = new vis.DataSet();

  const options = {
    nodes: {
      shape: 'diamond',
      scaling: { min: 15, max: 35, label: { enabled: true, min: 12, max: 20 } },
      font: { color: '#fff', size: 12 },
      color: { background: '#8b5cf6', border: '#a78bfa', highlight: { background: '#a78bfa', border: '#c4b5fd' } }
    },
    edges: {
      color: { color: '#444', highlight: '#4ecca3' },
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

  paperNetwork = new vis.Network(container, { nodes: paperNodes, edges: paperEdges }, options);

  paperNetwork.on('click', (params) => {
    if (params.nodes.length > 0) {
      showPaperDetails(params.nodes[0]);
    }
  });

  paperNetwork.on('stabilized', () => {
    paperNetwork.setOptions({ physics: { enabled: false } });
  });

  // Create dynamic legend after network init
  updateCollectionsLegend();
}

function buildPaperNetwork() {
  if (!activeCollectionId) return;

  const collection = collections.find(c => c.id === activeCollectionId);
  if (!collection || collection.papers.length === 0) {
    if (paperNodes) paperNodes.clear();
    if (paperEdges) paperEdges.clear();
    return;
  }

  if (!paperNetwork) {
    initPaperNetwork();
  }

  paperNodes.clear();
  paperEdges.clear();

  const papers = collection.papers;
  const workIds = new Set(papers.map(p => p.workId));

  // Detect clusters using citation/reference relationships
  const clusterEdges = [];
  papers.forEach(paper => {
    (paper.references || []).forEach(ref => {
      const cleanRef = ref.replace('https://openalex.org/', '');
      if (workIds.has(cleanRef)) {
        clusterEdges.push({ from: paper.workId, to: cleanRef });
      }
    });
  });
  const paperClusterMap = detectClusters(papers.map(p => p.workId), clusterEdges);

  // Add paper nodes colored by cluster
  papers.forEach(paper => {
    const citationSize = 10 + Math.log(Math.max(paper.citationCount || 1, 1)) * 3;
    const clusterIdx = paperClusterMap.get(paper.workId) || 0;
    const clusterColor = clusterColors[clusterIdx % clusterColors.length];
    paperNodes.add({
      id: paper.workId,
      label: truncateText(paper.title, 25),
      title: `${paper.title}\n${paper.year || 'N/A'} · ${paper.citationCount || 0} citations`,
      size: Math.min(citationSize, 30),
      color: { background: clusterColor, border: clusterColor },
      cluster: clusterIdx
    });
  });

  // Find citation relationships (direct citations between papers in collection)
  const edgeSet = new Set();
  papers.forEach(paper => {
    (paper.references || []).forEach(refId => {
      const cleanRef = refId.replace('https://openalex.org/', '');
      if (workIds.has(cleanRef)) {
        const edgeKey = `${paper.workId}->${cleanRef}`;
        if (!edgeSet.has(edgeKey)) {
          edgeSet.add(edgeKey);
          paperEdges.add({
            from: paper.workId,
            to: cleanRef,
            color: '#22c55e',
            width: 2,
            arrows: 'to'
          });
        }
      }
    });
  });

  // Find shared reference relationships — show linking paper as a small hexagon
  const refToPapers = new Map();
  papers.forEach(paper => {
    (paper.references || []).forEach(ref => {
      const cleanRef = ref.replace('https://openalex.org/', '');
      if (!refToPapers.has(cleanRef)) refToPapers.set(cleanRef, []);
      refToPapers.get(cleanRef).push(paper.workId);
    });
  });

  const sharedRefIds = new Set();
  refToPapers.forEach((paperIds, refId) => {
    if (paperIds.length >= 2 && !workIds.has(refId)) {
      sharedRefIds.add(refId);
      // Add small hexagon node for the shared reference
      paperNodes.add({
        id: `ref_${refId}`,
        label: '',
        title: `Shared reference\n${refId}`,
        size: 8,
        shape: 'hexagon',
        color: { background: '#eab308', border: '#ca8a04' },
        font: { size: 0 },
        _isSharedRef: true,
        _refWorkId: refId
      });
      // Connect each paper that cites this reference
      paperIds.forEach(paperId => {
        const edgeKey = `${paperId}->ref_${refId}`;
        if (!edgeSet.has(edgeKey)) {
          edgeSet.add(edgeKey);
          paperEdges.add({
            from: paperId,
            to: `ref_${refId}`,
            color: '#eab308',
            width: 1,
            dashes: true
          });
        }
      });
    }
  });

  // Fetch titles for shared reference nodes in the background
  if (sharedRefIds.size > 0) {
    fetchSharedRefTitles(Array.from(sharedRefIds));
  }

  // Sync linker toggle: show/hide based on whether this collection has linkers
  const hasLinkers = sharedRefIds.size > 0;
  const linkerToggle = document.getElementById('linkerToggle');
  if (linkerToggle) {
    if (hasLinkers) {
      linkerToggle.style.display = collectionSubTab === 'papers' ? '' : 'none';
      linkerToggle.style.background = showLinkerPapers ? '#eab308' : '#1a1a2e';
      linkerToggle.style.color = showLinkerPapers ? '#1a1a2e' : '#888';
      linkerToggle.style.borderColor = showLinkerPapers ? '#eab308' : '#333';
    } else {
      linkerToggle.style.display = 'none';
    }
  }

  // Re-enable physics to spread nodes (stabilized event will disable it)
  paperNetwork.setOptions({ physics: { enabled: true } });
}

// Fetch titles for shared reference hexagon nodes
async function fetchSharedRefTitles(refIds) {
  // Batch fetch via OpenAlex filter (up to 50 at a time)
  const batchSize = 50;
  for (let i = 0; i < refIds.length; i += batchSize) {
    const batch = refIds.slice(i, i + batchSize);
    const filter = batch.map(id => `https://openalex.org/${id}`).join('|');
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'fetchOpenAlex',
        endpoint: `/works?filter=openalex:${encodeURIComponent(filter)}&per_page=${batch.length}&select=id,display_name,publication_year,cited_by_count,doi`
      });
      if (response?.success && response.data?.results) {
        response.data.results.forEach(work => {
          const shortId = work.id.replace('https://openalex.org/', '');
          const nodeId = `ref_${shortId}`;
          try {
            const existing = paperNodes.get(nodeId);
            if (existing) {
              paperNodes.update({
                id: nodeId,
                title: `${work.display_name || 'Unknown'}\n${work.publication_year || 'N/A'} · ${work.cited_by_count || 0} citations\n(shared reference — not in collection)`,
                _refTitle: work.display_name,
                _refYear: work.publication_year,
                _refCitations: work.cited_by_count,
                _refDoi: work.doi ? work.doi.replace('https://doi.org/', '') : null
              });
            }
          } catch (e) { /* node may have been cleared */ }
        });
      }
    } catch (e) {
      console.error('Error fetching shared ref titles:', e);
    }
  }
}

function truncateText(text, maxLen) {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 3) + '...';
}

function showPaperDetails(workId) {
  const panel = document.getElementById('paperDetailPanel');
  const content = document.getElementById('paperDetailContent');
  if (!panel || !content) return;

  // Reset header to paper mode
  const header = panel.querySelector('h3');
  if (header) header.textContent = 'Selected Paper';

  // Check if this is a shared reference node
  if (workId.startsWith('ref_')) {
    try {
      const node = paperNodes.get(workId);
      if (node) {
        const title = node._refTitle || 'Shared Reference';
        const doi = node._refDoi;
        const refWorkId = node._refWorkId || workId.replace('ref_', '');
        const collection = collections.find(c => c.id === activeCollectionId);
        const alreadyInCollection = collection && collection.papers.some(p => p.workId === refWorkId);

        content.innerHTML = `
          <div class="paper-detail-title">
            <a href="${doi ? `https://doi.org/${doi}` : '#'}" target="_blank">${title}</a>
          </div>
          <div class="paper-detail-meta">
            ${node._refYear || 'N/A'} · ${node._refCitations || 0} citations
          </div>
          <div style="display: flex; align-items: center; gap: 8px; margin-top: 8px;">
            <span style="font-size: 10px; color: #eab308;">Shared reference</span>
            <button class="add-ref-to-collection-btn"
              style="background: ${alreadyInCollection ? 'transparent' : '#eab308'}; color: ${alreadyInCollection ? '#22c55e' : '#1a1a2e'};
                     border: 1px solid ${alreadyInCollection ? '#22c55e' : '#eab308'}; border-radius: 4px;
                     padding: 3px 10px; font-size: 12px; cursor: pointer; font-weight: bold;">
              ${alreadyInCollection ? '\u2713' : '+'}
            </button>
          </div>
        `;

        if (!alreadyInCollection) {
          content.querySelector('.add-ref-to-collection-btn')?.addEventListener('click', (e) => {
            const btn = e.currentTarget;
            const paper = {
              workId: refWorkId,
              doi: doi ? doi.replace('https://doi.org/', '') : null,
              title: title,
              year: node._refYear || null,
              citationCount: node._refCitations || 0,
              authors: [],
              concepts: [],
              references: []
            };
            addPaperToCollection(activeCollectionId, paper);
            renderCollectionsList();
            renderCollectionsList2();
            btn.textContent = '\u2713';
            btn.style.background = 'transparent';
            btn.style.color = '#22c55e';
            btn.style.borderColor = '#22c55e';
          });
        }

        panel.style.display = 'block';
        return;
      }
    } catch (e) { /* node not found */ }
    return;
  }

  const collection = collections.find(c => c.id === activeCollectionId);
  if (!collection) return;

  const paper = collection.papers.find(p => p.workId === workId);
  if (!paper) return;

  content.innerHTML = `
    <div class="paper-detail-title">
      <a href="${paper.doi ? `https://doi.org/${paper.doi}` : '#'}" target="_blank">${paper.title}</a>
    </div>
    <div class="paper-detail-meta">
      ${paper.year || 'N/A'} · ${paper.citationCount || 0} citations
    </div>
    <div class="paper-detail-authors">
      ${(paper.authors || []).map(a => a.name).join(', ')}
    </div>
    <div class="paper-detail-concepts">
      ${(paper.concepts || []).map(c => `<span class="concept-tag">${c.name}</span>`).join('')}
    </div>
    <button class="remove-paper-detail-btn" data-work-id="${workId}"
      style="margin-top: 10px; padding: 6px 12px; background: transparent; color: #888;
             border: 1px solid #444; border-radius: 4px; font-size: 11px; cursor: pointer; width: 100%;">
      Remove from collection
    </button>
  `;

  content.querySelector('.remove-paper-detail-btn')?.addEventListener('click', (e) => {
    const wid = e.currentTarget.dataset.workId;
    removePaperFromCollection(activeCollectionId, wid);
    panel.style.display = 'none';
    renderCollectionView2();
    buildActiveCollectionNetwork();
  });

  panel.style.display = 'block';
}

// ============================================
// Collections Subtabs (Papers / Authors)
// ============================================

function createCollectionSubtabs() {
  const parent = document.getElementById('collectionsNetwork');
  if (!parent || parent.querySelector('.collections-subtabs')) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'collections-subtabs';

  ['papers', 'authors'].forEach(tab => {
    const btn = document.createElement('button');
    btn.className = 'collections-subtab-btn';
    btn.dataset.subtab = tab;
    btn.textContent = tab === 'papers' ? 'Papers' : 'Authors';
    const isActive = tab === collectionSubTab;
    btn.style.background = isActive ? '#4ecca3' : '#1a1a2e';
    btn.style.color = isActive ? '#1a1a2e' : '#888';
    btn.style.borderColor = isActive ? '#4ecca3' : '#333';
    btn.addEventListener('click', () => setCollectionSubTab(tab));
    wrapper.appendChild(btn);
  });

  parent.appendChild(wrapper);

  // Linker papers toggle (right side, only visible on papers subtab)
  if (!parent.querySelector('.collections-linker-toggle')) {
    const toggle = document.createElement('button');
    toggle.className = 'collections-linker-toggle';
    toggle.id = 'linkerToggle';
    toggle.textContent = 'Linkers';
    toggle.style.cssText = `
      position: absolute; top: 12px; right: 12px; z-index: 20;
      padding: 6px 12px; border-radius: 4px; font-size: 11px; cursor: pointer;
      transition: all 0.2s;
      background: ${showLinkerPapers ? '#eab308' : '#1a1a2e'};
      color: ${showLinkerPapers ? '#1a1a2e' : '#888'};
      border: 1px solid ${showLinkerPapers ? '#eab308' : '#333'};
    `;
    toggle.addEventListener('click', () => toggleLinkerPapers());
    parent.appendChild(toggle);
  }

  // Sync position with left panel state
  syncCollectionsOverlayPositions();
}

function syncCollectionsOverlayPositions() {
  const leftPanel = document.getElementById('leftPanel');
  const isExpanded = leftPanel && leftPanel.classList.contains('expanded');
  const offset = isExpanded ? '300px' : '12px';

  const subtabs = document.querySelector('.collections-subtabs');
  if (subtabs) subtabs.style.left = offset;

  const legend = document.querySelector('.collections-legend');
  if (legend) legend.style.left = offset;
}

function toggleLinkerPapers() {
  showLinkerPapers = !showLinkerPapers;

  // Update toggle button style
  const toggle = document.getElementById('linkerToggle');
  if (toggle) {
    toggle.style.background = showLinkerPapers ? '#eab308' : '#1a1a2e';
    toggle.style.color = showLinkerPapers ? '#1a1a2e' : '#888';
    toggle.style.borderColor = showLinkerPapers ? '#eab308' : '#333';
  }

  if (!paperNodes) return;

  // Show/hide shared ref nodes and their edges
  const refNodeIds = paperNodes.getIds().filter(id => typeof id === 'string' && id.startsWith('ref_'));
  refNodeIds.forEach(id => {
    paperNodes.update({ id, hidden: !showLinkerPapers });
  });

  // Hide/show edges connected to ref nodes
  if (paperEdges) {
    paperEdges.forEach(edge => {
      const toRef = typeof edge.to === 'string' && edge.to.startsWith('ref_');
      const fromRef = typeof edge.from === 'string' && edge.from.startsWith('ref_');
      if (toRef || fromRef) {
        paperEdges.update({ id: edge.id, hidden: !showLinkerPapers });
      }
    });
  }
}

function setCollectionSubTab(tab) {
  collectionSubTab = tab;

  // Update button styles
  const buttons = document.querySelectorAll('.collections-subtab-btn');
  buttons.forEach(btn => {
    const isActive = btn.dataset.subtab === tab;
    btn.style.background = isActive ? '#4ecca3' : '#1a1a2e';
    btn.style.color = isActive ? '#1a1a2e' : '#888';
    btn.style.borderColor = isActive ? '#4ecca3' : '#333';
  });

  // Toggle container visibility
  const paperContainer = document.getElementById('collectionPaperNetworkContainer');
  const authorContainer = document.getElementById('collectionAuthorNetworkContainer');

  if (tab === 'papers') {
    if (paperContainer) paperContainer.style.display = '';
    if (authorContainer) authorContainer.style.display = 'none';
    // Rebuild paper network if there's an active collection
    if (activeCollectionId && paperNetwork) {
      paperNetwork.redraw();
      paperNetwork.fit();
    }
  } else {
    if (paperContainer) paperContainer.style.display = 'none';
    if (authorContainer) authorContainer.style.display = '';
    // Build author network if needed
    if (activeCollectionId) {
      buildCollectionAuthorNetwork();
    }
  }

  // Show/hide linker toggle (only for papers subtab)
  const linkerToggle = document.getElementById('linkerToggle');
  if (linkerToggle) linkerToggle.style.display = tab === 'papers' ? '' : 'none';

  // Update legend
  updateCollectionsLegend();

  // Hide paper detail panel when switching
  const panel = document.getElementById('paperDetailPanel');
  if (panel) panel.style.display = 'none';
}

function updateCollectionsLegend() {
  const parent = document.getElementById('collectionsNetwork');
  if (!parent) return;

  // Remove existing legend
  const existing = parent.querySelector('.collections-legend');
  if (existing) existing.remove();

  const legend = document.createElement('div');
  legend.className = 'collections-legend';

  if (collectionSubTab === 'papers') {
    legend.innerHTML = `
      <div class="legend-item">
        <span class="legend-color" style="background: #8b5cf6; width: 10px; height: 10px; border-radius: 2px;"></span>
        <span>Collection paper</span>
      </div>
      <div class="legend-item">
        <span class="legend-color" style="background: #eab308; width: 10px; height: 10px; clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);"></span>
        <span>Shared reference</span>
      </div>
      <div class="legend-item">
        <span style="color: #22c55e; font-size: 10px;">&#x2192;</span>
        <span>Cites</span>
      </div>
      <div class="legend-item">
        <span style="color: #eab308; font-size: 10px;">- -</span>
        <span>Shared ref link</span>
      </div>
    `;
  } else {
    legend.innerHTML = `
      <div class="legend-item">
        <span class="legend-color" style="background: ${clusterColors[0]}; width: 10px; height: 10px;"></span>
        <span>Author (by cluster)</span>
      </div>
      <div class="legend-item">
        <span style="color: #555; font-size: 10px;">━━</span>
        <span>Collaboration</span>
      </div>
    `;
  }

  parent.appendChild(legend);
  syncCollectionsOverlayPositions();
}

function buildCollectionAuthorNetwork() {
  if (!activeCollectionId) return;

  const collection = collections.find(c => c.id === activeCollectionId);
  if (!collection || collection.papers.length === 0) {
    if (collectionAuthorNodes) collectionAuthorNodes.clear();
    if (collectionAuthorEdges) collectionAuthorEdges.clear();
    return;
  }

  const container = document.getElementById('collectionAuthorNetworkContainer');
  if (!container) return;

  // Make sure container is visible and has dimensions
  container.style.display = '';
  if (container.offsetWidth === 0 || container.offsetHeight === 0) {
    setTimeout(() => buildCollectionAuthorNetwork(), 100);
    return;
  }

  // Build author map
  const authorMap = new Map(); // authorName -> { papers: [paper], paperCount: number }
  collection.papers.forEach(paper => {
    (paper.authors || []).forEach(author => {
      const name = author.name;
      if (!name) return;
      if (!authorMap.has(name)) {
        authorMap.set(name, { name, papers: [], authorId: author.authorId || null });
      }
      authorMap.get(name).papers.push(paper);
    });
  });

  // Build coauthor edges
  const edgeMap = new Map(); // "name1|||name2" -> sharedPaperCount
  collection.papers.forEach(paper => {
    const authors = (paper.authors || []).map(a => a.name).filter(Boolean);
    for (let i = 0; i < authors.length; i++) {
      for (let j = i + 1; j < authors.length; j++) {
        const key = [authors[i], authors[j]].sort().join('|||');
        edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
      }
    }
  });

  // Detect clusters
  const authorNames = Array.from(authorMap.keys());
  const clusterEdges = [];
  edgeMap.forEach((count, key) => {
    const [from, to] = key.split('|||');
    clusterEdges.push({ from, to, weight: count });
  });

  const clusters = detectClusters(authorNames, clusterEdges);

  // Build cluster membership
  const clusterMembers = new Map();
  clusters.forEach((clusterId, authorName) => {
    if (!clusterMembers.has(clusterId)) clusterMembers.set(clusterId, []);
    clusterMembers.get(clusterId).push(authorName);
  });
  const sortedClusters = Array.from(clusterMembers.entries())
    .sort((a, b) => b[1].length - a[1].length);

  // Build cluster index map for coloring
  const authorClusterIndex = new Map();
  sortedClusters.forEach(([clusterId, members], index) => {
    members.forEach(name => authorClusterIndex.set(name, index));
  });

  // Create datasets
  if (!collectionAuthorNodes) {
    collectionAuthorNodes = new vis.DataSet();
    collectionAuthorEdges = new vis.DataSet();
  } else {
    collectionAuthorNodes.clear();
    collectionAuthorEdges.clear();
  }

  // Create nodes
  authorMap.forEach((data, name) => {
    const paperCount = data.papers.length;
    const clusterIdx = authorClusterIndex.get(name) || 0;
    const color = clusterColors[clusterIdx % clusterColors.length];

    collectionAuthorNodes.add({
      id: name,
      label: name,
      size: Math.min(12 + paperCount * 4, 35),
      color: { background: color, border: color, highlight: { background: color, border: '#fff' } },
      title: `${paperCount} paper${paperCount !== 1 ? 's' : ''} in collection`,
      font: { color: '#fff', size: 12 },
      _authorData: data
    });
  });

  // Create edges
  edgeMap.forEach((count, key) => {
    const [from, to] = key.split('|||');
    collectionAuthorEdges.add({
      from, to,
      width: Math.min(1 + count * 0.5, 6),
      color: { color: '#555' }
    });
  });

  // Init or update network
  if (!collectionAuthorNetwork) {
    const options = {
      nodes: {
        shape: 'dot',
        scaling: { min: 10, max: 35, label: { enabled: true, min: 12, max: 20 } },
        font: { color: '#fff', size: 12 }
      },
      edges: {
        color: { color: '#555', highlight: '#4ecca3' },
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

    collectionAuthorNetwork = new vis.Network(container, {
      nodes: collectionAuthorNodes,
      edges: collectionAuthorEdges
    }, options);

    collectionAuthorNetwork.on('stabilized', () => {
      collectionAuthorNetwork.setOptions({ physics: { enabled: false } });
    });

    collectionAuthorNetwork.on('click', (params) => {
      if (params.nodes.length > 0) {
        showCollectionAuthorDetails(params.nodes[0]);
      }
    });
  } else {
    collectionAuthorNetwork.setData({
      nodes: collectionAuthorNodes,
      edges: collectionAuthorEdges
    });
    collectionAuthorNetwork.setOptions({ physics: { enabled: true } });
  }
}

function showCollectionAuthorDetails(authorName) {
  const panel = document.getElementById('paperDetailPanel');
  const content = document.getElementById('paperDetailContent');
  if (!panel || !content) return;

  const collection = collections.find(c => c.id === activeCollectionId);
  if (!collection) return;

  // Find papers by this author in the collection
  const authorPapers = collection.papers.filter(p =>
    (p.authors || []).some(a => a.name === authorName)
  );

  content.innerHTML = `
    <h3 style="font-size: 14px; color: #4ecca3; margin-bottom: 8px;">${authorName}</h3>
    <div style="font-size: 11px; color: #888; margin-bottom: 10px;">
      ${authorPapers.length} paper${authorPapers.length !== 1 ? 's' : ''} in this collection
    </div>
    <div style="max-height: 200px; overflow-y: auto;">
      ${authorPapers.map(p => `
        <div style="padding: 6px 8px; background: rgba(255,255,255,0.03); border-radius: 4px; margin-bottom: 4px;">
          <a href="${p.doi ? `https://doi.org/${p.doi}` : '#'}" target="_blank"
             style="font-size: 11px; color: #a78bfa; text-decoration: none; line-height: 1.4; display: block;">
            ${p.title}
          </a>
          <div style="font-size: 9px; color: #666; margin-top: 2px;">
            ${p.year || 'N/A'} · ${p.citationCount || 0} citations
          </div>
        </div>
      `).join('')}
    </div>
    <button id="viewInAuthorsTabBtn"
      style="margin-top: 10px; padding: 6px 12px; background: rgba(78,204,163,0.2); color: #4ecca3;
             border: 1px solid #4ecca3; border-radius: 4px; font-size: 11px; cursor: pointer; width: 100%;">
      View in Authors tab
    </button>
  `;

  document.getElementById('viewInAuthorsTabBtn')?.addEventListener('click', () => {
    viewAuthorInAuthorsTab(authorName);
  });

  // Update the panel header (first direct h3 child, not the one inside content)
  const panelHeader = panel.querySelector(':scope > h3');
  if (panelHeader) panelHeader.textContent = 'Selected Author';
  panel.style.display = 'block';
}

async function viewAuthorInAuthorsTab(authorName) {
  setActiveTab('authors');
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.value = authorName;
  }
  // Search and auto-load the top result
  try {
    const url = `${OPENALEX_BASE}/authors?search=${encodeURIComponent(authorName)}&per_page=1`;
    const response = await fetch(url);
    const data = await response.json();
    const results = data.results || [];
    if (results.length > 0) {
      const authorId = results[0].id.replace('https://openalex.org/', '');
      loadAuthorNetwork(authorId);
    } else {
      searchAuthors(authorName);
    }
  } catch (e) {
    searchAuthors(authorName);
  }
}

function buildActiveCollectionNetwork() {
  if (collectionSubTab === 'papers') {
    buildPaperNetwork();
  } else {
    buildCollectionAuthorNetwork();
  }
}

// Collections Tab specific renderers (for the Collections viewport)
function renderCollectionsList2() {
  const container = document.getElementById('collectionsList2');
  if (!container) return;

  if (collections.length === 0) {
    container.innerHTML = `
      <div class="collections-empty">
        <div>No collections yet</div>
        <div style="font-size: 10px; margin-top: 4px;">Create one to visualize paper networks</div>
      </div>
    `;
    return;
  }

  const regularCollections = collections.filter(c => !isQuickCollection(c));
  const quickCollections = collections.filter(c => isQuickCollection(c));

  let html = '';

  // Regular collections first
  html += regularCollections.map(col => `
    <div class="collection-item ${activeCollectionId === col.id ? 'active' : ''}" data-id="${col.id}">
      <div class="collection-info">
        <div class="collection-name">${col.name}</div>
        <div class="collection-count">${col.papers.length} papers</div>
      </div>
      <button class="delete-collection-btn" data-id="${col.id}" title="Delete">&times;</button>
    </div>
  `).join('');

  // Quick Collections at the bottom with draggable papers
  quickCollections.forEach(qc => {
    html += `
      <div class="collection-item ${activeCollectionId === qc.id ? 'active' : ''}" data-id="${qc.id}" style="margin-top: 8px; border-top: 1px solid #333; padding-top: 8px;">
        <div class="collection-info">
          <div class="collection-name">${qc.name}</div>
          <div class="collection-count">${qc.papers.length} papers</div>
        </div>
        <button class="delete-collection-btn" data-id="${qc.id}" title="Delete">&times;</button>
      </div>`;
    if (qc.papers.length > 0) {
      html += qc.papers.map(paper => `
        <div class="quick-paper-item" draggable="true" data-work-id="${paper.workId}" data-quick-collection-id="${qc.id}"
             style="margin-left: 8px;">
          <span class="paper-title" title="${paper.title}">${paper.title}</span>
          <button class="remove-btn" draggable="false" data-work-id="${paper.workId}" data-collection-id="${qc.id}">&times;</button>
        </div>
      `).join('');
    }
  });

  container.innerHTML = html;

  // Click handlers for all collection items
  container.querySelectorAll('.collection-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('delete-collection-btn')) return;
      activeCollectionId = el.dataset.id;
      addedSuggestionIds.clear();
      renderCollectionsList();
      renderCollectionsList2();
      renderCollectionView();
      renderCollectionView2();
      buildActiveCollectionNetwork();
    });

    // Drag-and-drop: allow dropping Quick Collection papers onto regular collections
    if (!isQuickCollection(collections.find(c => c.id === el.dataset.id) || {})) {
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.add('drag-over');
      });

      el.addEventListener('dragleave', (e) => {
        if (!el.contains(e.relatedTarget)) {
          el.classList.remove('drag-over');
        }
      });

      el.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove('drag-over');
        try {
          const data = JSON.parse(e.dataTransfer.getData('text/plain'));
          const targetCollectionId = el.dataset.id;

          if (data.fromAuthorPanel) {
            addPaperToCollection(targetCollectionId, data);
            renderCollectionsList();
            renderCollectionsList2();
            renderCollectionView();
            renderCollectionView2();
            buildActiveCollectionNetwork();
          } else {
            const sourceCollection = collections.find(c => c.id === data.quickCollectionId);
            if (!sourceCollection) return;

            const paper = sourceCollection.papers.find(p => p.workId === data.workId);
            if (!paper) return;

            if (addPaperToCollection(targetCollectionId, paper)) {
              removePaperFromCollection(data.quickCollectionId, data.workId);
              renderCollectionView2();
              buildActiveCollectionNetwork();
            }
          }
        } catch (err) {
          console.error('Drop error:', err);
        }
      });
    }
  });

  // Quick Collection: drag start for papers
  container.querySelectorAll('.quick-paper-item[draggable]').forEach(el => {
    el.addEventListener('dragstart', (e) => {
      if (e.target.classList.contains('remove-btn')) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData('text/plain', JSON.stringify({
        workId: el.dataset.workId,
        quickCollectionId: el.dataset.quickCollectionId
      }));
    });
  });

  // Quick Collection: remove paper buttons
  container.querySelectorAll('.quick-paper-item .remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removePaperFromCollection(btn.dataset.collectionId, btn.dataset.workId);
      if (activeTab === 'collections') {
        renderCollectionView2();
        buildActiveCollectionNetwork();
      }
    });
  });

  container.querySelectorAll('.delete-collection-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Delete this collection?')) {
        deleteCollection(btn.dataset.id);
        renderCollectionsList2();
        renderCollectionView2();
        buildActiveCollectionNetwork();
      }
    });
  });
}

function renderCollectionView2() {
  const container = document.getElementById('collectionView2');
  if (!container) return;

  if (!activeCollectionId) {
    container.innerHTML = '<div class="collection-view-empty">Select a collection to view</div>';
    return;
  }

  const collection = collections.find(c => c.id === activeCollectionId);
  if (!collection) return;

  container.innerHTML = `
    <div class="collection-header">
      <h3>${collection.name}</h3>
      <button class="export-collection-btn" id="exportCollectionBtn2" title="Export as CSV">&#x2B07;</button>
      <button class="discover-btn" id="discoverBtn2">🔍 Find Missing</button>
    </div>
    <div class="collection-papers">
      ${collection.papers.length === 0 ?
        '<div class="collection-papers-empty">Search and add papers above</div>' :
        collection.papers.map(paper => `
          <div class="collection-paper-item" data-work-id="${paper.workId}">
            <div class="collection-paper-title">
              <a href="${paper.doi ? `https://doi.org/${paper.doi}` : '#'}" target="_blank">${paper.title}</a>
            </div>
            <div class="collection-paper-meta">
              ${paper.year || 'N/A'} · ${paper.citationCount} citations
            </div>
            <button class="remove-paper-btn" data-work-id="${paper.workId}">&times;</button>
          </div>
        `).join('')
      }
    </div>
    <div class="discovery-section">
      <h4>Suggestions</h4>
      <div id="discoverySuggestions2" class="discovery-suggestions">
        <div class="discovery-hint">Click "Find Missing" to discover related papers</div>
      </div>
    </div>
  `;

  document.getElementById('exportCollectionBtn2')?.addEventListener('click', () => {
    exportCollectionCSV(activeCollectionId);
  });
  document.getElementById('discoverBtn2')?.addEventListener('click', () => {
    discoverMissingPapers2(activeCollectionId);
  });

  container.querySelectorAll('.remove-paper-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removePaperFromCollection(activeCollectionId, btn.dataset.workId);
      renderCollectionView2();
      buildActiveCollectionNetwork();
    });
  });
}

// Discovery for Collections tab (separate from left panel)
async function discoverMissingPapers2(collectionId) {
  const suggestionsContainer = document.getElementById('discoverySuggestions2');
  if (suggestionsContainer) {
    suggestionsContainer.innerHTML = '<div class="discovery-loading">Analyzing connections...</div>';
  }

  const suggestions = await discoverMissingPapers(collectionId);

  if (suggestionsContainer && suggestions.length > 0) {
    renderDiscoverySuggestions2(suggestions, collectionId);
  }
}

function renderDiscoverySuggestions2(suggestions, collectionId) {
  const container = document.getElementById('discoverySuggestions2');
  if (!container) return;

  if (suggestions.length === 0) {
    container.innerHTML = '<div class="discovery-empty">No suggestions found. Add more papers to your collection.</div>';
    return;
  }

  container.innerHTML = suggestions.map(paper => {
    const isAdded = addedSuggestionIds.has(paper.workId);
    return `
      <div class="suggestion-item ${isAdded ? 'added' : ''}" data-work-id="${paper.workId}">
        <div class="suggestion-connection">
          <span class="connection-badge">${paper.connectionCount} links</span>
        </div>
        <div class="suggestion-title">
          <a href="${paper.doi ? `https://doi.org/${paper.doi}` : '#'}" target="_blank">${paper.title}</a>
        </div>
        <div class="suggestion-meta">
          ${paper.year || 'N/A'} · ${paper.citationCount} citations
        </div>
        <button class="add-suggestion-btn" data-work-id="${paper.workId}" ${isAdded ? 'disabled' : ''}>
          ${isAdded ? '✓ Added' : '+ Add to collection'}
        </button>
      </div>
    `;
  }).join('');

  suggestions.forEach(p => collectionPaperCache.set(p.workId, p));

  container.querySelectorAll('.add-suggestion-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const workId = btn.dataset.workId;
      const paper = collectionPaperCache.get(workId);
      if (paper && addPaperToCollection(collectionId, paper)) {
        addedSuggestionIds.add(workId);
        btn.textContent = '✓ Added';
        btn.disabled = true;
        btn.closest('.suggestion-item').classList.add('added');
        // Update only the papers list, not the entire suggestions
        updateCollectionPapersList2();
        buildActiveCollectionNetwork();
      }
    });
  });
}

function updateCollectionPapersList2() {
  const collection = collections.find(c => c.id === activeCollectionId);
  if (!collection) return;

  const papersContainer = document.querySelector('#collectionView2 .collection-papers');
  if (!papersContainer) return;

  papersContainer.innerHTML = collection.papers.length === 0 ?
    '<div class="collection-papers-empty">Search and add papers above</div>' :
    collection.papers.map(paper => `
      <div class="collection-paper-item" data-work-id="${paper.workId}">
        <div class="collection-paper-title">
          <a href="${paper.doi ? `https://doi.org/${paper.doi}` : '#'}" target="_blank">${paper.title}</a>
        </div>
        <div class="collection-paper-meta">
          ${paper.year || 'N/A'} · ${paper.citationCount} citations
        </div>
        <button class="remove-paper-btn" data-work-id="${paper.workId}">&times;</button>
      </div>
    `).join('');

  papersContainer.querySelectorAll('.remove-paper-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removePaperFromCollection(activeCollectionId, btn.dataset.workId);
      renderCollectionView2();
      buildActiveCollectionNetwork();
    });
  });
}

// ============================================
// Fields Tab Functions
// ============================================

async function searchFields(query) {
  const resultsContainer = document.getElementById('fieldSearchResults');
  if (!resultsContainer || !query.trim()) return;

  resultsContainer.innerHTML = '<div class="paper-search-loading">Searching fields...</div>';
  resultsContainer.classList.add('visible');

  try {
    const url = `${OPENALEX_BASE}/concepts?search=${encodeURIComponent(query)}&per_page=15`;
    const response = await fetch(url);
    const data = await response.json();

    const concepts = data.results || [];

    if (concepts.length === 0) {
      resultsContainer.innerHTML = '<div class="paper-search-empty">No fields found</div>';
      return;
    }

    resultsContainer.innerHTML = concepts.map(concept => `
      <div class="paper-search-item" data-concept-id="${concept.id}" data-concept-name="${concept.display_name}">
        <div class="paper-search-title">${concept.display_name}</div>
        <div class="paper-search-meta">
          <span>Level ${concept.level}</span>
          <span>${formatNumber(concept.works_count)} works</span>
        </div>
      </div>
    `).join('');

    resultsContainer.querySelectorAll('.paper-search-item').forEach(el => {
      el.addEventListener('click', () => {
        selectField(el.dataset.conceptId, el.dataset.conceptName);
        resultsContainer.classList.remove('visible');
      });
    });

  } catch (error) {
    console.error('Field search error:', error);
    resultsContainer.innerHTML = '<div class="paper-search-error">Search failed</div>';
  }
}

async function selectField(conceptId, conceptName) {
  selectedField = { id: conceptId, name: conceptName };

  document.getElementById('selectedFieldName').textContent = conceptName;
  document.getElementById('selectedFieldInfo').style.display = 'block';
  document.getElementById('fieldPlaceholder').style.display = 'none';

  // Reset metrics
  ['instHHI', 'authorHHI', 'ingroupBias', 'recentWorks'].forEach(id => {
    document.getElementById(id).textContent = '...';
  });

  // Fetch field works and calculate metrics
  await analyzeField(conceptId);
}

async function analyzeField(conceptId) {
  try {
    const cleanId = conceptId.replace('https://openalex.org/', '');

    // Show loading state
    ['instHHI', 'authorHHI', 'ingroupBias', 'recentWorks'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '...';
    });

    // Fetch more papers for better analysis (500 total via pagination)
    let allWorks = [];
    const perPage = 200;
    const maxPages = 3; // 600 papers max

    for (let page = 1; page <= maxPages; page++) {
      const url = `${OPENALEX_BASE}/works?filter=concepts.id:${cleanId}&per_page=${perPage}&page=${page}&sort=publication_year:desc`;

      const response = await fetch(url);
      const data = await response.json();
      const works = data.results || [];

      if (works.length === 0) break;
      allWorks = allWorks.concat(works);

      // Update progress
      const el = document.getElementById('recentWorks');
      if (el) el.textContent = `Loading... ${allWorks.length}`;

      // Small delay to be nice to API
      if (page < maxPages && works.length === perPage) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    // Calculate metrics
    const metrics = calculateFieldMetrics(allWorks);

    document.getElementById('instHHI').textContent = (metrics.institutionHHI * 100).toFixed(1) + '%';
    document.getElementById('authorHHI').textContent = (metrics.authorHHI * 100).toFixed(1) + '%';
    document.getElementById('ingroupBias').textContent = (metrics.ingroupBias * 100).toFixed(0) + '%';
    document.getElementById('recentWorks').textContent = formatNumber(metrics.recentWorks);

    // Update visualization
    if (fieldTopologyViz && typeof fieldTopologyViz.updateVisualization === 'function') {
      fieldTopologyViz.updateVisualization(allWorks, metrics);
    }

  } catch (error) {
    console.error('Error analyzing field:', error);
  }
}

function calculateFieldMetrics(works) {
  const currentYear = new Date().getFullYear();
  const recentWorks = works.filter(w => w.publication_year >= currentYear - 5).length;

  // Institution HHI
  const instCounts = new Map();
  let totalInstOccurrences = 0;

  works.forEach(work => {
    (work.authorships || []).forEach(a => {
      (a.institutions || []).forEach(inst => {
        instCounts.set(inst.id, (instCounts.get(inst.id) || 0) + 1);
        totalInstOccurrences++;
      });
    });
  });

  let institutionHHI = 0;
  if (totalInstOccurrences > 0) {
    instCounts.forEach(count => {
      const share = count / totalInstOccurrences;
      institutionHHI += share * share;
    });
  }

  // Author HHI
  const authorCounts = new Map();
  let totalAuthorOccurrences = 0;

  works.forEach(work => {
    (work.authorships || []).forEach(a => {
      if (a.author?.id) {
        authorCounts.set(a.author.id, (authorCounts.get(a.author.id) || 0) + 1);
        totalAuthorOccurrences++;
      }
    });
  });

  let authorHHI = 0;
  if (totalAuthorOccurrences > 0) {
    authorCounts.forEach(count => {
      const share = count / totalAuthorOccurrences;
      authorHHI += share * share;
    });
  }

  // In-group collaboration bias
  let sameInst = 0, crossInst = 0;
  works.forEach(work => {
    const institutions = new Set();
    (work.authorships || []).forEach(a => {
      (a.institutions || []).forEach(i => institutions.add(i.id));
    });
    if (institutions.size === 1) sameInst++;
    else if (institutions.size > 1) crossInst++;
  });

  const ingroupBias = (sameInst + crossInst) > 0 ? sameInst / (sameInst + crossInst) : 0;

  return { institutionHHI, authorHHI, ingroupBias, recentWorks };
}

// Forgotten Corners Discovery
async function findForgottenCorners() {
  if (!selectedField) return;

  const cornersList = document.getElementById('cornersList');
  if (cornersList) {
    cornersList.innerHTML = '<div style="color: #888; font-size: 11px; padding: 12px;">Searching for hidden gems...</div>';
  }

  try {
    const cleanId = selectedField.id.replace('https://openalex.org/', '');

    // Get sub-concepts of this field
    const conceptUrl = `${OPENALEX_BASE}/concepts/${cleanId}`;
    const conceptResponse = await fetch(conceptUrl);
    const conceptData = await conceptResponse.json();

    const relatedConcepts = (conceptData.related_concepts || []).slice(0, 20);

    if (relatedConcepts.length === 0) {
      cornersList.innerHTML = '<div style="color: #666; font-size: 11px; padding: 12px;">No subfields found</div>';
      return;
    }

    // Analyze each related concept
    const cornerAnalysis = await Promise.all(relatedConcepts.map(async (concept) => {
      try {
        const worksUrl = `${OPENALEX_BASE}/works?filter=concepts.id:${concept.id}&per_page=50&sort=publication_year:desc`;
        const worksResponse = await fetch(worksUrl);
        const worksData = await worksResponse.json();
        const works = worksData.results || [];

        const currentYear = new Date().getFullYear();
        const recentWorks = works.filter(w => w.publication_year >= currentYear - 5).length;

        const metrics = calculateFieldMetrics(works);

        return {
          concept: {
            id: concept.id,
            display_name: concept.display_name,
            score: concept.score
          },
          metrics: {
            recentWorks,
            institutionHHI: metrics.institutionHHI,
            authorHHI: metrics.authorHHI,
            insularity: metrics.ingroupBias
          }
        };
      } catch (e) {
        return null;
      }
    }));

    // Filter out nulls and calculate hipster scores
    const validCorners = cornerAnalysis.filter(c => c !== null && c.metrics.recentWorks >= 5);

    const scoredCorners = validCorners.map(c => ({
      ...c,
      hipsterScore: calculateHipsterScore(c.metrics)
    }));

    const topCorners = scoredCorners
      .sort((a, b) => b.hipsterScore - a.hipsterScore)
      .slice(0, 8);

    renderForgottenCorners(topCorners);

  } catch (error) {
    console.error('Error finding forgotten corners:', error);
    cornersList.innerHTML = '<div style="color: #ef4444; font-size: 11px; padding: 12px;">Failed to find hidden gems</div>';
  }
}

function calculateHipsterScore(metrics) {
  // High isolation + high activity + niche = high hipster score
  return (
    metrics.insularity * 0.3 +
    (1 - metrics.institutionHHI) * 0.25 +
    (1 - metrics.authorHHI) * 0.25 +
    Math.min(metrics.recentWorks / 30, 1) * 0.2
  );
}

function renderForgottenCorners(corners) {
  const container = document.getElementById('cornersList');
  if (!container) return;

  if (corners.length === 0) {
    container.innerHTML = '<div style="color: #666; font-size: 11px; padding: 12px;">No hidden gems found in this field</div>';
    return;
  }

  container.innerHTML = corners.map(corner => `
    <div class="corner-item" data-concept-id="${corner.concept.id}">
      <div class="corner-header">
        <span class="corner-name">${corner.concept.display_name}</span>
        <span class="hipster-badge" title="Hipster Score">
          ${Math.round(corner.hipsterScore * 100)}
        </span>
      </div>
      <div class="corner-metrics">
        <span>${corner.metrics.recentWorks} recent papers</span>
        <span>${Math.round(corner.metrics.insularity * 100)}% insular</span>
      </div>
      <div class="corner-actions">
        <button class="explore-corner-btn" data-id="${corner.concept.id}" data-name="${corner.concept.display_name}">Explore</button>
        <button class="search-in-corner-btn" data-id="${corner.concept.id}" data-name="${corner.concept.display_name}">Search Papers</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.explore-corner-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectField(btn.dataset.id, btn.dataset.name);
    });
  });

  container.querySelectorAll('.search-in-corner-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setSearchScope(btn.dataset.id, btn.dataset.name);
    });
  });
}

// Scoped Paper Search
function setSearchScope(conceptId, conceptName) {
  currentSearchScope = { conceptId, conceptName };

  document.getElementById('scopedSearchSection').style.display = 'block';
  document.getElementById('scopeName').textContent = conceptName;
  document.getElementById('scopedResults').innerHTML = '';
}

function clearSearchScope() {
  currentSearchScope = null;
  document.getElementById('scopedSearchSection').style.display = 'none';
}

async function searchPapersInScope(query) {
  if (!currentSearchScope || !query.trim()) return;

  const resultsContainer = document.getElementById('scopedResults');
  resultsContainer.innerHTML = '<div class="paper-search-loading">Searching...</div>';

  try {
    const cleanId = currentSearchScope.conceptId.replace('https://openalex.org/', '');
    const url = `${OPENALEX_BASE}/works?search=${encodeURIComponent(query)}&filter=concepts.id:${cleanId}&per_page=20`;

    const response = await fetch(url);
    const data = await response.json();

    const papers = (data.results || []).map(work => ({
      workId: work.id?.replace('https://openalex.org/', ''),
      doi: work.doi?.replace('https://doi.org/', ''),
      title: work.display_name || 'Untitled',
      year: work.publication_year,
      citationCount: work.cited_by_count || 0,
      authors: (work.authorships || []).slice(0, 3).map(a => ({
        name: a.author?.display_name || 'Unknown'
      }))
    }));

    if (papers.length === 0) {
      resultsContainer.innerHTML = '<div style="color: #666; font-size: 11px; padding: 12px;">No papers found</div>';
      return;
    }

    resultsContainer.innerHTML = papers.map(paper => `
      <div class="scoped-result-item" data-work-id="${paper.workId}">
        <div class="scoped-result-title">
          <a href="${paper.doi ? `https://doi.org/${paper.doi}` : '#'}" target="_blank">${paper.title}</a>
        </div>
        <div class="scoped-result-meta">
          ${paper.year || 'N/A'} · ${paper.citationCount} citations · ${paper.authors.map(a => a.name).join(', ')}
        </div>
      </div>
    `).join('');

  } catch (error) {
    console.error('Scoped search error:', error);
    resultsContainer.innerHTML = '<div style="color: #ef4444; font-size: 11px; padding: 12px;">Search failed</div>';
  }
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
  syncCollectionsOverlayPositions();
});

// Mark all read
document.getElementById('markAllReadBtn')?.addEventListener('click', markAllPapersRead);

// Collections handlers
document.getElementById('newCollectionBtn')?.addEventListener('click', () => {
  const name = prompt('Collection name:');
  if (name && name.trim()) {
    createCollection(name.trim());
    renderCollectionsList();
  }
});

const paperSearchInput = document.getElementById('paperSearchInput');
const paperSearchResults = document.getElementById('paperSearchResults');
let paperSearchTimeout = null;

paperSearchInput?.addEventListener('input', (e) => {
  const query = e.target.value.trim();
  if (paperSearchTimeout) clearTimeout(paperSearchTimeout);

  if (query.length < 3) {
    paperSearchResults.innerHTML = '';
    paperSearchResults.classList.remove('visible');
    return;
  }

  // Debounce search
  paperSearchTimeout = setTimeout(async () => {
    paperSearchResults.innerHTML = '<div class="paper-search-loading">Searching...</div>';
    paperSearchResults.classList.add('visible');

    const results = await searchPapersForCollection(query);

    if (results.length === 0) {
      paperSearchResults.innerHTML = '<div class="paper-search-empty">No papers found</div>';
      return;
    }

    paperSearchResults.innerHTML = results.map(paper => `
      <div class="paper-search-item" data-work-id="${paper.workId}">
        <div class="paper-search-title">${paper.title}</div>
        <div class="paper-search-meta">
          <span>${paper.year || 'N/A'}</span>
          <span>${paper.citationCount} citations</span>
          <span>${paper.authors.slice(0, 2).map(a => a.name).join(', ')}${paper.authors.length > 2 ? ' et al.' : ''}</span>
        </div>
      </div>
    `).join('');

    // Cache results and add click handlers
    results.forEach(p => collectionPaperCache.set(p.workId, p));

    paperSearchResults.querySelectorAll('.paper-search-item').forEach(el => {
      el.addEventListener('click', () => {
        const workId = el.dataset.workId;
        const paper = collectionPaperCache.get(workId);
        if (paper && activeCollectionId) {
          if (addPaperToCollection(activeCollectionId, paper)) {
            el.classList.add('in-collection');
            const title = el.querySelector('.paper-search-title');
            if (title) title.innerHTML += ' <span style="color: #4ecca3;">✓</span>';
          }
        } else if (!activeCollectionId) {
          alert('Select or create a collection first');
        }
      });
    });
  }, 300);
});

// Hide paper search results on click outside
document.addEventListener('click', (e) => {
  if (paperSearchResults && !paperSearchResults.contains(e.target) && e.target !== paperSearchInput) {
    paperSearchResults.classList.remove('visible');
  }
});

// Tab click handlers
document.getElementById('authorsTab')?.addEventListener('click', () => setActiveTab('authors'));
document.getElementById('collectionsTab')?.addEventListener('click', () => setActiveTab('collections'));
document.getElementById('fieldsTab')?.addEventListener('click', () => {
  setActiveTab('fields');
  // Show work-in-progress notice
  const placeholder = document.getElementById('fieldPlaceholder');
  if (placeholder) placeholder.style.display = '';
});

// Collections Tab (viewport) handlers
document.getElementById('newCollectionBtn2')?.addEventListener('click', () => {
  const name = prompt('Collection name:');
  if (name && name.trim()) {
    createCollection(name.trim());
    renderCollectionsList();
    renderCollectionsList2();
  }
});

const collectionPaperSearch = document.getElementById('collectionPaperSearch');
const collectionPaperResults = document.getElementById('collectionPaperResults');
let collectionSearchTimeout = null;

collectionPaperSearch?.addEventListener('input', (e) => {
  const query = e.target.value.trim();
  if (collectionSearchTimeout) clearTimeout(collectionSearchTimeout);

  if (query.length < 3) {
    collectionPaperResults.innerHTML = '';
    collectionPaperResults.classList.remove('visible');
    return;
  }

  collectionSearchTimeout = setTimeout(async () => {
    collectionPaperResults.classList.add('visible');
    await searchPapersForCollection(query);

    // Re-render with handlers for collections tab
    collectionPaperResults.querySelectorAll('.add-to-collection-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!activeCollectionId) {
          alert('Please select or create a collection first');
          return;
        }
        const workId = btn.dataset.workId;
        const paper = collectionPaperCache.get(workId);
        if (paper && addPaperToCollection(activeCollectionId, paper)) {
          btn.textContent = '✓ Added';
          btn.disabled = true;
          btn.closest('.paper-search-item').classList.add('in-collection');
          renderCollectionView2();
          buildActiveCollectionNetwork();
        }
      });
    });
  }, 300);
});

document.getElementById('collectionPaperSearchBtn')?.addEventListener('click', () => {
  const query = collectionPaperSearch?.value.trim();
  if (query && query.length >= 3) {
    collectionPaperResults.classList.add('visible');
    searchPapersForCollection(query);
  }
});

// Fields Tab handlers
const fieldSearchInput = document.getElementById('fieldSearchInput');
const fieldSearchBtn = document.getElementById('fieldSearchBtn');

fieldSearchBtn?.addEventListener('click', () => {
  const query = fieldSearchInput?.value.trim();
  if (query) searchFields(query);
});

fieldSearchInput?.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    const query = fieldSearchInput?.value.trim();
    if (query) searchFields(query);
  }
});

document.getElementById('findCornersBtn')?.addEventListener('click', findForgottenCorners);
document.getElementById('clearScopeBtn')?.addEventListener('click', clearSearchScope);

document.getElementById('scopedSearchBtn')?.addEventListener('click', () => {
  const query = document.getElementById('scopedSearchInput')?.value.trim();
  if (query) searchPapersInScope(query);
});

document.getElementById('scopedSearchInput')?.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    const query = e.target.value.trim();
    if (query) searchPapersInScope(query);
  }
});

// ============================================
// Path Finder Functions
// ============================================

/**
 * Toggle between single author mode and path finder mode
 */
function setPathFinderMode(enabled) {
  pathFinderMode = enabled;

  const singleBox = document.getElementById('singleSearchBox');
  const pathBox = document.getElementById('pathFinderBox');
  const singleBtn = document.getElementById('singleModeBtn');
  const pathBtn = document.getElementById('pathModeBtn');
  const normalLegend = document.getElementById('normalLegend');
  const pathLegend = document.getElementById('pathLegend');

  if (enabled) {
    singleBox.style.display = 'none';
    pathBox.style.display = 'flex';
    singleBtn.classList.remove('active');
    pathBtn.classList.add('active');
    normalLegend.style.display = 'none';
    pathLegend.classList.remove('visible');
  } else {
    singleBox.style.display = 'flex';
    pathBox.style.display = 'none';
    singleBtn.classList.add('active');
    pathBtn.classList.remove('active');
    normalLegend.style.display = 'flex';
    pathLegend.classList.remove('visible');

    // Reset papers stat label when leaving path mode
    const papersStatLabel = document.querySelector('#papersStat .stat-label');
    if (papersStatLabel) papersStatLabel.textContent = 'Papers';
  }
}

/**
 * Search authors for path finder dropdowns
 */
async function searchPathAuthors(query, inputNumber) {
  if (!query.trim() || query.length < 2) {
    hidePathDropdown(inputNumber);
    return;
  }

  const dropdown = document.getElementById(`pathDropdown${inputNumber}`);
  if (!dropdown) return;

  dropdown.innerHTML = '<div class="path-search-item"><span class="path-search-name">Searching...</span></div>';
  dropdown.classList.add('visible');

  try {
    const url = `${OPENALEX_BASE}/authors?search=${encodeURIComponent(query)}&per_page=8`;
    const response = await fetch(url);

    if (!response.ok) {
      dropdown.innerHTML = '<div class="path-search-item"><span class="path-search-name" style="color:#ef4444;">Search failed</span></div>';
      return;
    }

    const data = await response.json();
    const authors = (data.results || []).map(a => normalizeAuthor(a));

    if (inputNumber === 1) {
      pathSearchResults1 = authors;
    } else {
      pathSearchResults2 = authors;
    }

    if (authors.length === 0) {
      dropdown.innerHTML = '<div class="path-search-item"><span class="path-search-name">No authors found</span></div>';
      return;
    }

    dropdown.innerHTML = authors.map((author, idx) => `
      <div class="path-search-item" data-index="${idx}">
        <div class="path-search-name">${author.name}</div>
        <div class="path-search-stats">${author.paperCount} papers | ${formatNumber(author.citationCount)} citations</div>
      </div>
    `).join('');

    // Add click handlers
    dropdown.querySelectorAll('.path-search-item').forEach(item => {
      item.addEventListener('click', () => {
        const idx = parseInt(item.dataset.index);
        const selectedAuthor = inputNumber === 1 ? pathSearchResults1[idx] : pathSearchResults2[idx];
        selectPathAuthor(selectedAuthor, inputNumber);
      });
    });

  } catch (error) {
    console.error('Path search error:', error);
    dropdown.innerHTML = '<div class="path-search-item"><span class="path-search-name" style="color:#ef4444;">Error searching</span></div>';
  }
}

/**
 * Select an author for the path finder
 */
function selectPathAuthor(author, inputNumber) {
  if (inputNumber === 1) {
    pathAuthor1 = author;
    document.getElementById('pathAuthor1Input').value = author.name;
  } else {
    pathAuthor2 = author;
    document.getElementById('pathAuthor2Input').value = author.name;
  }
  hidePathDropdown(inputNumber);
  cacheAuthor(author.authorId, author);
}

/**
 * Hide path dropdown
 */
function hidePathDropdown(inputNumber) {
  const dropdown = document.getElementById(`pathDropdown${inputNumber}`);
  if (dropdown) dropdown.classList.remove('visible');
}

/**
 * Show path loading indicator
 */
function showPathLoading(show, text = 'Finding path...', subtext = 'Exploring author connections') {
  const loader = document.getElementById('pathLoading');
  const textEl = document.getElementById('pathLoadingText');
  const subtextEl = document.getElementById('pathLoadingSubtext');

  if (show) {
    textEl.textContent = text;
    subtextEl.textContent = subtext;
    loader.classList.add('visible');
  } else {
    loader.classList.remove('visible');
  }
}

/**
 * Get coauthors for an author (for BFS exploration)
 * Includes retry logic for rate limiting
 */
async function getCoauthorsForPath(authorId, visited, nameMatch, retries = 2) {
  const cleanId = authorId.replace('https://openalex.org/', '');

  // Fetch recent works by this author (limit to improve performance)
  const url = `${OPENALEX_BASE}/works?filter=author.id:${cleanId}&per_page=30&sort=cited_by_count:desc`;

  let response;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      response = await fetch(url);

      if (response.status === 429) {
        // Rate limited - wait and retry
        const waitTime = Math.pow(2, attempt) * 500; // 500ms, 1s, 2s
        await new Promise(r => setTimeout(r, waitTime));
        continue;
      }

      if (!response.ok) return [];
      break;

    } catch (error) {
      if (attempt === retries) return [];
      await new Promise(r => setTimeout(r, 500));
    }
  }

  if (!response || !response.ok) return [];

  const data = await response.json();
  const works = data.results || [];

  const coauthors = new Map();

  works.forEach(work => {
    if (!work.authorships) return;

    work.authorships.forEach(authorship => {
      const author = authorship.author;
      if (!author?.id) return;

      const coauthorId = author.id.replace('https://openalex.org/', '');
      if (coauthorId === cleanId) return;
      if (visited.has(coauthorId)) return;

      // Apply name matching filter
      if (!matchesNameFilter(authorship, nameMatch)) return;

      if (!coauthors.has(coauthorId)) {
        coauthors.set(coauthorId, {
          authorId: coauthorId,
          name: author.display_name || 'Unknown',
          position: authorship.author_position,
          sharedPapers: 1
        });
      } else {
        coauthors.get(coauthorId).sharedPapers++;
      }
    });
  });

  return Array.from(coauthors.values());
}

/**
 * Check if author matches the position filter
 * OpenAlex provides author_position: 'first', 'middle', 'last' on papers
 */
function matchesNameFilter(authorship, nameMatch) {
  if (nameMatch === 'all') return true;

  // Position on the paper (first author, middle author, last/senior author)
  const position = authorship.author_position;

  switch (nameMatch) {
    case 'full': // first + last/senior authors
      return position === 'first' || position === 'last';
    case 'first': // first authors only
      return position === 'first';
    case 'last': // last/senior authors only
      return position === 'last';
    default:
      return true;
  }
}

/**
 * Bidirectional BFS to find shortest path between two authors
 * Searches from both ends simultaneously and meets in the middle
 */
async function findAuthorPath(startAuthorId, endAuthorId, nameMatch) {
  const maxDepth = 4; // Max depth from each side (so max path = 8)
  const maxNodesPerLevel = 30; // Limit exploration per node

  // Two frontiers - one from each author
  const visitedStart = new Set([startAuthorId]);
  const visitedEnd = new Set([endAuthorId]);

  // Parent maps for path reconstruction
  const parentStart = new Map(); // authorId -> { parentId, sharedPapers }
  const parentEnd = new Map();   // authorId -> { parentId, sharedPapers }

  // Queues for BFS from each side
  let queueStart = [startAuthorId];
  let queueEnd = [endAuthorId];

  let meetingPoint = null;
  let nodesExplored = 0;
  let currentDepth = 0;

  // Expand one level of a frontier
  async function expandFrontier(queue, visited, parent, otherVisited, side) {
    const nextQueue = [];

    for (const authorId of queue) {
      if (meetingPoint) break;

      nodesExplored++;
      showPathLoading(true,
        `Depth ${currentDepth + 1} from ${side}...`,
        `${nodesExplored} authors explored`
      );

      try {
        const coauthors = await getCoauthorsForPath(authorId, new Set(), nameMatch);

        // Sort by shared papers and limit
        const sortedCoauthors = coauthors
          .sort((a, b) => b.sharedPapers - a.sharedPapers)
          .slice(0, maxNodesPerLevel);

        for (const coauthor of sortedCoauthors) {
          if (meetingPoint) break;

          // Cache author info
          if (!authorCache.has(coauthor.authorId)) {
            authorCache.set(coauthor.authorId, {
              authorId: coauthor.authorId,
              name: coauthor.name,
              paperCount: 0,
              citationCount: 0
            });
          }

          // Check if we've met the other frontier
          if (otherVisited.has(coauthor.authorId)) {
            meetingPoint = coauthor.authorId;
            if (!visited.has(coauthor.authorId)) {
              parent.set(coauthor.authorId, {
                parentId: authorId,
                sharedPapers: coauthor.sharedPapers
              });
            }
            break;
          }

          // Add to frontier if not visited
          if (!visited.has(coauthor.authorId)) {
            visited.add(coauthor.authorId);
            parent.set(coauthor.authorId, {
              parentId: authorId,
              sharedPapers: coauthor.sharedPapers
            });
            nextQueue.push(coauthor.authorId);
          }
        }

        // Small delay between API calls
        await new Promise(r => setTimeout(r, 50));

      } catch (error) {
        console.warn('Error fetching coauthors for', authorId, error);
        // Continue with other nodes
      }
    }

    return nextQueue;
  }

  // Alternate expanding from each side
  while (currentDepth < maxDepth && !meetingPoint) {
    // Expand the smaller frontier first (optimization)
    if (queueStart.length <= queueEnd.length && queueStart.length > 0) {
      queueStart = await expandFrontier(queueStart, visitedStart, parentStart, visitedEnd, 'start');
    } else if (queueEnd.length > 0) {
      queueEnd = await expandFrontier(queueEnd, visitedEnd, parentEnd, visitedStart, 'end');
    }

    // Check if both queues are empty
    if (queueStart.length === 0 && queueEnd.length === 0) {
      break;
    }

    currentDepth++;
  }

  if (!meetingPoint) {
    return null;
  }

  // Reconstruct path from start to meeting point
  const pathFromStart = [];
  let current = meetingPoint;
  while (current !== startAuthorId) {
    const data = parentStart.get(current);
    if (!data) break;
    pathFromStart.unshift({
      authorId: current,
      name: authorCache.get(current)?.name || 'Unknown',
      sharedPapers: data.sharedPapers
    });
    current = data.parentId;
  }
  pathFromStart.unshift({
    authorId: startAuthorId,
    name: authorCache.get(startAuthorId)?.name || 'Unknown',
    sharedPapers: 0
  });

  // Reconstruct path from meeting point to end
  const pathToEnd = [];
  current = meetingPoint;
  while (current !== endAuthorId) {
    const data = parentEnd.get(current);
    if (!data) break;
    current = data.parentId;
    pathToEnd.push({
      authorId: current,
      name: authorCache.get(current)?.name || 'Unknown',
      sharedPapers: data.sharedPapers
    });
  }

  // Combine paths (avoid duplicating meeting point)
  const fullPath = [...pathFromStart, ...pathToEnd];

  return fullPath;
}

/**
 * Main function to find and display path between two authors
 */
async function findPath() {
  if (!pathAuthor1 || !pathAuthor2) {
    alert('Please select both authors from the dropdown suggestions');
    return;
  }

  if (pathAuthor1.authorId === pathAuthor2.authorId) {
    alert('Please select two different authors');
    return;
  }

  const nameMatch = document.getElementById('nameMatchSelect')?.value || 'full';

  showPathLoading(true, 'Finding path...', 'Starting bidirectional search');

  try {
    const path = await findAuthorPath(pathAuthor1.authorId, pathAuthor2.authorId, nameMatch);

    if (!path || path.length === 0) {
      showPathLoading(false);
      const modeText = nameMatch === 'all' ? '' : '\n\nTry changing the name matching mode to "All authors" for broader search.';
      alert(`No connection found within 8 degrees of separation.${modeText}`);
      return;
    }

    showPathLoading(true, 'Building network...', `Found path of ${path.length - 1} connections`);

    // Fetch full details for path authors
    await enrichPathAuthors(path);

    // Display the path network
    displayPathNetwork(path);

  } catch (error) {
    console.error('Path finding error:', error);
    showPathLoading(false);

    // More helpful error message
    let errorMsg = 'Error finding path.';
    if (error.message?.includes('429') || error.message?.includes('rate')) {
      errorMsg = 'Too many API requests. Please wait a minute and try again.';
    } else if (error.message?.includes('network') || error.message?.includes('fetch')) {
      errorMsg = 'Network error. Check your connection and try again.';
    }
    alert(errorMsg);
  } finally {
    showPathLoading(false);
  }
}

/**
 * Fetch full author details for path nodes
 */
async function enrichPathAuthors(path) {
  const promises = path.map(async (node) => {
    if (!authorCache.has(node.authorId) || !authorCache.get(node.authorId).paperCount) {
      try {
        const url = `${OPENALEX_BASE}/authors/${node.authorId}`;
        const response = await fetch(url);
        if (response.ok) {
          const data = await response.json();
          const enriched = normalizeAuthor(data);
          cacheAuthor(node.authorId, enriched);
          node.name = enriched.name;
        }
      } catch (e) {
        console.warn('Could not enrich author:', node.authorId);
      }
    }
  });

  await Promise.all(promises);
}

/**
 * Display the path network
 */
function displayPathNetwork(path) {
  nodes.clear();
  edges.clear();
  clusterData = [];
  currentPapersData = null;
  expandedNetworks = [];

  // Create nodes for path
  path.forEach((node, index) => {
    const author = authorCache.get(node.authorId) || node;
    const isStart = index === 0;
    const isEnd = index === path.length - 1;

    let color = '#8b5cf6'; // Purple for middle nodes
    if (isStart) color = '#22c55e'; // Green for start
    if (isEnd) color = '#ef4444'; // Red for end

    nodes.add({
      id: node.authorId,
      label: author.name,
      title: `${author.name}\n${author.paperCount || 0} papers | ${formatNumber(author.citationCount || 0)} citations`,
      color: {
        background: color,
        border: color,
        highlight: { background: color, border: '#fff' }
      },
      size: isStart || isEnd ? 30 : 20,
      font: { color: '#fff', size: isStart || isEnd ? 16 : 14 }
    });
  });

  // Create edges along path
  for (let i = 0; i < path.length - 1; i++) {
    edges.add({
      from: path[i].authorId,
      to: path[i + 1].authorId,
      color: { color: '#fbbf24', highlight: '#fef3c7' },
      width: 4,
      smooth: { type: 'curvedCW', roundness: 0.1 }
    });
  }

  // Update current state for selection
  currentCentralAuthorId = path[0].authorId;

  // Show path legend
  document.getElementById('normalLegend').style.display = 'none';
  document.getElementById('pathLegend').classList.add('visible');

  // Update sidebar with path info
  updatePathSidebar(path);

  // Re-enable physics briefly to arrange, then stop
  network.setOptions({ physics: { enabled: true } });
  setTimeout(() => {
    network.setOptions({ physics: { enabled: false } });
    network.fit();
  }, 1500);
}

/**
 * Update sidebar with path information
 */
function updatePathSidebar(path) {
  const authorName = document.getElementById('authorName');
  const paperCount = document.getElementById('paperCount');
  const citationCount = document.getElementById('citationCount');
  const hIndex = document.getElementById('hIndex');
  const clusterList = document.getElementById('clusterList');

  authorName.textContent = `Path: ${path.length - 1} degrees`;
  paperCount.textContent = path.length;
  paperCount.parentElement.querySelector('.stat-label').textContent = 'Authors';
  citationCount.textContent = '-';
  hIndex.textContent = '-';

  // Show path steps in cluster section
  clusterList.innerHTML = `
    <h2 style="margin-bottom: 12px;">Connection Path</h2>
    ${path.map((node, index) => {
      const author = authorCache.get(node.authorId) || node;
      const isStart = index === 0;
      const isEnd = index === path.length - 1;
      let color = '#8b5cf6';
      if (isStart) color = '#22c55e';
      if (isEnd) color = '#ef4444';

      return `
        <div class="cluster-item" data-author-id="${node.authorId}" style="cursor: pointer;">
          <span class="cluster-color" style="background: ${color}; flex-shrink: 0;"></span>
          <div style="flex: 1; min-width: 0;">
            <div class="cluster-name" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${author.name}</div>
            <div style="font-size: 10px; color: #888;">${author.paperCount || 0} papers</div>
          </div>
          ${index < path.length - 1 ? `<span style="color: #fbbf24; font-size: 10px;">${path[index + 1].sharedPapers || '?'} shared</span>` : ''}
        </div>
        ${index < path.length - 1 ? '<div style="text-align: center; color: #fbbf24; margin: 4px 0;">↓</div>' : ''}
      `;
    }).join('')}
    <div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid #333;">
      <p style="font-size: 11px; color: #888;">Click any author to view their full details. Double-click to expand their network.</p>
    </div>
  `;

  // Add click handlers for path items
  clusterList.querySelectorAll('.cluster-item[data-author-id]').forEach(item => {
    item.addEventListener('click', () => {
      const authorId = item.dataset.authorId;
      selectAuthor(authorId);
    });
  });
}

// Path finder event listeners
document.getElementById('singleModeBtn')?.addEventListener('click', () => setPathFinderMode(false));
document.getElementById('pathModeBtn')?.addEventListener('click', () => setPathFinderMode(true));
document.getElementById('findPathBtn')?.addEventListener('click', findPath);

// Path input containers need to be created for dropdowns
function initPathFinderDropdowns() {
  const pathBox = document.getElementById('pathFinderBox');
  if (!pathBox) return;

  // Wrap inputs in containers with dropdowns
  const input1 = document.getElementById('pathAuthor1Input');
  const input2 = document.getElementById('pathAuthor2Input');

  if (input1 && !input1.parentElement.classList.contains('path-input-container')) {
    const container1 = document.createElement('div');
    container1.className = 'path-input-container';
    input1.parentElement.insertBefore(container1, input1);
    container1.appendChild(input1);

    const dropdown1 = document.createElement('div');
    dropdown1.id = 'pathDropdown1';
    dropdown1.className = 'path-search-dropdown';
    container1.appendChild(dropdown1);
  }

  if (input2 && !input2.parentElement.classList.contains('path-input-container')) {
    const container2 = document.createElement('div');
    container2.className = 'path-input-container';
    input2.parentElement.insertBefore(container2, input2);
    container2.appendChild(input2);

    const dropdown2 = document.createElement('div');
    dropdown2.id = 'pathDropdown2';
    dropdown2.className = 'path-search-dropdown';
    container2.appendChild(dropdown2);
  }
}

// Debounced path search
let pathSearchTimeout1 = null;
let pathSearchTimeout2 = null;

document.getElementById('pathAuthor1Input')?.addEventListener('input', (e) => {
  pathAuthor1 = null; // Clear selection when typing
  if (pathSearchTimeout1) clearTimeout(pathSearchTimeout1);
  pathSearchTimeout1 = setTimeout(() => searchPathAuthors(e.target.value, 1), 300);
});

document.getElementById('pathAuthor2Input')?.addEventListener('input', (e) => {
  pathAuthor2 = null; // Clear selection when typing
  if (pathSearchTimeout2) clearTimeout(pathSearchTimeout2);
  pathSearchTimeout2 = setTimeout(() => searchPathAuthors(e.target.value, 2), 300);
});

// Close dropdowns when clicking outside
document.addEventListener('click', (e) => {
  const dropdown1 = document.getElementById('pathDropdown1');
  const dropdown2 = document.getElementById('pathDropdown2');
  const input1 = document.getElementById('pathAuthor1Input');
  const input2 = document.getElementById('pathAuthor2Input');

  if (dropdown1 && !dropdown1.contains(e.target) && e.target !== input1) {
    dropdown1.classList.remove('visible');
  }
  if (dropdown2 && !dropdown2.contains(e.target) && e.target !== input2) {
    dropdown2.classList.remove('visible');
  }
});

// ============================================
// CSV Export
// ============================================

function escapeCSV(value) {
  if (value == null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function downloadCSV(csvContent, filename) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportFavoritesCSV() {
  if (!favorites || favorites.length === 0) return;
  const date = new Date().toISOString().slice(0, 10);
  const header = ['Name', 'AuthorId', 'ORCID', 'Papers', 'Citations', 'hIndex', 'LastChecked'];
  const rows = favorites.map(f => [
    escapeCSV(f.name),
    escapeCSV(f.authorId),
    escapeCSV(f.orcid || ''),
    f.paperCount || 0,
    f.citationCount || 0,
    f.hIndex || '',
    f.lastChecked ? new Date(f.lastChecked).toISOString().slice(0, 10) : ''
  ].join(','));
  downloadCSV(header.join(',') + '\n' + rows.join('\n'), `ane-favorites-${date}.csv`);
}

function exportCollectionCSV(collectionId) {
  const collection = collections.find(c => c.id === collectionId);
  if (!collection || collection.papers.length === 0) return;
  const date = new Date().toISOString().slice(0, 10);
  const safeName = collection.name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const header = ['Collection', 'Title', 'DOI', 'Year', 'Citations', 'Authors', 'Concepts', 'WorkId'];
  const rows = collection.papers.map(p => [
    escapeCSV(collection.name),
    escapeCSV(p.title),
    escapeCSV(p.doi || ''),
    p.year || '',
    p.citationCount || 0,
    escapeCSV((p.authors || []).map(a => a.name).join('; ')),
    escapeCSV((p.concepts || []).map(c => c.name).join('; ')),
    escapeCSV(p.workId)
  ].join(','));
  downloadCSV(header.join(',') + '\n' + rows.join('\n'), `ane-${safeName}-${date}.csv`);
}

function exportAllCollectionsCSV() {
  if (!collections || collections.length === 0) return;
  const date = new Date().toISOString().slice(0, 10);
  const header = ['Collection', 'Title', 'DOI', 'Year', 'Citations', 'Authors', 'Concepts', 'WorkId'];
  const rows = [];
  collections.forEach(collection => {
    (collection.papers || []).forEach(p => {
      rows.push([
        escapeCSV(collection.name),
        escapeCSV(p.title),
        escapeCSV(p.doi || ''),
        p.year || '',
        p.citationCount || 0,
        escapeCSV((p.authors || []).map(a => a.name).join('; ')),
        escapeCSV((p.concepts || []).map(c => c.name).join('; ')),
        escapeCSV(p.workId)
      ].join(','));
    });
  });
  if (rows.length === 0) return;
  downloadCSV(header.join(',') + '\n' + rows.join('\n'), `ane-all-collections-${date}.csv`);
}

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
  initPathFinderDropdowns();

  await loadPersistentCache();
  await loadFavorites();
  await loadCollections();
  renderNewPapers();
  renderCollectionsList();

  // CSV export button listeners
  document.getElementById('exportFavoritesBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    exportFavoritesCSV();
  });
  document.getElementById('exportAllCollectionsBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    exportAllCollectionsCSV();
  });

  chrome.runtime.sendMessage({ type: 'clearBadge' }).catch(() => {});

  // Check for author parameter in URL
  const urlParams = new URLSearchParams(window.location.search);
  const authorFromUrl = urlParams.get('author');
  const paperTitle = urlParams.get('paperTitle');

  // Only show placeholder and search glow if no author is already displayed
  const hasNetworkDisplayed = nodes.length > 0 || authorFromUrl;
  const searchBox = document.getElementById('singleSearchBox');
  const placeholder = document.getElementById('networkPlaceholder');

  if (hasNetworkDisplayed) {
    if (placeholder) placeholder.style.display = 'none';
  } else {
    if (placeholder) placeholder.style.display = '';
    if (searchBox) {
      searchBox.classList.add('search-glow');
      setTimeout(() => searchBox.classList.remove('search-glow'), 3000);
    }
  }

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

  // Load from storage (networkData is a one-time transfer from popup)
  chrome.storage.local.get(['networkData'], (result) => {
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
      saveNetworkState();

      setTimeout(() => {
        network.fit();
        network.redraw();
      }, 100);
      chrome.storage.local.remove(['networkData']);
    } else {
      // No transfer data — try restoring last viewed network from persistent cache
      restoreLastNetwork();
    }
  });
}

// Find author by paper title (for content script cross-referencing)
async function findAuthorByPaper(authorName, paperTitle) {
  try {
    const cleanTitle = paperTitle
      .replace(/^\[.*?\]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Search OpenAlex works by title
    const url = `${OPENALEX_BASE}/works?search=${encodeURIComponent(cleanTitle)}&per_page=10`;
    const response = await fetch(url);

    if (!response.ok) return null;

    const data = await response.json();
    if (!data.results?.length) return null;

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

    for (const work of data.results) {
      if (!work.authorships) continue;

      for (const authorship of work.authorships) {
        const author = authorship.author;
        if (!author) continue;

        const displayName = author.display_name || '';
        const paperAuthorNormalized = normalizeAuthorName(displayName);
        const paperParts = paperAuthorNormalized.split(' ').filter(p => p.length > 0);
        if (paperParts.length === 0) continue;

        const paperLast = paperParts[paperParts.length - 1];
        const paperFirst = paperParts.length > 1 ? paperParts[0] : '';

        // Exact match
        if (paperAuthorNormalized === targetNormalized) {
          return author.id ? author.id.replace('https://openalex.org/', '') : null;
        }

        // Last name match
        if (targetLast !== paperLast) {
          if (!targetLast.includes(paperLast) && !paperLast.includes(targetLast)) {
            continue;
          }
        }

        // First name/initial match
        if (targetFirst && paperFirst) {
          if (targetFirst[0] === paperFirst[0]) {
            return author.id ? author.id.replace('https://openalex.org/', '') : null;
          }
        } else if (!targetFirst || !paperFirst) {
          return author.id ? author.id.replace('https://openalex.org/', '') : null;
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
