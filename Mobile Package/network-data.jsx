// Realistic-feeling author network data for an NLP/IR research subgraph.
// Not a real dataset — shaped to look like genuine OpenAlex output:
// citation counts in plausible bands, h-index ~ sqrt(citations)/2, clusters
// representing research subcommunities.

const AUTHORS = [
  // Central author
  { id: "a01", name: "M. Aritz Bilbao",        papers: 142, citations: 9821, h: 47, repeatRate: 0.62, avgTeam: 4.1, cluster: 0, central: true,
    affiliation: "ETH Zürich",
    topics: ["information retrieval", "neural ranking", "evaluation"],
    velocity: [12, 18, 22, 31, 28, 45, 62, 71, 88, 102, 134, 168, 195, 221, 268, 312, 341, 389, 412, 458] },

  // Cluster 1 — close collaborators (IR / ranking)
  { id: "a02", name: "Helena Vasiliev",        papers: 98,  citations: 6210, h: 38, repeatRate: 0.58, avgTeam: 3.8, cluster: 1, central: false,
    affiliation: "University of Edinburgh",
    topics: ["learning to rank", "BERT", "retrieval"] },
  { id: "a03", name: "Tomás Gallego",          papers: 71,  citations: 4120, h: 31, repeatRate: 0.71, avgTeam: 4.6, cluster: 1, central: false,
    affiliation: "ETH Zürich",
    topics: ["evaluation", "test collections", "TREC"] },
  { id: "a04", name: "Linnea Wahlström",       papers: 54,  citations: 2903, h: 26, repeatRate: 0.49, avgTeam: 3.2, cluster: 1, central: false,
    affiliation: "Uppsala University",
    topics: ["query understanding", "user behavior"] },
  { id: "a05", name: "Yusuf Demirci",          papers: 39,  citations: 1718, h: 22, repeatRate: 0.44, avgTeam: 5.1, cluster: 1, central: false,
    affiliation: "Bilkent University",
    topics: ["dense retrieval", "embeddings"] },

  // Cluster 2 — NLP / language models
  { id: "a06", name: "Chiamaka Okeke",         papers: 86,  citations: 5402, h: 34, repeatRate: 0.55, avgTeam: 4.3, cluster: 2, central: false,
    affiliation: "University of Cape Town",
    topics: ["low-resource NLP", "African languages"] },
  { id: "a07", name: "Pieter van der Vaart",   papers: 67,  citations: 4488, h: 30, repeatRate: 0.66, avgTeam: 3.9, cluster: 2, central: false,
    affiliation: "TU Delft",
    topics: ["language models", "interpretability"] },
  { id: "a08", name: "Naoko Tsuji",            papers: 52,  citations: 3110, h: 27, repeatRate: 0.51, avgTeam: 4.0, cluster: 2, central: false,
    affiliation: "Kyoto University",
    topics: ["machine translation", "alignment"] },
  { id: "a09", name: "Idris Mensah",           papers: 34,  citations: 1402, h: 19, repeatRate: 0.41, avgTeam: 4.8, cluster: 2, central: false,
    affiliation: "University of Ghana",
    topics: ["NER", "low-resource"] },

  // Cluster 3 — HCI / user studies (bridge nodes)
  { id: "a10", name: "Sigrid Petersen",        papers: 61,  citations: 2840, h: 24, repeatRate: 0.47, avgTeam: 5.5, cluster: 3, central: false,
    affiliation: "Aarhus University",
    topics: ["search UX", "qualitative methods"] },
  { id: "a11", name: "Rajiv Krishnamurthy",    papers: 44,  citations: 2011, h: 22, repeatRate: 0.39, avgTeam: 6.2, cluster: 3, central: false,
    affiliation: "IIT Bombay",
    topics: ["user studies", "search behavior"] },

  // Extended / weak ties
  { id: "a12", name: "Erez Halevi",            papers: 28,  citations: 941,  h: 14, repeatRate: 0.32, avgTeam: 3.4, cluster: 4, central: false,
    affiliation: "Hebrew University",
    topics: ["question answering"] },
  { id: "a13", name: "Mei-Lin Chu",            papers: 22,  citations: 612,  h: 12, repeatRate: 0.28, avgTeam: 3.0, cluster: 4, central: false,
    affiliation: "NTU Taiwan",
    topics: ["summarization"] },
  { id: "a14", name: "Daniel Adeyemi",         papers: 18,  citations: 421,  h: 10, repeatRate: 0.22, avgTeam: 4.5, cluster: 4, central: false,
    affiliation: "University of Lagos",
    topics: ["fairness in IR"] },
  { id: "a15", name: "Sofia Marchetti",        papers: 41,  citations: 1899, h: 21, repeatRate: 0.36, avgTeam: 3.7, cluster: 1, central: false,
    affiliation: "University of Padua",
    topics: ["test collections", "reproducibility"] },
  { id: "a16", name: "Wei Zhao",               papers: 73,  citations: 4019, h: 29, repeatRate: 0.59, avgTeam: 4.4, cluster: 2, central: false,
    affiliation: "Tsinghua University",
    topics: ["pre-training", "long-context"] },
  { id: "a17", name: "Olamide Bankole",        papers: 12,  citations: 188,  h:  6, repeatRate: 0.18, avgTeam: 5.1, cluster: 5, central: false,
    affiliation: "Covenant University",
    topics: ["NER", "African languages"] },
  { id: "a18", name: "Henrik Lindqvist",       papers: 35,  citations: 1502, h: 19, repeatRate: 0.42, avgTeam: 3.6, cluster: 3, central: false,
    affiliation: "KTH Stockholm",
    topics: ["recommender systems"] },
];

// Edges = co-authorship; weight = # joint papers.
// Hub-and-spoke from a01, dense within clusters, sparser bridges between.
const EDGES = [
  // a01's strong ties (cluster 1 IR)
  { s: "a01", t: "a02", w: 24 }, { s: "a01", t: "a03", w: 31 }, { s: "a01", t: "a04", w: 12 },
  { s: "a01", t: "a05", w:  6 }, { s: "a01", t: "a15", w:  9 },
  // a01's NLP collaborations (cluster 2)
  { s: "a01", t: "a06", w: 11 }, { s: "a01", t: "a07", w: 15 }, { s: "a01", t: "a16", w:  8 },
  // bridges to HCI
  { s: "a01", t: "a10", w:  7 }, { s: "a01", t: "a11", w:  4 },
  // weak ties
  { s: "a01", t: "a12", w:  2 }, { s: "a01", t: "a13", w:  3 },

  // Within cluster 1
  { s: "a02", t: "a03", w: 18 }, { s: "a02", t: "a04", w:  9 }, { s: "a02", t: "a15", w: 11 },
  { s: "a03", t: "a04", w:  6 }, { s: "a03", t: "a15", w: 14 }, { s: "a04", t: "a05", w:  4 },
  { s: "a05", t: "a15", w:  3 },

  // Within cluster 2
  { s: "a06", t: "a07", w: 12 }, { s: "a06", t: "a08", w:  7 }, { s: "a06", t: "a09", w: 11 },
  { s: "a07", t: "a08", w:  9 }, { s: "a07", t: "a16", w: 13 }, { s: "a08", t: "a16", w:  6 },
  { s: "a09", t: "a17", w:  5 },

  // Within cluster 3
  { s: "a10", t: "a11", w: 14 }, { s: "a10", t: "a18", w:  8 }, { s: "a11", t: "a18", w:  4 },

  // Cross-cluster bridges (sparser)
  { s: "a02", t: "a07", w:  3 }, { s: "a03", t: "a10", w:  4 },
  { s: "a06", t: "a09", w:  6 }, { s: "a07", t: "a13", w:  2 },
  { s: "a04", t: "a10", w:  3 }, { s: "a16", t: "a12", w:  2 },
  { s: "a15", t: "a18", w:  2 }, { s: "a14", t: "a09", w:  3 },
  { s: "a12", t: "a13", w:  2 }, { s: "a14", t: "a17", w:  4 },
];

// Cluster labels (human-readable, derived from topics)
const CLUSTERS = [
  { id: 0, label: "Central",                  count: 1 },
  { id: 1, label: "Information retrieval",    count: 6 },
  { id: 2, label: "Language models / NLP",    count: 5 },
  { id: 3, label: "Search UX & HCI",          count: 3 },
  { id: 4, label: "Adjacent",                 count: 2 },
  { id: 5, label: "Extended",                 count: 1 },
];

// Recent papers from a01, for the readout
const RECENT_PAPERS = [
  { title: "Calibration of dense retrievers under distribution shift", venue: "SIGIR",  year: 2025, cites: 47, authors: ["M. Aritz Bilbao","Helena Vasiliev","Tomás Gallego"] },
  { title: "On the limits of test-collection reproducibility",          venue: "TOIS",   year: 2025, cites: 31, authors: ["Tomás Gallego","Sofia Marchetti","M. Aritz Bilbao"] },
  { title: "Cross-lingual ranking without parallel supervision",        venue: "ACL",    year: 2024, cites:128, authors: ["M. Aritz Bilbao","Chiamaka Okeke","Pieter van der Vaart"] },
  { title: "User-perceived relevance vs. NDCG: a 12-month diary study", venue: "CHI",    year: 2024, cites: 64, authors: ["Sigrid Petersen","M. Aritz Bilbao"] },
  { title: "What BERT learns about query intent",                       venue: "EMNLP",  year: 2023, cites:213, authors: ["Helena Vasiliev","M. Aritz Bilbao"] },
  { title: "Long-context retrieval: where current benchmarks fail",     venue: "NeurIPS",year: 2023, cites: 89, authors: ["M. Aritz Bilbao","Wei Zhao"] },
];

// Search dropdown sample (just author shortlist)
const SEARCH_SAMPLE = AUTHORS.slice(0, 12).map(a => ({
  id: a.id, name: a.name, affiliation: a.affiliation,
  papers: a.papers, citations: a.citations
}));

window.ANE_DATA = { AUTHORS, EDGES, CLUSTERS, RECENT_PAPERS, SEARCH_SAMPLE };
