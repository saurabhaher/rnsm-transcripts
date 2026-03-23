window.__RNSM_CONFIG = {
  pagination: {
    itemsPerPage: 50,
    titleResultsLimit: 30,
    fullResultsLimit: 20,
    minSearchLength: 3,
    debounceMs: 140
  },
  search: {
    titleIndex: "search_titles.json",
    shardManifest: "search_manifest.json",
    shardBaseDir: "search"
  },
  fuse: {
    threshold: 0.3,
    ignoreLocation: true,
    minMatchCharLength: 3
  }
};
