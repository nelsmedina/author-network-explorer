// Web Worker for parallel API calls and cluster detection
// This runs on a separate thread from the main UI
// Uses Crossref API for author/works data

const CROSSREF_BASE = 'https://api.crossref.org';
const MAILTO = 'author-network-explorer@example.com';

// Handle messages from main thread
self.onmessage = async function(e) {
  const { type, id, payload } = e.data;

  try {
    switch (type) {
      case 'fetchAuthorWorks':
        const works = await fetchAuthorWorks(payload.authorName, payload.orcid, payload.limit);
        self.postMessage({ type: 'result', id, success: true, data: works });
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
          payload.authors.map(author => fetchAuthorWorks(author.name, author.orcid, payload.limit))
        );
        self.postMessage({ type: 'result', id, success: true, data: batchResults });
        break;

      default:
        self.postMessage({ type: 'result', id, success: false, error: 'Unknown message type' });
    }
  } catch (error) {
    self.postMessage({ type: 'result', id, success: false, error: error.message });
  }
};

// ============================================
// Author ID Generation (must match crossref-api.js)
// ============================================

function createAuthorId(author) {
  if (author.ORCID) {
    const orcid = author.ORCID.replace(/^https?:\/\/orcid\.org\//i, '');
    return `orcid:${orcid}`;
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
// Crossref API Functions
// ============================================

async function fetchAuthorWorks(authorName, orcid = null, limit = 100) {
  let url;

  if (orcid) {
    // Use ORCID filter for more accurate results
    const cleanOrcid = orcid.replace(/^https?:\/\/orcid\.org\//i, '');
    url = `${CROSSREF_BASE}/works?mailto=${MAILTO}&filter=orcid:${cleanOrcid}&rows=${limit}&select=DOI,title,author,published,is-referenced-by-count,type`;
  } else {
    // Fall back to name search
    url = `${CROSSREF_BASE}/works?mailto=${MAILTO}&query.author=${encodeURIComponent(authorName)}&rows=${limit}&select=DOI,title,author,published,is-referenced-by-count,type`;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Crossref API error: ${response.status}`);
  }

  const data = await response.json();
  const works = data.message?.items || [];

  // Convert to our paper format
  return works.map(work => workToPaper(work));
}

async function searchAuthors(query, limit = 100) {
  const url = `${CROSSREF_BASE}/works?mailto=${MAILTO}&query.author=${encodeURIComponent(query)}&rows=${limit}&select=DOI,title,author,published,is-referenced-by-count,type`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Crossref API error: ${response.status}`);
  }

  const data = await response.json();
  const works = data.message?.items || [];

  // Extract unique authors and aggregate stats
  const authorsMap = extractUniqueAuthors(works);

  // Convert to array and sort by paper count
  return Array.from(authorsMap.values())
    .filter(a => a.paperCount >= 1)
    .sort((a, b) => b.paperCount - a.paperCount || b.citationCount - a.citationCount);
}

// Convert Crossref work to simplified paper format
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
    type: work.type
  };
}

// Extract unique authors from works
function extractUniqueAuthors(works, centralAuthorId = null) {
  const authorsMap = new Map();
  const orcidToId = new Map();

  works.forEach((work, workIndex) => {
    if (!work.author) return;

    work.author.forEach((author, authorIndex) => {
      const authorId = createAuthorId(author);

      if (centralAuthorId && authorId === centralAuthorId) return;

      if (author.ORCID) {
        const existingId = orcidToId.get(author.ORCID);
        if (existingId && authorsMap.has(existingId)) {
          const existing = authorsMap.get(existingId);
          existing.paperCount++;
          existing.sharedPapers.add(workIndex);
          existing.citationCount += work['is-referenced-by-count'] || 0;
          return;
        }
        orcidToId.set(author.ORCID, authorId);
      }

      if (authorsMap.has(authorId)) {
        const existing = authorsMap.get(authorId);
        existing.paperCount++;
        existing.sharedPapers.add(workIndex);
        existing.citationCount += work['is-referenced-by-count'] || 0;

        if (author.affiliation && author.affiliation.length > 0 && !existing.affiliations.length) {
          existing.affiliations = author.affiliation.map(a => a.name).filter(Boolean);
        }
      } else {
        const displayName = author.given && author.family
          ? `${author.given} ${author.family}`
          : author.name || author.family || 'Unknown';

        authorsMap.set(authorId, {
          authorId,
          name: displayName,
          given: author.given || '',
          family: author.family || '',
          orcid: author.ORCID ? author.ORCID.replace(/^https?:\/\/orcid\.org\//i, '') : null,
          isVerified: !!author.ORCID,
          paperCount: 1,
          citationCount: work['is-referenced-by-count'] || 0,
          affiliations: author.affiliation ? author.affiliation.map(a => a.name).filter(Boolean) : [],
          sharedPapers: new Set([workIndex]),
          firstAuthorCount: authorIndex === 0 ? 1 : 0,
          seniorAuthorCount: authorIndex === work.author.length - 1 ? 1 : 0
        });
      }
    });
  });

  return authorsMap;
}

// ============================================
// Cluster Detection
// ============================================

// Cluster detection using union-find (O(n^2) but runs off main thread)
function detectClusters(coauthorIds, coauthorMapData) {
  // Rebuild Map from serialized data
  const coauthorMap = new Map(coauthorMapData.map(([id, data]) => [
    id,
    { ...data, sharedPapers: new Set(data.sharedPapers) }
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

      const papers1 = data1.sharedPapers;
      const papers2 = data2.sharedPapers;

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
