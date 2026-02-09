// Author Network Explorer - Content Script
// Injects clickable icons next to author names and paper titles on academic journal websites

(function() {
  'use strict';

  // Track processed elements to avoid duplicates
  const processedElements = new WeakSet();
  const processedPaperElements = new WeakSet();

  // Batch processing limit to avoid page slowdown
  const BATCH_LIMIT = 50;

  // Debounce timeout for MutationObserver
  let debounceTimer = null;
  const DEBOUNCE_DELAY = 300;

  // Get icon URLs from extension
  const iconUrl = chrome.runtime.getURL('icons/ane-icon.svg');
  const collectionIconUrl = chrome.runtime.getURL('icons/ane-collection-icon.svg');

  // Site-specific configurations
  const siteConfigs = {
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
          return null;
        }

        // Get paper title - try multiple selectors
        let titleEl = resultItem.querySelector('.gs_rt a');
        if (!titleEl) titleEl = resultItem.querySelector('.gs_rt');
        if (!titleEl) titleEl = resultItem.querySelector('h3 a');
        if (!titleEl) titleEl = resultItem.querySelector('h3');

        const title = titleEl ? titleEl.textContent.replace(/^\[.*?\]\s*/, '').trim() : null;

        if (!title) {
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

  // Paper-specific configurations for collection icons
  const paperConfigs = {
    'scholar.google.com': {
      selectors: ['.gs_rt'],  // Only select the container, not both container and link
      getPaperInfo: (el) => {
        const link = el.querySelector('a');
        return {
          title: el.textContent.replace(/^\[.*?\]\s*/, '').trim(),
          link: link ? link.href : null
        };
      },
      isValidPaper: (el) => {
        const text = el.textContent.replace(/^\[.*?\]\s*/, '').trim();
        // Also check we haven't already added an icon
        return text.length > 10 && text.length < 500 && !el.querySelector('.ane-collection-icon');
      }
    },
    'pubmed.ncbi.nlm.nih.gov': {
      selectors: ['.docsum-title', 'h1.heading-title'],
      getPaperInfo: (el) => ({
        title: el.textContent.trim(),
        pmid: window.location.pathname.match(/\/(\d+)/)?.[1],
        link: window.location.href
      }),
      isValidPaper: (el) => el.textContent.trim().length > 10
    },
    'arxiv.org': {
      selectors: ['h1.title'],
      getPaperInfo: (el) => ({
        title: el.textContent.replace(/^Title:\s*/i, '').trim(),
        arxivId: window.location.pathname.match(/abs\/(.+)/)?.[1],
        link: window.location.href
      }),
      isValidPaper: (el) => el.textContent.replace(/^Title:\s*/i, '').trim().length > 10
    },
    'nature.com': {
      selectors: ['h1.c-article-title', 'h1[itemprop="headline"]', '.c-card__title a'],
      getPaperInfo: (el) => ({
        title: el.textContent.trim(),
        link: el.tagName === 'A' ? el.href : window.location.href
      }),
      isValidPaper: (el) => el.textContent.trim().length > 10 && !el.querySelector('.ane-collection-icon')
    },
    'ieeexplore.ieee.org': {
      selectors: ['h1.document-title', '.result-item-title'],
      getPaperInfo: (el) => ({
        title: el.textContent.trim(),
        link: window.location.href
      }),
      isValidPaper: (el) => el.textContent.trim().length > 10 && !el.querySelector('.ane-collection-icon')
    },
    'dl.acm.org': {
      selectors: ['h1.citation__title', '.issue-item__title a'],
      getPaperInfo: (el) => ({
        title: el.textContent.trim(),
        link: el.tagName === 'A' ? el.href : window.location.href
      }),
      isValidPaper: (el) => el.textContent.trim().length > 10 && !el.querySelector('.ane-collection-icon')
    },
    'science.org': {
      selectors: ['h1.article__headline', '.card-header a'],
      getPaperInfo: (el) => ({
        title: el.textContent.trim(),
        link: el.tagName === 'A' ? el.href : window.location.href
      }),
      isValidPaper: (el) => el.textContent.trim().length > 10 && !el.querySelector('.ane-collection-icon')
    },
    'cell.com': {
      selectors: ['h1.article-header__title', '.article-title'],
      getPaperInfo: (el) => ({
        title: el.textContent.trim(),
        link: window.location.href
      }),
      isValidPaper: (el) => el.textContent.trim().length > 10 && !el.querySelector('.ane-collection-icon')
    },
    'elifesciences.org': {
      selectors: ['h1.content-header__title', '.teaser__header_text a'],
      getPaperInfo: (el) => ({
        title: el.textContent.trim(),
        link: el.tagName === 'A' ? el.href : window.location.href
      }),
      isValidPaper: (el) => el.textContent.trim().length > 10 && !el.querySelector('.ane-collection-icon')
    },
    'sciencedirect.com': {
      selectors: ['h1.title-text', '.result-list-title-link'],
      getPaperInfo: (el) => ({
        title: el.textContent.trim(),
        link: el.tagName === 'A' ? el.href : window.location.href
      }),
      isValidPaper: (el) => el.textContent.trim().length > 10 && !el.querySelector('.ane-collection-icon')
    },
    'pnas.org': {
      selectors: ['h1#page-title', 'h1.highwire-cite-title'],
      getPaperInfo: (el) => ({
        title: el.textContent.trim(),
        link: window.location.href
      }),
      isValidPaper: (el) => el.textContent.trim().length > 10 && !el.querySelector('.ane-collection-icon')
    },
    'biorxiv.org': {
      selectors: ['h1#page-title', 'h1.highwire-cite-title'],
      getPaperInfo: (el) => ({
        title: el.textContent.trim(),
        link: window.location.href
      }),
      isValidPaper: (el) => el.textContent.trim().length > 10 && !el.querySelector('.ane-collection-icon')
    },
    'medrxiv.org': {
      selectors: ['h1#page-title', 'h1.highwire-cite-title'],
      getPaperInfo: (el) => ({
        title: el.textContent.trim(),
        link: window.location.href
      }),
      isValidPaper: (el) => el.textContent.trim().length > 10 && !el.querySelector('.ane-collection-icon')
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
        fullpageUrl += '&paperTitle=' + encodeURIComponent(paperContext.title);
        if (paperContext.allAuthors && paperContext.allAuthors.length > 0) {
          fullpageUrl += '&allAuthors=' + encodeURIComponent(paperContext.allAuthors.join('|'));
        }
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

  // Create a collection icon element for papers
  function createCollectionIcon(paperInfo) {
    const icon = document.createElement('img');
    icon.src = collectionIconUrl;
    icon.className = 'ane-collection-icon';
    icon.title = 'Add to collection';
    icon.style.cssText = `
      width: 16px;
      height: 16px;
      vertical-align: middle;
      margin-left: 6px;
      cursor: pointer;
      opacity: 0.7;
      transition: opacity 0.2s, transform 0.2s;
      display: inline-block;
    `;

    icon.addEventListener('mouseenter', () => {
      icon.style.opacity = '1';
      icon.style.transform = 'scale(1.15)';
    });

    icon.addEventListener('mouseleave', () => {
      icon.style.opacity = '0.7';
      icon.style.transform = 'scale(1)';
    });

    icon.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Disable further clicks
      icon.style.pointerEvents = 'none';

      // Send paper info to background script
      chrome.runtime.sendMessage({
        type: 'addPaperToCollection',
        paper: paperInfo
      }, (response) => {
        if (response && response.success) {
          // Bounce up animation
          icon.style.transition = 'transform 0.15s ease-out, opacity 0.3s ease-out';
          icon.style.transform = 'translateY(-8px) scale(1.3)';
          icon.style.opacity = '1';

          // Bounce down and fade out
          setTimeout(() => {
            icon.style.transition = 'transform 0.15s ease-in, opacity 0.2s ease-out';
            icon.style.transform = 'translateY(-4px) scale(1.1)';
          }, 150);

          // Final bounce and disappear
          setTimeout(() => {
            icon.style.transition = 'transform 0.2s ease-out, opacity 0.3s ease-out';
            icon.style.transform = 'translateY(-12px) scale(0.5)';
            icon.style.opacity = '0';
          }, 300);

          // Remove from DOM
          setTimeout(() => {
            icon.remove();
          }, 600);
        } else {
          // Re-enable if failed
          icon.style.pointerEvents = 'auto';
        }
      });
    });

    return icon;
  }

  // Get paper config for current site
  function getPaperConfig() {
    const hostname = window.location.hostname.toLowerCase();

    for (const [domain, config] of Object.entries(paperConfigs)) {
      if (hostname.includes(domain.toLowerCase())) {
        return config;
      }
    }

    return null;
  }

  // Inject collection icons next to paper titles
  function processPaperElements() {
    const config = getPaperConfig();
    if (!config) return;

    let processed = 0;

    for (const selector of config.selectors) {
      const elements = document.querySelectorAll(selector);

      for (const el of elements) {
        if (processed >= BATCH_LIMIT) break;
        if (processedPaperElements.has(el)) continue;

        if (!config.isValidPaper(el)) {
          processedPaperElements.add(el);
          continue;
        }

        const paperInfo = config.getPaperInfo(el);
        if (!paperInfo.title) {
          processedPaperElements.add(el);
          continue;
        }

        try {
          const icon = createCollectionIcon(paperInfo);

          // Find the best place to insert the icon
          if (el.tagName === 'A') {
            el.parentNode.insertBefore(icon, el.nextSibling);
          } else {
            el.appendChild(icon);
          }

          processedPaperElements.add(el);
          processed++;
        } catch (e) {
          console.error('ANE: Error adding collection icon:', e);
        }
      }
    }
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
      // Also process papers for collection icons
      processPaperElements();
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
    const paperConfig = getPaperConfig();

    if (!config && !paperConfig) {
      return;
    }

    // Initial processing for authors
    if (config) {
      processAuthorElements(config);
    }

    // Initial processing for papers (collection icons)
    if (paperConfig) {
      processPaperElements();
    }

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
