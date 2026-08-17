// Background service worker for Author Network Explorer
// Checks favorited authors for new papers daily using OpenAlex API

// Shared key storage + the fetch wrapper that authenticates OpenAlex calls.
importScripts('ane-key.js');

const OPENALEX_BASE = 'https://api.openalex.org';

// Authenticate OpenAlex requests and track the remaining daily budget.
ANE.installFetch({
  onRateLimit: (rateLimitData) => {
    chrome.storage.local.set({ rateLimitData });
    if (rateLimitData.remaining <= 0) {
      notifyUserLimitReached(rateLimitData);
    }
  }
});
const ALARM_NAME = 'checkFavorites';
const CHECK_INTERVAL_MINUTES = 60 * 24; // Once per day

// Notify the user with a Chrome notification when API limit is reached
function notifyUserLimitReached(rateLimitData) {
  chrome.storage.local.get(['lastUserLimitNotification'], (result) => {
    const lastNotified = result.lastUserLimitNotification || 0;
    if (Date.now() - lastNotified < 60 * 60 * 1000) return; // Max once per hour
    chrome.notifications.create('apiLimitReached', {
      type: 'basic',
      iconUrl: 'icons/ane-icon.svg',
      title: 'Author Network Explorer',
      message: `Daily API limit reached (${rateLimitData.limit} calls). Data will refresh ${rateLimitData.reset ? 'at ' + rateLimitData.reset : 'tomorrow'}.`
    });
    chrome.storage.local.set({ lastUserLimitNotification: Date.now() });
  });
}

// Set up alarm on install
chrome.runtime.onInstalled.addListener(async (details) => {
  // Create daily alarm
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 1, // First check 1 minute after install
    periodInMinutes: CHECK_INTERVAL_MINUTES
  });

  // Run migration check for old favorites format
  migrateFavoritesIfNeeded();

  // OpenAlex requires an API key, so send new users straight to setup. Also
  // covers upgrades from 1.0, which shipped a shared key and so left users
  // without one of their own.
  if ((details.reason === 'install' || details.reason === 'update') && !(await ANE.hasKey())) {
    chrome.runtime.openOptionsPage();
  }
});

// Also set up alarm on startup (in case extension was updated)
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 1,
    periodInMinutes: CHECK_INTERVAL_MINUTES
  });
});

// Handle alarm
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await checkFavoritesForUpdates();
  }
});

// Migrate old favorites format to OpenAlex format
async function migrateFavoritesIfNeeded() {
  try {
    const result = await chrome.storage.local.get(['favorites', 'favoritesOpenAlexMigrated']);

    if (result.favoritesOpenAlexMigrated) return; // Already migrated to OpenAlex

    const favorites = result.favorites || [];
    if (favorites.length === 0) {
      await chrome.storage.local.set({ favoritesOpenAlexMigrated: true });
      return;
    }

    // Check if any favorites need migration (don't have OpenAlex ID format)
    const needsMigration = favorites.some(fav => {
      // OpenAlex author IDs start with 'A' followed by numbers
      return !fav.authorId || !fav.authorId.startsWith('A');
    });

    if (needsMigration) {
      const migratedFavorites = [];

      for (const fav of favorites) {
        // Already in OpenAlex format
        if (fav.authorId && fav.authorId.startsWith('A')) {
          migratedFavorites.push(fav);
          continue;
        }

        // Try to find author in OpenAlex by name
        try {
          const searchUrl = `${OPENALEX_BASE}/authors?search=${encodeURIComponent(fav.name)}&per_page=5`;
          const response = await fetch(searchUrl);

          if (response.ok) {
            const data = await response.json();
            const results = data.results || [];

            if (results.length > 0) {
              // Find best match by paper count similarity
              const bestMatch = results.reduce((best, current) => {
                const bestDiff = Math.abs((best.works_count || 0) - (fav.paperCount || 0));
                const currentDiff = Math.abs((current.works_count || 0) - (fav.paperCount || 0));
                return currentDiff < bestDiff ? current : best;
              });

              const authorId = bestMatch.id.replace('https://openalex.org/', '');

              migratedFavorites.push({
                authorId: authorId,
                openAlexId: bestMatch.id,
                name: bestMatch.display_name,
                orcid: bestMatch.orcid ? bestMatch.orcid.replace('https://orcid.org/', '') : null,
                paperCount: bestMatch.works_count || 0,
                citationCount: bestMatch.cited_by_count || 0,
                hIndex: bestMatch.summary_stats?.h_index || null,
                lastChecked: fav.lastChecked || Date.now(),
                lastPaperCount: fav.lastPaperCount || fav.paperCount || 0,
                hasUpdates: false,
                newPapers: []
              });
              continue;
            }
          }
        } catch (e) {
          console.error('Error searching OpenAlex for', fav.name, e);
        }

        // If no match found, mark for manual resolution
        migratedFavorites.push({
          ...fav,
          needsResolution: true
        });
      }

      await chrome.storage.local.set({
        favorites: migratedFavorites,
        favoritesOpenAlexMigrated: true
      });
    } else {
      await chrome.storage.local.set({ favoritesOpenAlexMigrated: true });
    }
  } catch (error) {
    console.error('Error migrating favorites:', error);
  }
}

// Check all favorites for new papers using OpenAlex
async function checkFavoritesForUpdates() {
  try {
    const result = await chrome.storage.local.get(['favorites']);
    const favorites = result.favorites || [];

    if (favorites.length === 0) return;

    let hasChanges = false;
    let newPapersCount = 0;

    for (const fav of favorites) {
      try {
        // Skip favorites that need resolution
        if (fav.needsResolution) continue;

        // Get author details from OpenAlex
        const authorUrl = `${OPENALEX_BASE}/authors/${fav.authorId}`;
        const authorResponse = await fetch(authorUrl);

        if (!authorResponse.ok) {
          continue;
        }

        const authorData = await authorResponse.json();
        const currentPaperCount = authorData.works_count || 0;

        if (currentPaperCount > (fav.lastPaperCount || 0)) {
          const newCount = currentPaperCount - (fav.lastPaperCount || 0);

          // Get recent works
          const worksUrl = `${OPENALEX_BASE}/works?filter=author.id:${fav.authorId}&sort=publication_year:desc&per_page=${Math.min(newCount + 5, 25)}`;
          const worksResponse = await fetch(worksUrl);

          let newPapers = [];
          if (worksResponse.ok) {
            const worksData = await worksResponse.json();
            const currentYear = new Date().getFullYear();

            newPapers = (worksData.results || [])
              .filter(work => work.publication_year && work.publication_year >= currentYear - 1)
              .slice(0, newCount)
              .map(work => ({
                workId: work.id.replace('https://openalex.org/', ''),
                doi: work.doi ? work.doi.replace('https://doi.org/', '') : null,
                title: work.display_name || work.title || 'Untitled',
                year: work.publication_year,
                citationCount: work.cited_by_count || 0
              }));
          }

          fav.newPapers = newPapers;
          fav.hasUpdates = true;
          fav.lastPaperCount = currentPaperCount;
          fav.paperCount = currentPaperCount;
          newPapersCount += newCount;
          hasChanges = true;
        }

        // Update stats
        fav.citationCount = authorData.cited_by_count || fav.citationCount;
        fav.hIndex = authorData.summary_stats?.h_index || fav.hIndex;
        fav.lastChecked = Date.now();
        hasChanges = true;

        // Small delay to be polite to API
        await new Promise(resolve => setTimeout(resolve, 200));

      } catch (error) {
        console.error('Error checking favorite:', fav.name, error);
      }
    }

    if (hasChanges) {
      await chrome.storage.local.set({ favorites });

      // Update badge to show new papers available
      if (newPapersCount > 0) {
        chrome.action.setBadgeText({ text: String(newPapersCount) });
        chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
      }
    }

  } catch (error) {
    console.error('Error in checkFavoritesForUpdates:', error);
  }
}

// Clear badge when popup opens
chrome.action.onClicked.addListener(() => {
  chrome.action.setBadgeText({ text: '' });
});

// Listen for messages from popup/fullpage/content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'clearBadge') {
    chrome.action.setBadgeText({ text: '' });
    sendResponse({ success: true });
  } else if (message.type === 'openAuthorExplorer') {
    // Open fullpage.html with author parameter from content script
    chrome.tabs.create({ url: message.url });
    sendResponse({ success: true });
  } else if (message.type === 'addPaperToCollection') {
    // Add paper from content script to the active collection
    addPaperFromContentScript(message.paper)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep message channel open for async response
  } else if (message.type === 'fetchOpenAlex') {
    // Fetch from OpenAlex API (bypasses CORS issues in extension pages)
    fetchOpenAlex(message.endpoint)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  return true;
});

// Add paper from content script to collection
async function addPaperFromContentScript(paperInfo) {
  try {
    // Get collections from storage
    const result = await chrome.storage.local.get(['paperCollections', 'activeCollectionId']);
    let collections = result.paperCollections || [];
    let activeCollectionId = result.activeCollectionId;

    // If no active collection, create a default one
    if (!activeCollectionId || !collections.find(c => c.id === activeCollectionId)) {
      const defaultCollection = {
        id: `col_${Date.now()}`,
        name: 'Quick Collection',
        isQuickCollection: true,
        papers: [],
        createdAt: Date.now()
      };
      collections.push(defaultCollection);
      activeCollectionId = defaultCollection.id;
    }

    const collection = collections.find(c => c.id === activeCollectionId);
    if (!collection) {
      return { success: false, error: 'No collection found' };
    }

    // Search OpenAlex for full paper details
    let fullPaper = null;
    if (paperInfo.title) {
      try {
        const searchUrl = `${OPENALEX_BASE}/works?search=${encodeURIComponent(paperInfo.title)}&per_page=5`;
        const response = await fetch(searchUrl);

        if (response.ok) {
          const data = await response.json();
          const results = data.results || [];

          if (results.length > 0) {
            // Find best match by title similarity
            const work = results[0];
            fullPaper = {
              workId: work.id?.replace('https://openalex.org/', ''),
              doi: work.doi?.replace('https://doi.org/', ''),
              title: work.display_name || paperInfo.title,
              year: work.publication_year,
              citationCount: work.cited_by_count || 0,
              authors: (work.authorships || []).slice(0, 5).map(a => ({
                authorId: a.author?.id?.replace('https://openalex.org/', ''),
                name: a.author?.display_name || 'Unknown'
              })),
              concepts: (work.concepts || []).slice(0, 5).map(c => ({
                id: c.id,
                name: c.display_name,
                score: c.score
              })),
              references: work.referenced_works || [],
              addedAt: Date.now()
            };
          }
        }
      } catch (e) {
        console.error('Error searching OpenAlex:', e);
      }
    }

    // If no OpenAlex match, use basic info
    if (!fullPaper) {
      fullPaper = {
        workId: `manual_${Date.now()}`,
        title: paperInfo.title,
        link: paperInfo.link,
        authors: [],
        concepts: [],
        references: [],
        addedAt: Date.now()
      };
    }

    // Check if paper already exists in collection
    if (collection.papers.some(p => p.workId === fullPaper.workId || (p.title && p.title === fullPaper.title))) {
      return { success: true, message: 'Paper already in collection' };
    }

    // Add paper to collection
    collection.papers.push(fullPaper);

    // Save back to storage
    await chrome.storage.local.set({
      paperCollections: collections,
      activeCollectionId: activeCollectionId
    });

    return { success: true, message: 'Paper added to collection' };

  } catch (error) {
    console.error('Error adding paper to collection:', error);
    return { success: false, error: error.message };
  }
}

// Fetch from OpenAlex API. The user's key is attached by the wrapper in ane-key.js.
async function fetchOpenAlex(endpoint) {
  const url = endpoint.startsWith('http') ? endpoint : `${OPENALEX_BASE}${endpoint}`;

  if (!(await ANE.hasKey())) {
    throw new Error('No OpenAlex API key configured. Open A.N.E settings to add one.');
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`OpenAlex API error: ${response.status}`);
  }

  return await response.json();
}
