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

### Manual install
1. Download this repository (green **Code** button → **Download ZIP**, then unzip — or `git clone` it)
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the unzipped folder
5. A settings tab opens automatically — follow the setup below

## Setup: your free OpenAlex API key

A.N.E gets all its data from [OpenAlex](https://openalex.org/). Since **February 2026**
OpenAlex requires every request to carry an API key, so each user needs their own.
It's free and takes about 30 seconds:

1. Open A.N.E's settings (it opens itself on install; later, right-click the
   toolbar icon → **Options**)
2. Click **Get my free key** — this opens OpenAlex, where you create an account
   and copy your key
3. Paste the key into the settings page and click **Save key**

The key is checked against OpenAlex before it's saved, so you'll know immediately
whether it works. A free key includes a daily usage budget far larger than normal
browsing needs; the settings page shows how much of it is left.

### Where the key is stored

In `chrome.storage.sync` — Chrome's per-user extension storage on your own
machine, synced across your Chrome profiles if you have Chrome sync on. It is
sent only to `api.openalex.org`, as an `Authorization: Bearer` header so it never
appears in a URL.

**No API key is stored anywhere in this repository, and none ever should be.**
If you're contributing, note that `.gitignore` blocks the usual credential file
names — but the real rule is simply that the key lives in the settings page.
If a key does leak, rotate it at [openalex.org/settings/api](https://openalex.org/settings/api),
which invalidates the old one immediately.

## Data Source

All author and publication data comes from [OpenAlex](https://openalex.org/), a free and open catalog of the global research system.

## Third-party code

Network graphs are rendered with [vis-network](https://github.com/visjs/vis-network)
(bundled as `vis-network.min.js`), © vis.js contributors, dual-licensed under
Apache-2.0 and MIT.

## License

MIT
