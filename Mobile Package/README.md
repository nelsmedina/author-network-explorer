# Author Network Explorer — Mobile

Self-contained mobile prototype. Open `Author Network Explorer Mobile.html` in a browser (the React/Babel/font CDNs load over the network).

## Files

| File | Purpose |
|---|---|
| `Author Network Explorer Mobile.html` | Entry point — boots the React app inside an iOS device frame. |
| `styles.css` | Shared design tokens (colors, type scale, surfaces) used by both desktop and mobile. |
| `mobile-styles.css` | Mobile-specific layout: search bar, tab bar, sheets, status-bar offset. |
| `ios-frame.jsx` | iOS device bezel (status bar, dynamic island, home indicator). Exposes `window.IOSDevice`. |
| `network-data.jsx` | Author + edge dataset and helper queries. Exposes `window.ANE_DATA`. |
| `network-graph.jsx` | SVG force-directed graph component with cluster-drag, focal-alpha labels, pan/zoom. Exposes `window.NetworkGraph`. |
| `mobile-app.jsx` | Mobile screens: graph view, author detail sheet, search, tab bar. Exposes `window.MobileApp`. |

## Notes

- Scripts are loaded as Babel JSX in the browser — no build step.
- `network-graph.jsx` carries the focal-distance label alpha and per-cluster drag logic.
- Cluster offsets reset whenever the dataset changes.
