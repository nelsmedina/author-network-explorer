// Author Network Explorer - Content Script
// Injects clickable icons next to author names on academic journal websites

(function() {
  'use strict';

  // Track processed elements to avoid duplicates
  const processedElements = new WeakSet();

  // Batch processing limit to avoid page slowdown
  const BATCH_LIMIT = 50;

  // Debounce timeout for MutationObserver
  let debounceTimer = null;
  const DEBOUNCE_DELAY = 300;

  // Get the icon URL from extension
  const iconUrl = chrome.runtime.getURL('icons/ane-icon.svg');

  // Site-specific configurations
  const siteConfigs = {
    'semanticscholar.org': {
      selectors: [
        'a[href*="/author/"]'
      ],
      getAuthorName: (el) => el.textContent.trim(),
      isValidAuthor: (el) => {
        const href = el.getAttribute('href') || '';
        return href.includes('/author/') && el.textContent.trim().length > 0;
      }
    },
    'scholar.google.com': {
      selectors: [
        '.gs_a a'
      ],
      getAuthorName: (el) => el.textContent.trim(),
      isValidAuthor: (el) => {
        // Filter out non-author links (journal names, years, etc.)
        const text = el.textContent.trim();
        const parent = el.closest('.gs_a');
        if (!parent) return false;
        // Check if this link is in the author section (before the dash or hyphen)
        const parentText = parent.textContent;
        const dashIndex = parentText.search(/\s[-–—]\s/);
        if (dashIndex === -1) return text.length > 0 && text.length < 100;
        const authorSection = parentText.substring(0, dashIndex);
        return authorSection.includes(text) && text.length > 0 && text.length < 100;
      },
      // Extract paper context for cross-referencing
      getPaperContext: (el) => {
        // Find the parent result container - try multiple selectors
        let resultItem = el.closest('.gs_r');
        if (!resultItem) resultItem = el.closest('.gs_ri');
        if (!resultItem) resultItem = el.closest('[data-cid]');
        if (!resultItem) resultItem = el.closest('[data-aid]');
        // Try going up to find any container with a title
        if (!resultItem) {
          let parent = el.parentElement;
          while (parent && !resultItem) {
            if (parent.querySelector('.gs_rt, h3')) {
              resultItem = parent;
            }
            parent = parent.parentElement;
          }
        }

        if (!resultItem) {
          console.log('ANE: Could not find result container for author element');
          return null;
        }

        // Get paper title - try multiple selectors
        let titleEl = resultItem.querySelector('.gs_rt a');
        if (!titleEl) titleEl = resultItem.querySelector('.gs_rt');
        if (!titleEl) titleEl = resultItem.querySelector('h3 a');
        if (!titleEl) titleEl = resultItem.querySelector('h3');

        const title = titleEl ? titleEl.textContent.replace(/^\[.*?\]\s*/, '').trim() : null;

        if (!title) {
          console.log('ANE: Could not find title in result container');
          return null;
        }

        // Get all authors from the .gs_a element
        const gsA = resultItem.querySelector('.gs_a');
        const allAuthors = [];
        if (gsA) {
          const authorLinks = gsA.querySelectorAll('a');
          const gsAText = gsA.textContent;
          const dashIndex = gsAText.search(/\s[-–—]\s/);
          const authorSection = dashIndex > -1 ? gsAText.substring(0, dashIndex) : gsAText;

          authorLinks.forEach(link => {
            const name = link.textContent.trim();
            if (authorSection.includes(name) && name.length > 0 && name.length < 100) {
              allAuthors.push(name);
            }
          });
        }

        console.log('ANE: Extracted paper context - Title:', title, 'Authors:', allAuthors);
        return { title, allAuthors };
      }
    },
    'pubmed.ncbi.nlm.nih.gov': {
      selectors: [
        '.authors-list-item a',
        '.full-name',
        'a[data-ga-action="author"]'
      ],
      getAuthorName: (el) => el.textContent.trim(),
      isValidAuthor: (el) => el.textContent.trim().length > 0
    },
    'arxiv.org': {
      selectors: [
        '.authors a'
      ],
      getAuthorName: (el) => el.textContent.trim(),
      isValidAuthor: (el) => el.textContent.trim().length > 0
    },
    'nature.com': {
      selectors: [
        'a[data-test="author-name"]',
        '.c-article-author-list a',
        '.author-name a',
        'li[itemprop="author"] a'
      ],
      getAuthorName: (el) => el.textContent.trim(),
      isValidAuthor: (el) => el.textContent.trim().length > 0
    },
    'ieeexplore.ieee.org': {
      selectors: [
        'a[href*="/author/"]',
        '.authors-info a',
        'span.author-name'
      ],
      getAuthorName: (el) => el.textContent.trim(),
      isValidAuthor: (el) => el.textContent.trim().length > 0
    },
    'dl.acm.org': {
      selectors: [
        'a[href*="/profile/"]',
        '.author-name a',
        '.loa__author-name a'
      ],
      getAuthorName: (el) => el.textContent.trim(),
      isValidAuthor: (el) => {
        const href = el.getAttribute('href') || '';
        return href.includes('/profile/') && el.textContent.trim().length > 0;
      }
    },
    'science.org': {
      selectors: [
        'a[data-author-popup]',
        '.contributor-list a[href*="/author/"]',
        '.core-authors a',
        '.author-name a',
        'a.linked-name'
      ],
      getAuthorName: (el) => el.textContent.trim(),
      isValidAuthor: (el) => el.textContent.trim().length > 0 && el.textContent.trim().length < 100
    },
    'cell.com': {
      selectors: [
        '.author-list a.author-name',
        '.author-group a',
        'a[href*="/authored-by/"]',
        '.loa a',
        '.author-name-link'
      ],
      getAuthorName: (el) => el.textContent.trim(),
      isValidAuthor: (el) => el.textContent.trim().length > 0 && el.textContent.trim().length < 100
    },
    'elifesciences.org': {
      selectors: [
        '.author_list_item a',
        '.author_link',
        '.author_link_highlight',
        '.authors a[href*="/authored-by/"]'
      ],
      getAuthorName: (el) => el.textContent.trim(),
      isValidAuthor: (el) => el.textContent.trim().length > 0 && el.textContent.trim().length < 100
    },
    'sciencedirect.com': {
      selectors: [
        '.author-group a',
        '.author-name-link',
        'a.author'
      ],
      getAuthorName: (el) => el.textContent.trim(),
      isValidAuthor: (el) => el.textContent.trim().length > 0
    },
    'pnas.org': {
      selectors: [
        '.contrib-author a',
        '.author-name a'
      ],
      getAuthorName: (el) => el.textContent.trim(),
      isValidAuthor: (el) => el.textContent.trim().length > 0
    },
    'bioRxiv.org': {
      selectors: [
        '.highwire-citation-author a',
        '.author-name a'
      ],
      getAuthorName: (el) => el.textContent.trim(),
      isValidAuthor: (el) => el.textContent.trim().length > 0
    },
    'medrxiv.org': {
      selectors: [
        '.highwire-citation-author a',
        '.author-name a'
      ],
      getAuthorName: (el) => el.textContent.trim(),
      isValidAuthor: (el) => el.textContent.trim().length > 0
    }
  };

  // Get current site config
  function getSiteConfig() {
    const hostname = window.location.hostname.toLowerCase();

    for (const [domain, config] of Object.entries(siteConfigs)) {
      if (hostname.includes(domain.toLowerCase())) {
        return config;
      }
    }

    return null;
  }

  // Create the clickable icon element
  function createIcon(authorName, paperContext) {
    const wrapper = document.createElement('span');
    wrapper.className = 'ane-icon-wrapper';
    wrapper.title = `Explore ${authorName}'s network`;

    const img = document.createElement('img');
    img.src = iconUrl;
    img.alt = 'Explore author network';

    wrapper.appendChild(img);

    // Handle click
    wrapper.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Build URL to fullpage with author parameter
      let fullpageUrl = chrome.runtime.getURL('fullpage.html') +
        '?author=' + encodeURIComponent(authorName);

      // Add paper context for cross-referencing if available
      if (paperContext && paperContext.title) {
        console.log('ANE: Opening with paper context:', paperContext.title, 'Author:', authorName);
        fullpageUrl += '&paperTitle=' + encodeURIComponent(paperContext.title);
        if (paperContext.allAuthors && paperContext.allAuthors.length > 0) {
          fullpageUrl += '&allAuthors=' + encodeURIComponent(paperContext.allAuthors.join('|'));
        }
      } else {
        console.log('ANE: Opening without paper context for:', authorName);
      }

      // Send message to background script to open new tab
      chrome.runtime.sendMessage({
        type: 'openAuthorExplorer',
        url: fullpageUrl
      }).catch(err => {
        console.error('ANE: Failed to send message:', err);
        // Fallback: try opening directly
        window.open(fullpageUrl, '_blank');
      });
    });

    return wrapper;
  }

  // Process author elements and inject icons
  function processAuthorElements(config) {
    let processedCount = 0;

    for (const selector of config.selectors) {
      const elements = document.querySelectorAll(selector);

      for (const el of elements) {
        if (processedCount >= BATCH_LIMIT) {
          // Schedule another pass if we hit the limit
          scheduleProcess();
          return;
        }

        if (processedElements.has(el)) {
          continue;
        }

        if (!config.isValidAuthor(el)) {
          processedElements.add(el);
          continue;
        }

        const authorName = config.getAuthorName(el);
        if (!authorName || authorName.length < 2) {
          processedElements.add(el);
          continue;
        }

        // Extract paper context if available (for cross-referencing)
        const paperContext = config.getPaperContext ? config.getPaperContext(el) : null;

        // Create and inject icon
        const icon = createIcon(authorName, paperContext);

        // Insert after the element or inside it depending on element type
        if (el.tagName === 'A') {
          // Insert after the link
          el.parentNode.insertBefore(icon, el.nextSibling);
        } else {
          // Append inside the element
          el.appendChild(icon);
        }

        processedElements.add(el);
        processedCount++;
      }
    }
  }

  // Debounced processing function
  function scheduleProcess() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      const config = getSiteConfig();
      if (config) {
        processAuthorElements(config);
      }
    }, DEBOUNCE_DELAY);
  }

  // Set up MutationObserver for dynamically loaded content
  function setupObserver() {
    const observer = new MutationObserver((mutations) => {
      // Check if any relevant nodes were added
      let hasNewNodes = false;

      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              hasNewNodes = true;
              break;
            }
          }
        }
        if (hasNewNodes) break;
      }

      if (hasNewNodes) {
        scheduleProcess();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // Initialize
  function init() {
    const config = getSiteConfig();

    if (!config) {
      console.log('Author Network Explorer: No config for this site');
      return;
    }

    console.log('Author Network Explorer: Initializing on', window.location.hostname);

    // Initial processing
    processAuthorElements(config);

    // Set up observer for dynamic content
    setupObserver();
  }

  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
