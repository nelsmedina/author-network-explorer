// Crossref API utilities for Author Network Explorer
// Replaces Semantic Scholar API for author and works data

const CROSSREF_BASE = 'https://api.crossref.org';
const MAILTO = 'author-network-explorer@example.com'; // For polite pool (higher rate limits)

// ============================================
// Author ID Generation
// ============================================

/**
 * Create a unique author ID from Crossref author data
 * Uses ORCID if available, otherwise generates a normalized name-based ID
 * @param {Object} author - Crossref author object with given, family, ORCID
 * @returns {string} Author ID in format "orcid:X" or "name:lastname-firstname"
 */
function createAuthorId(author) {
  if (author.ORCID) {
    // Normalize ORCID - extract just the ID part
    const orcid = author.ORCID.replace(/^https?:\/\/orcid\.org\//i, '');
    return `orcid:${orcid}`;
  }

  // Generate name-based ID
  const normalized = normalizeAuthorName(author.given, author.family);
  return `name:${normalized}`;
}

/**
 * Normalize author name for consistent ID generation
 * @param {string} given - Given/first name
 * @param {string} family - Family/last name
 * @returns {string} Normalized name in format "lastname-firstname"
 */
function normalizeAuthorName(given, family) {
  const normalize = (str) => {
    if (!str) return '';
    return str
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
      .replace(/[^a-z\s-]/g, '')       // Keep only letters, spaces, hyphens
      .replace(/\s+/g, '-')            // Replace spaces with hyphens
      .replace(/-+/g, '-')             // Collapse multiple hyphens
      .trim();
  };

  const normalizedFamily = normalize(family) || 'unknown';
  const normalizedGiven = normalize(given) || '';

  return normalizedGiven ? `${normalizedFamily}-${normalizedGiven}` : normalizedFamily;
}

/**
 * Get display name from author ID
 * @param {string} authorId - Author ID
 * @returns {string} Human-readable name
 */
function getDisplayNameFromId(authorId) {
  if (authorId.startsWith('orcid:')) {
    return authorId; // Will be replaced with actual name from API
  }
  if (authorId.startsWith('name:')) {
    const parts = authorId.substring(5).split('-');
    // Capitalize each part
    return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  }
  return authorId;
}

/**
 * Check if author ID is ORCID-based (verified)
 * @param {string} authorId
 * @returns {boolean}
 */
function isVerifiedAuthor(authorId) {
  return authorId.startsWith('orcid:');
}

// ============================================
// Fuzzy Name Matching
// ============================================

/**
 * Calculate Levenshtein distance between two strings
 * @param {string} a
 * @param {string} b
 * @returns {number} Edit distance
 */
function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Check if two author names are similar enough to be the same person
 * @param {string} name1
 * @param {string} name2
 * @param {number} threshold - Max normalized distance (0-1), default 0.3
 * @returns {boolean}
 */
function fuzzyNameMatch(name1, name2, threshold = 0.3) {
  const n1 = normalizeAuthorName(name1.split(' ').slice(-1)[0], name1.split(' ').slice(0, -1).join(' '));
  const n2 = normalizeAuthorName(name2.split(' ').slice(-1)[0], name2.split(' ').slice(0, -1).join(' '));

  if (n1 === n2) return true;

  const distance = levenshteinDistance(n1, n2);
  const maxLen = Math.max(n1.length, n2.length);
  const normalizedDistance = distance / maxLen;

  return normalizedDistance <= threshold;
}

// ============================================
// Crossref API Functions
// ============================================

/**
 * Build URL with polite pool mailto parameter
 * @param {string} endpoint
 * @returns {string}
 */
function buildCrossrefUrl(endpoint) {
  const url = new URL(endpoint, CROSSREF_BASE);
  url.searchParams.set('mailto', MAILTO);
  return url.toString();
}

/**
 * Search for works by author name
 * @param {string} name - Author name to search
 * @param {number} limit - Max results (default 100)
 * @returns {Promise<Array>} Array of works
 */
async function searchWorksByAuthor(name, limit = 100) {
  const url = buildCrossrefUrl('/works');
  const fullUrl = `${url}&query.author=${encodeURIComponent(name)}&rows=${limit}&select=DOI,title,author,published,is-referenced-by-count,type`;

  const response = await fetch(fullUrl);
  if (!response.ok) {
    throw new Error(`Crossref API error: ${response.status}`);
  }

  const data = await response.json();
  return data.message?.items || [];
}

/**
 * Search for works by ORCID
 * @param {string} orcid - ORCID (without prefix)
 * @param {number} limit - Max results (default 100)
 * @returns {Promise<Array>} Array of works
 */
async function searchWorksByORCID(orcid, limit = 100) {
  // Clean ORCID - remove any URL prefix
  const cleanOrcid = orcid.replace(/^https?:\/\/orcid\.org\//i, '');

  const url = buildCrossrefUrl('/works');
  const fullUrl = `${url}&filter=orcid:${cleanOrcid}&rows=${limit}&select=DOI,title,author,published,is-referenced-by-count,type`;

  const response = await fetch(fullUrl);
  if (!response.ok) {
    throw new Error(`Crossref API error: ${response.status}`);
  }

  const data = await response.json();
  return data.message?.items || [];
}

/**
 * Get a single work by DOI
 * @param {string} doi
 * @returns {Promise<Object>} Work object
 */
async function getWorkByDOI(doi) {
  const cleanDoi = doi.replace(/^https?:\/\/doi\.org\//i, '');
  const url = buildCrossrefUrl(`/works/${encodeURIComponent(cleanDoi)}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Crossref API error: ${response.status}`);
  }

  const data = await response.json();
  return data.message;
}

/**
 * Extract unique authors from a list of works
 * Deduplicates by ORCID (if available) or fuzzy name matching
 * @param {Array} works - Array of Crossref work objects
 * @param {string} centralAuthorId - Optional: exclude this author from results
 * @returns {Map<string, Object>} Map of authorId -> author data
 */
function extractUniqueAuthors(works, centralAuthorId = null) {
  const authorsMap = new Map();
  const orcidToId = new Map(); // Track ORCID to authorId mapping

  works.forEach((work, workIndex) => {
    if (!work.author) return;

    work.author.forEach((author, authorIndex) => {
      const authorId = createAuthorId(author);

      // Skip central author
      if (centralAuthorId && authorId === centralAuthorId) return;

      // If this author has ORCID, check if we've seen this ORCID before
      if (author.ORCID) {
        const existingId = orcidToId.get(author.ORCID);
        if (existingId && authorsMap.has(existingId)) {
          // Update existing entry
          const existing = authorsMap.get(existingId);
          existing.paperCount++;
          existing.sharedPapers.add(workIndex);
          existing.citationCount += work['is-referenced-by-count'] || 0;
          return;
        }
        orcidToId.set(author.ORCID, authorId);
      }

      if (authorsMap.has(authorId)) {
        // Update existing author
        const existing = authorsMap.get(authorId);
        existing.paperCount++;
        existing.sharedPapers.add(workIndex);
        existing.citationCount += work['is-referenced-by-count'] || 0;

        // Update affiliation if we get a better one
        if (author.affiliation && author.affiliation.length > 0 && !existing.affiliations.length) {
          existing.affiliations = author.affiliation.map(a => a.name).filter(Boolean);
        }
      } else {
        // New author
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

/**
 * Get author position in a paper's author list
 * @param {string} authorId
 * @param {Array} authors - Array of author objects from a work
 * @returns {string} 'first', 'senior', 'both', or 'middle'
 */
function getAuthorPosition(authorId, authors) {
  if (!authors || authors.length === 0) return null;

  const firstAuthor = authors[0];
  const lastAuthor = authors[authors.length - 1];

  const firstId = createAuthorId(firstAuthor);
  const lastId = createAuthorId(lastAuthor);

  const isFirst = firstId === authorId;
  const isLast = lastId === authorId;

  if (isFirst && isLast) return 'both';
  if (isFirst) return 'first';
  if (isLast) return 'senior';
  return 'middle';
}

/**
 * Aggregate author stats from works
 * @param {Array} works - Array of works
 * @param {string} authorId - Author to calculate stats for
 * @returns {Object} Stats object
 */
function aggregateAuthorStats(works, authorId) {
  let paperCount = 0;
  let citationCount = 0;
  const dois = [];
  const years = [];

  works.forEach(work => {
    if (!work.author) return;

    // Check if this author is in this work
    const isInWork = work.author.some(a => createAuthorId(a) === authorId);
    if (!isInWork) return;

    paperCount++;
    citationCount += work['is-referenced-by-count'] || 0;

    if (work.DOI) dois.push(work.DOI);

    if (work.published && work.published['date-parts'] && work.published['date-parts'][0]) {
      const year = work.published['date-parts'][0][0];
      if (year) years.push(year);
    }
  });

  return {
    paperCount,
    citationCount,
    dois,
    years,
    firstYear: years.length > 0 ? Math.min(...years) : null,
    lastYear: years.length > 0 ? Math.max(...years) : null
  };
}

/**
 * Convert Crossref work to simplified paper format
 * @param {Object} work - Crossref work object
 * @returns {Object} Simplified paper object
 */
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

/**
 * Search for authors by name and return aggregated results
 * Groups works by unique authors and returns author summaries
 * @param {string} query - Search query
 * @param {number} limit - Max works to fetch
 * @returns {Promise<Array>} Array of author objects with stats
 */
async function searchAuthors(query, limit = 100) {
  const works = await searchWorksByAuthor(query, limit);
  const authorsMap = extractUniqueAuthors(works);

  // Convert to array and sort by paper count
  const authors = Array.from(authorsMap.values())
    .filter(a => a.paperCount >= 1)
    .sort((a, b) => b.paperCount - a.paperCount || b.citationCount - a.citationCount);

  return authors;
}

// ============================================
// Favorites Migration
// ============================================

/**
 * Migrate old Semantic Scholar favorites to new Crossref format
 * @param {Array} oldFavorites - Array of old format favorites
 * @returns {Array} Array of new format favorites
 */
function migrateFavorites(oldFavorites) {
  return oldFavorites.map(fav => {
    // Generate new author ID based on name
    const nameParts = fav.name.split(' ');
    const family = nameParts.pop() || fav.name;
    const given = nameParts.join(' ');
    const normalizedName = normalizeAuthorName(given, family);

    return {
      authorId: `name:${normalizedName}`,
      name: fav.name,
      orcid: null,
      paperCount: fav.paperCount || 0,
      citationCount: fav.citationCount || 0,
      lastChecked: fav.lastChecked || Date.now(),
      lastPaperCount: fav.lastPaperCount || fav.paperCount || 0,
      hasUpdates: false,
      newPapers: [],
      searchQuery: fav.name, // Store original name for searching
      // Remove old fields: hIndex, authorId (old format)
    };
  });
}

/**
 * Check if favorites need migration (have old Semantic Scholar format)
 * @param {Array} favorites
 * @returns {boolean}
 */
function needsMigration(favorites) {
  if (!favorites || favorites.length === 0) return false;

  // Old format has numeric authorId or authorId without prefix
  return favorites.some(fav => {
    const id = fav.authorId;
    return !id.startsWith('orcid:') && !id.startsWith('name:');
  });
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createAuthorId,
    normalizeAuthorName,
    getDisplayNameFromId,
    isVerifiedAuthor,
    fuzzyNameMatch,
    levenshteinDistance,
    searchWorksByAuthor,
    searchWorksByORCID,
    getWorkByDOI,
    extractUniqueAuthors,
    getAuthorPosition,
    aggregateAuthorStats,
    workToPaper,
    searchAuthors,
    migrateFavorites,
    needsMigration,
    CROSSREF_BASE,
    MAILTO
  };
}
