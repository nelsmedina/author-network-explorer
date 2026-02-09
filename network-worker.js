// Web Worker for parallel API calls and cluster detection
// This runs on a separate thread from the main UI
// Uses OpenAlex API for author/works data

const OPENALEX_BASE = 'https://api.openalex.org';
const OPENALEX_API_KEY = 'ygR9tBoWZtDgvAKDkdzcT4';

// Fetch wrapper for API rate limit tracking (posts to main thread since no chrome.storage in workers)
const _originalFetch = fetch;
fetch = async function(...args) {
  const response = await _originalFetch(...args);
  const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
  if (url && url.includes('api.openalex.org')) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining !== null) {
      self.postMessage({ type: 'rateLimitUpdate', data: {
        limit: parseInt(response.headers.get('x-ratelimit-limit')) || 0,
        remaining: parseInt(remaining) || 0,
        reset: response.headers.get('x-ratelimit-reset') || null,
        lastUpdated: Date.now()
      }});
    }
  }
  return response;
};

// Handle messages from main thread
self.onmessage = async function(e) {
  const { type, id, payload } = e.data;

  try {
    switch (type) {
      case 'fetchAuthorWorks':
        const works = await fetchAuthorWorks(payload.authorId, payload.limit, payload.positionFilter);
        self.postMessage({ type: 'result', id, success: true, data: works });
        break;

      case 'getAuthorDetails':
        const author = await getAuthorDetails(payload.authorId);
        self.postMessage({ type: 'result', id, success: true, data: author });
        break;

      case 'searchAuthors':
        const results = await searchAuthors(payload.query, payload.limit);
        self.postMessage({ type: 'result', id, success: true, data: results });
        break;

      case 'detectClusters':
        const clusters = detectClusters(payload.coauthorIds, payload.coauthorMap);
        self.postMessage({ type: 'result', id, success: true, data: clusters });
        break;

      case 'batchFetchWorks':
        // Fetch works for multiple authors in parallel
        const batchResults = await Promise.all(
          payload.authors.map(author => fetchAuthorWorks(author.authorId, payload.limit))
        );
        self.postMessage({ type: 'result', id, success: true, data: batchResults });
        break;

      case 'batchGetAuthors':
        // Get details for multiple authors
        const authorsDetails = await batchGetAuthors(payload.authorIds);
        self.postMessage({ type: 'result', id, success: true, data: authorsDetails });
        break;

      default:
        self.postMessage({ type: 'result', id, success: false, error: 'Unknown message type' });
    }
  } catch (error) {
    self.postMessage({ type: 'result', id, success: false, error: error.message });
  }
};

// ============================================
// OpenAlex API Functions
// ============================================

/**
 * Fetch works by an author
 * @param {string} authorId - OpenAlex author ID (e.g., "A1234567890")
 * @param {number} limit - Max results
 * @param {string} positionFilter - 'first', 'last', 'first_last', or null
 * @returns {Promise<Array>} Array of work objects
 */
async function fetchAuthorWorks(authorId, limit = 100, positionFilter = null) {
  const cleanId = authorId.replace('https://openalex.org/', '');
  const url = `${OPENALEX_BASE}/works?api_key=${OPENALEX_API_KEY}&filter=author.id:${cleanId}&per_page=${limit}&sort=publication_year:desc`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OpenAlex API error: ${response.status}`);
  }

  const data = await response.json();
  const works = data.results || [];

  // Convert to our paper format and optionally filter by position
  return works.map(work => workToPaper(work, cleanId, positionFilter)).filter(Boolean);
}

/**
 * Get author details by ID
 * @param {string} authorId - OpenAlex author ID
 * @returns {Promise<Object>} Author object
 */
async function getAuthorDetails(authorId) {
  const cleanId = authorId.replace('https://openalex.org/', '');
  const url = `${OPENALEX_BASE}/authors/${cleanId}?api_key=${OPENALEX_API_KEY}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OpenAlex API error: ${response.status}`);
  }

  const data = await response.json();
  return normalizeAuthor(data);
}

/**
 * Search for authors by name
 * @param {string} query - Search query
 * @param {number} limit - Max results
 * @returns {Promise<Array>} Array of author objects
 */
async function searchAuthors(query, limit = 25) {
  const url = `${OPENALEX_BASE}/authors?api_key=${OPENALEX_API_KEY}&search=${encodeURIComponent(query)}&per_page=${limit}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OpenAlex API error: ${response.status}`);
  }

  const data = await response.json();
  return (data.results || []).map(normalizeAuthor);
}

/**
 * Get details for multiple authors
 * @param {Array<string>} authorIds - Array of OpenAlex author IDs
 * @returns {Promise<Map>} Map of authorId -> author details
 */
async function batchGetAuthors(authorIds) {
  if (authorIds.length === 0) return [];

  // OpenAlex supports OR filter with pipe
  const cleanIds = authorIds.slice(0, 50).map(id => id.replace('https://openalex.org/', ''));
  const filterStr = cleanIds.join('|');

  const url = `${OPENALEX_BASE}/authors?api_key=${OPENALEX_API_KEY}&filter=ids.openalex:${filterStr}&per_page=50`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OpenAlex API error: ${response.status}`);
  }

  const data = await response.json();
  return (data.results || []).map(normalizeAuthor);
}

// ============================================
// Data Normalization
// ============================================

/**
 * Normalize OpenAlex author object
 * @param {Object} author - Raw OpenAlex author
 * @returns {Object} Normalized author
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
      country: inst.country_code,
      type: inst.type
    })),
    concepts: (author.x_concepts || []).slice(0, 10).map(c => ({
      id: c.id,
      name: c.display_name,
      score: c.score,
      level: c.level
    })),
    countsByYear: author.counts_by_year || []
  };
}

/**
 * Convert OpenAlex work to simplified paper format
 * @param {Object} work - Raw OpenAlex work
 * @param {string} centralAuthorId - Optional: the central author ID for position checking
 * @param {string} positionFilter - Optional: 'first', 'last', 'first_last'
 * @returns {Object|null} Normalized paper or null if filtered out
 */
function workToPaper(work, centralAuthorId = null, positionFilter = null) {
  if (!work) return null;

  const shortId = work.id ? work.id.replace('https://openalex.org/', '') : null;

  // Build authors array with position info
  const authors = (work.authorships || []).map(authorship => ({
    authorId: authorship.author?.id?.replace('https://openalex.org/', ''),
    openAlexId: authorship.author?.id,
    name: authorship.author?.display_name || 'Unknown',
    orcid: authorship.author?.orcid?.replace('https://orcid.org/', ''),
    position: authorship.author_position, // 'first', 'middle', 'last'
    institutions: (authorship.institutions || []).map(inst => ({
      id: inst.id,
      name: inst.display_name,
      country: inst.country_code
    }))
  }));

  // Apply position filter if specified
  if (positionFilter && centralAuthorId) {
    const centralAuthor = authors.find(a => a.authorId === centralAuthorId);
    if (centralAuthor) {
      if (positionFilter === 'first' && centralAuthor.position !== 'first') return null;
      if (positionFilter === 'last' && centralAuthor.position !== 'last') return null;
      if (positionFilter === 'first_last' && centralAuthor.position === 'middle') return null;
    }
  }

  return {
    workId: shortId,
    openAlexId: work.id,
    doi: work.doi ? work.doi.replace('https://doi.org/', '') : null,
    title: work.display_name || work.title || 'Untitled',
    year: work.publication_year,
    citationCount: work.cited_by_count || 0,
    type: work.type,
    authors,
    concepts: (work.concepts || []).slice(0, 5).map(c => ({
      id: c.id,
      name: c.display_name,
      score: c.score,
      level: c.level
    })),
    referencedWorks: work.referenced_works || [],
    referencedWorksCount: work.referenced_works_count || 0
  };
}

/**
 * Extract unique co-authors from works
 * @param {Array} works - Array of normalized work objects
 * @param {string} centralAuthorId - The central author to exclude
 * @param {string} positionFilter - Optional position filter for co-authors
 * @returns {Map} Map of authorId -> coauthor data
 */
function extractCoauthors(works, centralAuthorId, positionFilter = null) {
  const coauthorsMap = new Map();

  works.forEach((work, workIndex) => {
    if (!work.authors) return;

    work.authors.forEach(author => {
      // Skip the central author
      if (author.authorId === centralAuthorId) return;

      // Apply position filter to co-authors
      if (positionFilter === 'first' && author.position !== 'first') return;
      if (positionFilter === 'last' && author.position !== 'last') return;
      if (positionFilter === 'first_last' && author.position === 'middle') return;

      if (coauthorsMap.has(author.authorId)) {
        const existing = coauthorsMap.get(author.authorId);
        existing.sharedPapers++;
        existing.sharedWorkIndices.add(workIndex);
        if (author.position === 'first') existing.firstAuthorCount++;
        if (author.position === 'last') existing.seniorAuthorCount++;
      } else {
        coauthorsMap.set(author.authorId, {
          authorId: author.authorId,
          openAlexId: author.openAlexId,
          name: author.name,
          orcid: author.orcid,
          sharedPapers: 1,
          sharedWorkIndices: new Set([workIndex]),
          firstAuthorCount: author.position === 'first' ? 1 : 0,
          seniorAuthorCount: author.position === 'last' ? 1 : 0,
          institutions: author.institutions || []
        });
      }
    });
  });

  return coauthorsMap;
}

// ============================================
// Cluster Detection
// ============================================

/**
 * Detect clusters among co-authors using union-find
 * @param {Array} coauthorIds - Array of author IDs
 * @param {Array} coauthorMapData - Serialized coauthor map
 * @returns {Object} Clusters and edges
 */
function detectClusters(coauthorIds, coauthorMapData) {
  // Rebuild Map from serialized data
  const coauthorMap = new Map(coauthorMapData.map(([id, data]) => [
    id,
    { ...data, sharedWorkIndices: new Set(data.sharedWorkIndices || data.sharedPapers) }
  ]));

  const clusterEdges = [];

  // Find co-authors who collaborated together (appeared on same papers)
  for (let i = 0; i < coauthorIds.length; i++) {
    for (let j = i + 1; j < coauthorIds.length; j++) {
      const id1 = coauthorIds[i];
      const id2 = coauthorIds[j];
      const data1 = coauthorMap.get(id1);
      const data2 = coauthorMap.get(id2);

      if (!data1 || !data2) continue;

      const papers1 = data1.sharedWorkIndices;
      const papers2 = data2.sharedWorkIndices;

      // Find papers where both co-authors appear
      const sharedPapers = [...papers1].filter(p => papers2.has(p));
      if (sharedPapers.length > 0) {
        clusterEdges.push({ from: id1, to: id2, weight: sharedPapers.length });
      }
    }
  }

  // Union-find for cluster assignment
  const parent = new Map();
  coauthorIds.forEach(id => parent.set(id, id));

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

  // Assign cluster numbers
  const rootToCluster = new Map();
  let clusterNum = 0;
  const clusters = new Map();

  coauthorIds.forEach(id => {
    const root = find(id);
    if (!rootToCluster.has(root)) {
      rootToCluster.set(root, clusterNum++);
    }
    clusters.set(id, rootToCluster.get(root));
  });

  return {
    clusters: Array.from(clusters.entries()),
    clusterEdges: clusterEdges
  };
}

// Export extractCoauthors for use in main thread normalization
self.extractCoauthors = extractCoauthors;
