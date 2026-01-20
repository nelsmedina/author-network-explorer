// Background service worker for Author Network Explorer
// Checks favorited authors for new papers daily using Crossref API

const CROSSREF_BASE = 'https://api.crossref.org';
const MAILTO = 'author-network-explorer@example.com';
const ALARM_NAME = 'checkFavorites';
const CHECK_INTERVAL_MINUTES = 60 * 24; // Once per day

// Set up alarm on install
chrome.runtime.onInstalled.addListener(() => {
  // Create daily alarm
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 1, // First check 1 minute after install
    periodInMinutes: CHECK_INTERVAL_MINUTES
  });

  // Run migration check for old favorites format
  migrateFavoritesIfNeeded();

  console.log('Author Network Explorer: Background service initialized');
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

// Migrate old favorites format (Semantic Scholar) to new format (Crossref)
async function migrateFavoritesIfNeeded() {
  try {
    const result = await chrome.storage.local.get(['favorites', 'favoritesMigrated']);

    if (result.favoritesMigrated) return; // Already migrated

    const favorites = result.favorites || [];
    if (favorites.length === 0) {
      await chrome.storage.local.set({ favoritesMigrated: true });
      return;
    }

    // Check if any favorites have old format (no orcid: or name: prefix)
    const needsMigration = favorites.some(fav => {
      const id = fav.authorId;
      return !id.startsWith('orcid:') && !id.startsWith('name:');
    });

    if (needsMigration) {
      console.log('Migrating favorites to new format...');

      const migratedFavorites = favorites.map(fav => {
        // Already in new format
        if (fav.authorId.startsWith('orcid:') || fav.authorId.startsWith('name:')) {
          return fav;
        }

        // Migrate to new format
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
          searchQuery: fav.name
        };
      });

      await chrome.storage.local.set({
        favorites: migratedFavorites,
        favoritesMigrated: true
      });

      console.log('Favorites migration complete');
    } else {
      await chrome.storage.local.set({ favoritesMigrated: true });
    }
  } catch (error) {
    console.error('Error migrating favorites:', error);
  }
}

// Normalize author name for ID generation
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

// Check all favorites for new papers using Crossref
async function checkFavoritesForUpdates() {
  try {
    const result = await chrome.storage.local.get(['favorites']);
    const favorites = result.favorites || [];

    if (favorites.length === 0) return;

    console.log('Checking', favorites.length, 'favorites for updates...');

    let hasChanges = false;
    let newPapersCount = 0;

    for (const fav of favorites) {
      try {
        // Use searchQuery (original name) or derive from authorId
        const searchQuery = fav.searchQuery || fav.name;

        // Search for works by this author
        const url = `${CROSSREF_BASE}/works?mailto=${MAILTO}&query.author=${encodeURIComponent(searchQuery)}&rows=20&sort=published&order=desc&select=DOI,title,published,is-referenced-by-count,author`;

        const response = await fetch(url);

        if (!response.ok) {
          console.log('API error for', fav.name, ':', response.status);
          continue;
        }

        const data = await response.json();
        const works = data.message?.items || [];

        // Count papers by this author (simple name matching)
        const authorWorks = works.filter(work => {
          if (!work.author) return false;
          return work.author.some(a => {
            const authorName = a.given && a.family ? `${a.given} ${a.family}` : (a.name || a.family || '');
            return authorName.toLowerCase().includes(fav.name.toLowerCase().split(' ').pop());
          });
        });

        const paperCount = authorWorks.length;

        if (paperCount > (fav.lastPaperCount || 0)) {
          const newCount = paperCount - (fav.lastPaperCount || 0);
          console.log(`${fav.name}: ${newCount} new paper(s)`);

          // Get recent papers
          const currentYear = new Date().getFullYear();
          const newPapers = authorWorks
            .filter(work => {
              if (!work.published || !work.published['date-parts']) return false;
              const year = work.published['date-parts'][0]?.[0];
              return year && year >= currentYear - 1;
            })
            .slice(0, newCount)
            .map(work => ({
              doi: work.DOI,
              title: Array.isArray(work.title) ? work.title[0] : work.title,
              year: work.published?.['date-parts']?.[0]?.[0] || null,
              citationCount: work['is-referenced-by-count'] || 0
            }));

          fav.newPapers = newPapers;
          fav.hasUpdates = true;
          fav.lastPaperCount = paperCount;
          fav.paperCount = paperCount;
          newPapersCount += newCount;
          hasChanges = true;
        }

        // Update citation count
        const totalCitations = authorWorks.reduce((sum, w) => sum + (w['is-referenced-by-count'] || 0), 0);
        if (totalCitations !== fav.citationCount) {
          fav.citationCount = totalCitations;
          hasChanges = true;
        }

        fav.lastChecked = Date.now();

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));

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

    console.log('Favorites check complete');

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
  } else if (message.type === 'fetchCrossref') {
    // Fetch from Crossref API (bypasses CORS issues in extension pages)
    fetchCrossref(message.doi)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep message channel open for async response
  }
  return true;
});

// Fetch retraction data from Crossref API
async function fetchCrossref(doi) {
  const response = await fetch(
    `${CROSSREF_BASE}/works/${encodeURIComponent(doi)}?mailto=${MAILTO}`,
    {
      headers: {
        'User-Agent': 'AuthorNetworkExplorer/1.0 (Chrome Extension)'
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Crossref API error: ${response.status}`);
  }

  return await response.json();
}
