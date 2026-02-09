# Author Network Explorer (A.N.E)

A Chrome extension for visualizing scientific author collaboration networks using [OpenAlex](https://openalex.org/) data.

## Features

- **Author Networks** — Search any researcher and visualize their co-author network as an interactive graph
- **Path Finder** — Find collaboration paths between any two authors
- **Favorites** — Track authors and get notified when they publish new papers
- **Collections** — Curate paper playlists, discover missing related papers, and explore collection author networks
- **CSV Export** — Export favorites and collections for external use
- **Retraction Checking** — See retraction status for any author's papers via OpenAlex
- **Persistent Caching** — Author data is cached locally so revisiting authors doesn't re-fetch from the API
- **Content Script Integration** — Adds buttons on Google Scholar, PubMed, arXiv, Nature, and other academic sites to quickly explore authors or add papers to collections

## Supported Sites

The content script activates on:
Google Scholar, PubMed, arXiv, Nature, IEEE Xplore, ACM Digital Library, Science.org, Cell, ScienceDirect, PNAS, bioRxiv, medRxiv, eLife

## Installation

### Chrome Web Store
Coming soon.

### Manual Install
1. Clone this repository
2. Open `chrome://extensions/` in Chrome
3. Enable "Developer mode" (top right)
4. Click "Load unpacked" and select the cloned folder

## Data Source

All author and publication data comes from [OpenAlex](https://openalex.org/), a free and open catalog of the global research system.

## License

MIT
