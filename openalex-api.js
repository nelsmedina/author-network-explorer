// OpenAlex API utilities for Author Network Explorer

const OPENALEX_BASE = 'https://api.openalex.org';
const OPENALEX_API_KEY = 'ygR9tBoWZtDgvAKDkdzcT4';

// ============================================
// API Request Helpers
// ============================================

/**
 * Build URL with API key parameter
 * @param {string} endpoint
 * @param {Object} params - Query parameters
 * @returns {string}
 */
function buildOpenAlexUrl(endpoint, params = {}) {
  const url = new URL(endpoint, OPENALEX_BASE);
  url.searchParams.set('api_key', OPENALEX_API_KEY);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

/**
 * Make API request with error handling
 * @param {string} url
 * @returns {Promise<Object>}
 */
async function fetchOpenAlex(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OpenAlex API error: ${response.status}`);
  }
  return response.json();
}

// ============================================
// Author Functions
// ============================================

/**
 * Search for authors by name
 * @param {string} query - Author name to search
 * @param {number} limit - Max results (default 25)
 * @returns {Promise<Array>} Array of author objects
 */
async function searchAuthors(query, limit = 25) {
  const url = buildOpenAlexUrl('/authors', {
    search: query,
    per_page: limit
  });

  const data = await fetchOpenAlex(url);
  return (data.results || []).map(normalizeAuthor);
}

/**
 * Get author by OpenAlex ID
 * @param {string} authorId - OpenAlex author ID (e.g., "A1234567890" or full URL)
 * @returns {Promise<Object>} Author object
 */
async function getAuthorById(authorId) {
  // Handle both short ID and full URL formats
  const id = authorId.replace('https://openalex.org/', '');
  const url = buildOpenAlexUrl(`/authors/${id}`);

  const data = await fetchOpenAlex(url);
  return normalizeAuthor(data);
}

/**
 * Get author by ORCID
 * @param {string} orcid - ORCID (with or without URL prefix)
 * @returns {Promise<Object>} Author object
 */
async function getAuthorByOrcid(orcid) {
  const cleanOrcid = orcid.replace(/^https?:\/\/orcid\.org\//i, '');
  const url = buildOpenAlexUrl(`/authors/orcid:${cleanOrcid}`);

  const data = await fetchOpenAlex(url);
  return normalizeAuthor(data);
}

/**
 * Get works by an author
 * @param {string} authorId - OpenAlex author ID
 * @param {number} limit - Max results (default 100)
 * @param {string} filter - Additional filter (e.g., author position)
 * @returns {Promise<Array>} Array of work objects
 */
async function getAuthorWorks(authorId, limit = 100, filter = null) {
  const id = authorId.replace('https://openalex.org/', '');
  let filterStr = `author.id:${id}`;
  if (filter) {
    filterStr += `,${filter}`;
  }

  const url = buildOpenAlexUrl('/works', {
    filter: filterStr,
    per_page: limit,
    sort: 'publication_year:desc'
  });

  const data = await fetchOpenAlex(url);
  return (data.results || []).map(normalizeWork);
}

/**
 * Normalize OpenAlex author object to our format
 * @param {Object} author - Raw OpenAlex author
 * @returns {Object} Normalized author
 */
function normalizeAuthor(author) {
  if (!author) return null;

  // Extract short ID from full URL
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
    twoYearMeanCitedness: author.summary_stats?.['2yr_mean_citedness'] || null,
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
    countsByYear: author.counts_by_year || [],
    worksApiUrl: author.works_api_url
  };
}

// ============================================
// Works Functions
// ============================================

/**
 * Search for works
 * @param {string} query - Search query
 * @param {number} limit - Max results
 * @returns {Promise<Array>} Array of work objects
 */
async function searchWorks(query, limit = 25) {
  const url = buildOpenAlexUrl('/works', {
    search: query,
    per_page: limit
  });

  const data = await fetchOpenAlex(url);
  return (data.results || []).map(normalizeWork);
}

/**
 * Get work by DOI
 * @param {string} doi - DOI (with or without URL prefix)
 * @returns {Promise<Object>} Work object
 */
async function getWorkByDoi(doi) {
  const cleanDoi = doi.replace(/^https?:\/\/doi\.org\//i, '');
  const url = buildOpenAlexUrl(`/works/doi:${cleanDoi}`);

  const data = await fetchOpenAlex(url);
  return normalizeWork(data);
}

/**
 * Get work by OpenAlex ID
 * @param {string} workId - OpenAlex work ID
 * @returns {Promise<Object>} Work object
 */
async function getWorkById(workId) {
  const id = workId.replace('https://openalex.org/', '');
  const url = buildOpenAlexUrl(`/works/${id}`);

  const data = await fetchOpenAlex(url);
  return normalizeWork(data);
}

/**
 * Normalize OpenAlex work object to our format
 * @param {Object} work - Raw OpenAlex work
 * @returns {Object} Normalized work
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
      position: authorship.author_position, // 'first', 'middle', 'last'
      institutions: (authorship.institutions || []).map(inst => ({
        id: inst.id,
        name: inst.display_name,
        country: inst.country_code
      }))
    })),
    concepts: (work.concepts || []).slice(0, 5).map(c => ({
      id: c.id,
      name: c.display_name,
      score: c.score,
      level: c.level
    })),
    isRetracted: work.is_retracted || false,
    referencedWorks: work.referenced_works || [],
    referencedWorksCount: work.referenced_works_count || 0,
    relatedWorks: work.related_works || []
  };
}

// ============================================
// Co-author Network Functions
// ============================================

/**
 * Get co-authors for an author from their works
 * @param {string} authorId - OpenAlex author ID
 * @param {number} worksLimit - Max works to analyze
 * @param {string} positionFilter - 'first', 'last', 'first_last', or null for all
 * @returns {Promise<Object>} Object with coauthors map and works
 */
async function getCoauthorNetwork(authorId, worksLimit = 100, positionFilter = 'first_last') {
  const works = await getAuthorWorks(authorId, worksLimit);
  const coauthorsMap = new Map();

  works.forEach(work => {
    work.authors.forEach(author => {
      // Skip the central author
      if (author.authorId === authorId) return;

      // Apply position filter
      if (positionFilter === 'first' && author.position !== 'first') return;
      if (positionFilter === 'last' && author.position !== 'last') return;
      if (positionFilter === 'first_last' && author.position === 'middle') return;

      if (coauthorsMap.has(author.authorId)) {
        const existing = coauthorsMap.get(author.authorId);
        existing.sharedPapers++;
        existing.sharedWorks.push(work.workId);
        if (author.position === 'first') existing.firstAuthorCount++;
        if (author.position === 'last') existing.seniorAuthorCount++;
      } else {
        coauthorsMap.set(author.authorId, {
          authorId: author.authorId,
          openAlexId: author.openAlexId,
          name: author.name,
          orcid: author.orcid,
          sharedPapers: 1,
          sharedWorks: [work.workId],
          firstAuthorCount: author.position === 'first' ? 1 : 0,
          seniorAuthorCount: author.position === 'last' ? 1 : 0,
          institutions: author.institutions
        });
      }
    });
  });

  return {
    coauthors: Array.from(coauthorsMap.values()).sort((a, b) => b.sharedPapers - a.sharedPapers),
    works,
    centralAuthorId: authorId
  };
}

/**
 * Get detailed info for multiple authors (for enriching coauthor data)
 * @param {Array<string>} authorIds - Array of OpenAlex author IDs
 * @returns {Promise<Map>} Map of authorId -> author details
 */
async function getAuthorsDetails(authorIds) {
  // OpenAlex supports filtering by multiple IDs
  const ids = authorIds.slice(0, 50).map(id => id.replace('https://openalex.org/', ''));
  const filterStr = ids.map(id => `openalex:${id}`).join('|');

  const url = buildOpenAlexUrl('/authors', {
    filter: `ids.openalex:${ids.join('|')}`,
    per_page: 50
  });

  try {
    const data = await fetchOpenAlex(url);
    const authorsMap = new Map();
    (data.results || []).forEach(author => {
      const normalized = normalizeAuthor(author);
      authorsMap.set(normalized.authorId, normalized);
    });
    return authorsMap;
  } catch (e) {
    console.error('Error fetching author details:', e);
    return new Map();
  }
}

// ============================================
// Favorites Migration
// ============================================

/**
 * Migrate old favorites to OpenAlex format
 * Attempts to find matching OpenAlex author by name search
 * @param {Array} oldFavorites - Array of old format favorites
 * @returns {Promise<Array>} Array of new format favorites
 */
async function migrateFavorites(oldFavorites) {
  const migrated = [];

  for (const fav of oldFavorites) {
    try {
      // Search for the author by name
      const results = await searchAuthors(fav.name, 5);

      if (results.length > 0) {
        // Try to find best match by paper count similarity
        const bestMatch = results.reduce((best, current) => {
          const bestDiff = Math.abs((best.paperCount || 0) - (fav.paperCount || 0));
          const currentDiff = Math.abs((current.paperCount || 0) - (fav.paperCount || 0));
          return currentDiff < bestDiff ? current : best;
        });

        migrated.push({
          authorId: bestMatch.authorId,
          openAlexId: bestMatch.openAlexId,
          name: bestMatch.name,
          orcid: bestMatch.orcid,
          paperCount: bestMatch.paperCount,
          citationCount: bestMatch.citationCount,
          hIndex: bestMatch.hIndex,
          lastChecked: fav.lastChecked || Date.now(),
          lastPaperCount: fav.lastPaperCount || fav.paperCount || 0,
          hasUpdates: false,
          newPapers: []
        });
      } else {
        // Keep old format if no match found, will need manual resolution
        migrated.push({
          ...fav,
          needsResolution: true
        });
      }
    } catch (e) {
      console.error(`Failed to migrate favorite ${fav.name}:`, e);
      migrated.push({
        ...fav,
        needsResolution: true
      });
    }
  }

  return migrated;
}

/**
 * Check if favorites need migration (have old format without OpenAlex IDs)
 * @param {Array} favorites
 * @returns {boolean}
 */
function needsMigration(favorites) {
  if (!favorites || favorites.length === 0) return false;

  return favorites.some(fav => {
    // Old format won't have authorId starting with 'A' (OpenAlex format)
    return !fav.authorId || !fav.authorId.startsWith('A');
  });
}

// ============================================
// Utility Functions
// ============================================

/**
 * Get OpenAlex profile URL for an author
 * @param {string} authorId
 * @returns {string}
 */
function getAuthorProfileUrl(authorId) {
  const id = authorId.replace('https://openalex.org/', '');
  return `https://openalex.org/authors/${id}`;
}

/**
 * Get OpenAlex profile URL for a work
 * @param {string} workId
 * @returns {string}
 */
function getWorkProfileUrl(workId) {
  const id = workId.replace('https://openalex.org/', '');
  return `https://openalex.org/works/${id}`;
}

/**
 * Format author position for display
 * @param {string} position - 'first', 'middle', 'last'
 * @returns {string}
 */
function formatAuthorPosition(position) {
  switch (position) {
    case 'first': return 'First Author';
    case 'last': return 'Senior Author';
    case 'middle': return 'Middle Author';
    default: return position;
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    searchAuthors,
    getAuthorById,
    getAuthorByOrcid,
    getAuthorWorks,
    searchWorks,
    getWorkByDoi,
    getWorkById,
    getCoauthorNetwork,
    getAuthorsDetails,
    migrateFavorites,
    needsMigration,
    getAuthorProfileUrl,
    getWorkProfileUrl,
    formatAuthorPosition,
    normalizeAuthor,
    normalizeWork,
    OPENALEX_BASE,
    OPENALEX_API_KEY
  };
}
