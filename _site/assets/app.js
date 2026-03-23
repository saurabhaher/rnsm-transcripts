(function() {
  "use strict";

  var config = window.__RNSM_CONFIG || {};
  var pagingConfig = config.pagination || {};
  var searchConfig = config.search || {};
  var fuseConfig = config.fuse || {};
  var DIRECTORY_DATA = window.__DIRECTORY_DATA || {};
  var ITEMS_PER_PAGE = pagingConfig.itemsPerPage || 50;
  var TITLE_RESULTS_LIMIT = pagingConfig.titleResultsLimit || 30;
  var FULL_RESULTS_LIMIT = pagingConfig.fullResultsLimit || 20;
  var MIN_SEARCH_LENGTH = pagingConfig.minSearchLength || 3;
  var SEARCH_DEBOUNCE_MS = pagingConfig.debounceMs || 140;
  var TITLE_INDEX_PATH = searchConfig.titleIndex || "search_titles.json";
  var SHARD_MANIFEST_PATH = searchConfig.shardManifest || "search_manifest.json";
  var SHARD_BASE_DIR = searchConfig.shardBaseDir || "search";

  var currentPath = [];
  var currentPage = 1;
  var searchMode = "title";
  var fuseTitleInstance = null;
  var fuseFullInstance = null;
  var titleIndexData = null;
  var fullIndexData = null;
  var fullIndexLoading = false;
  var titleIndexPromise = null;
  var fullIndexPromise = null;
  var shardManifest = null;

  var searchInput = document.getElementById("searchInput");
  var searchResults = document.getElementById("searchResults");
  var resultsList = document.getElementById("resultsList");
  var resultsCount = document.getElementById("resultsCount");
  var directoryBrowser = document.getElementById("directoryBrowser");
  var breadcrumbContent = document.getElementById("breadcrumbContent");
  var folderTabs = document.getElementById("folderTabs");
  var fileList = document.getElementById("fileList");
  var pagination = document.getElementById("pagination");
  var pageInfo = document.getElementById("pageInfo");
  var prevPageBtn = document.getElementById("prevPage");
  var nextPageBtn = document.getElementById("nextPage");
  var btnTitleSearch = document.getElementById("btnTitleSearch");
  var btnFullSearch = document.getElementById("btnFullSearch");

  if (!searchInput || !searchResults || !resultsList || !resultsCount || !directoryBrowser || !breadcrumbContent || !folderTabs || !fileList || !pagination || !pageInfo || !prevPageBtn || !nextPageBtn || !btnTitleSearch || !btnFullSearch) {
    return;
  }

  var EMPTY_FOLDER_MESSAGE = '<div class="state-message">No files in this folder.</div>';
  var SELECT_FOLDER_MESSAGE = '<div class="state-message">Select a folder above to browse files.</div>';
  var LOADING_INDEX_MESSAGE = '<div class="state-message-compact">Loading full index...</div>';
  var SEARCH_ERROR_MESSAGE = '<div class="state-message-compact error">Failed to load search index.</div>';
  var NO_MATCH_MESSAGE = '<p class="state-message-compact"><em>No matches found.</em></p>';

  function debounce(fn, delay) {
    var timer = null;
    return function() {
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function() {
        fn.apply(null, args);
      }, delay);
    };
  }

  function humanize(name) {
    return name.replace(/[-_]/g, " ");
  }

  function escapeHtml(str) {
    var d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function normalizeQuery(text) {
    return text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[-_]/g, " ");
  }

  function buildFuse(data, keys) {
    return new Fuse(data, {
      keys: keys,
      includeScore: true,
      threshold: fuseConfig.threshold || 0.3,
      ignoreLocation: typeof fuseConfig.ignoreLocation === "boolean" ? fuseConfig.ignoreLocation : true,
      minMatchCharLength: fuseConfig.minMatchCharLength || 3
    });
  }

  function getNode(path) {
    var node = DIRECTORY_DATA;
    for (var i = 0; i < path.length; i++) {
      if (node[path[i]]) {
        node = node[path[i]];
      } else {
        return null;
      }
    }
    return node;
  }

  function countFiles(node) {
    var count = 0;
    if (node.__files__) {
      count += node.__files__.length;
    }
    var keys = Object.keys(node);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] !== "__files__") {
        count += countFiles(node[keys[i]]);
      }
    }
    return count;
  }

  function navigate(path) {
    currentPath = path;
    currentPage = 1;
    render();
  }

  function render() {
    var node = getNode(currentPath);
    if (!node) {
      return;
    }

    renderBreadcrumb();
    var subfolders = Object.keys(node)
      .filter(function(k) {
        return k !== "__files__";
      })
      .sort();
    var files = node.__files__ || [];

    if (subfolders.length > 0) {
      renderFolderTabs(subfolders, node);
      fileList.innerHTML = SELECT_FOLDER_MESSAGE;
      pagination.classList.add("hidden");
    } else {
      folderTabs.innerHTML = "";
      renderFileList(files);
    }
  }

  function renderBreadcrumb() {
    var html = '<span class="breadcrumb-link" data-path="">Home</span>';
    for (var i = 0; i < currentPath.length; i++) {
      html += '<svg class="breadcrumb-separator" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>';
      var partialPath = currentPath.slice(0, i + 1).join("/");
      var isLast = i === currentPath.length - 1;
      if (isLast) {
        html += '<span class="crumb-current">' + escapeHtml(currentPath[i]) + "</span>";
      } else {
        html += '<span class="breadcrumb-link" data-path="' + escapeHtml(partialPath) + '">' + escapeHtml(currentPath[i]) + "</span>";
      }
    }
    breadcrumbContent.innerHTML = html;
  }

  function renderFolderTabs(subfolders, parentNode) {
    folderTabs.innerHTML = subfolders
      .map(function(folder) {
        var count = countFiles(parentNode[folder]);
        return '<button role="tab" class="folder-tab folder-tab--inactive" data-folder="' + escapeHtml(folder) + '">' + String.fromCodePoint(0x1f4c1) + " " + escapeHtml(folder) + ' <span class="count">(' + count + ")</span></button>";
      })
      .join("");
  }

  function renderFileList(files) {
    if (files.length === 0) {
      fileList.innerHTML = EMPTY_FOLDER_MESSAGE;
      pagination.classList.add("hidden");
      return;
    }

    var sorted = files.slice().sort(function(a, b) {
      return a.title.localeCompare(b.title);
    });
    var totalPages = Math.ceil(sorted.length / ITEMS_PER_PAGE);
    currentPage = Math.min(currentPage, totalPages);

    var start = (currentPage - 1) * ITEMS_PER_PAGE;
    var pageFiles = sorted.slice(start, start + ITEMS_PER_PAGE);
    fileList.innerHTML = pageFiles
      .map(function(fileMeta) {
        return '<a href="' + escapeHtml(fileMeta.link) + '" class="file-row"><span class="file-icon">' + String.fromCodePoint(0x1f4c4) + '</span><span class="file-name">' + escapeHtml(humanize(fileMeta.title)) + "</span></a>";
      })
      .join("");

    if (totalPages > 1) {
      pagination.classList.remove("hidden");
      pageInfo.textContent = "Page " + currentPage + " of " + totalPages + " (" + sorted.length + " files)";
      prevPageBtn.disabled = currentPage <= 1;
      nextPageBtn.disabled = currentPage >= totalPages;
    } else {
      pagination.classList.add("hidden");
    }
  }

  function setSearchMode(mode) {
    searchMode = mode;
    var titleActive = mode === "title";
    btnTitleSearch.className = "search-toggle-btn " + (titleActive ? "search-toggle-btn--active" : "search-toggle-btn--inactive");
    btnFullSearch.className = "search-toggle-btn " + (titleActive ? "search-toggle-btn--inactive" : "search-toggle-btn--active");
    btnTitleSearch.setAttribute("aria-checked", titleActive ? "true" : "false");
    btnFullSearch.setAttribute("aria-checked", titleActive ? "false" : "true");
  }

  function loadTitleIndex() {
    if (titleIndexData) {
      return Promise.resolve();
    }
    if (titleIndexPromise) {
      return titleIndexPromise;
    }

    titleIndexPromise = fetch(TITLE_INDEX_PATH, { cache: "force-cache" })
      .then(function(response) {
        return response.json();
      })
      .then(function(data) {
        titleIndexData = data;
        fuseTitleInstance = buildFuse(data, ["title_search"]);
      })
      .catch(function(error) {
        titleIndexPromise = null;
        throw error;
      });

    return titleIndexPromise;
  }

  function loadShardManifest() {
    if (shardManifest) {
      return Promise.resolve(shardManifest);
    }

    return fetch(SHARD_MANIFEST_PATH, { cache: "force-cache" })
      .then(function(response) {
        return response.json();
      })
      .then(function(manifestData) {
        shardManifest = manifestData;
        return manifestData;
      });
  }

  function resolveShardPath(shardItem) {
    if (shardItem.path) {
      return shardItem.path;
    }
    return SHARD_BASE_DIR + "/" + shardItem.file;
  }

  function loadFullIndex() {
    if (fullIndexData) {
      return Promise.resolve(fullIndexData);
    }
    if (fullIndexPromise) {
      return fullIndexPromise;
    }

    fullIndexLoading = true;
    fullIndexPromise = loadShardManifest()
      .then(function(manifestData) {
        var shards = manifestData.full_search_shards || [];
        var requests = shards.map(function(item) {
          return fetch(resolveShardPath(item), { cache: "force-cache" }).then(function(response) {
            return response.json();
          });
        });
        return Promise.all(requests);
      })
      .then(function(shardPayloads) {
        fullIndexData = [];
        for (var i = 0; i < shardPayloads.length; i++) {
          fullIndexData = fullIndexData.concat(shardPayloads[i]);
        }
        fuseFullInstance = buildFuse(fullIndexData, ["title_search", "content_normalized"]);
        fullIndexLoading = false;
        return fullIndexData;
      })
      .catch(function(error) {
        fullIndexLoading = false;
        fullIndexPromise = null;
        throw error;
      });

    return fullIndexPromise;
  }

  function displayTitleResults(results) {
    searchResults.classList.remove("hidden");
    directoryBrowser.classList.add("hidden");

    var limited = results.slice(0, TITLE_RESULTS_LIMIT);
    resultsCount.textContent = results.length + " result" + (results.length !== 1 ? "s" : "") + (results.length > TITLE_RESULTS_LIMIT ? " (showing " + TITLE_RESULTS_LIMIT + ")" : "");

    if (limited.length === 0) {
      resultsList.innerHTML = NO_MATCH_MESSAGE;
      return;
    }

    resultsList.innerHTML = limited
      .map(function(result) {
        return '<a href="' + escapeHtml(result.item.link) + '" class="result-item"><div class="result-title">' + escapeHtml(humanize(result.item.title)) + '</div><div class="result-link">' + escapeHtml(result.item.link) + "</div></a>";
      })
      .join("");
  }

  function displayFullResults(results, query) {
    searchResults.classList.remove("hidden");
    directoryBrowser.classList.add("hidden");

    var limited = results.slice(0, FULL_RESULTS_LIMIT);
    resultsCount.textContent = results.length + " result" + (results.length !== 1 ? "s" : "") + (results.length > FULL_RESULTS_LIMIT ? " (showing " + FULL_RESULTS_LIMIT + ")" : "");

    if (limited.length === 0) {
      resultsList.innerHTML = NO_MATCH_MESSAGE;
      return;
    }

    var normalizedQuery = normalizeQuery(query).toLowerCase();
    resultsList.innerHTML = limited
      .map(function(result) {
        var item = result.item;
        var snippet = "";
        if (item.content_normalized) {
          var normalizedContent = item.content_normalized.toLowerCase();
          var matchIndex = normalizedContent.indexOf(normalizedQuery);
          if (matchIndex > -1) {
            var snippetStart = Math.max(0, matchIndex - 80);
            var snippetEnd = Math.min(item.content.length, matchIndex + normalizedQuery.length + 80);
            var rawSnippet = item.content.substring(snippetStart, snippetEnd);
            var normalizedSnippet = normalizeQuery(rawSnippet).toLowerCase();
            var highlightIndex = normalizedSnippet.indexOf(normalizedQuery);
            if (highlightIndex > -1) {
              snippet = "..." + escapeHtml(rawSnippet.substring(0, highlightIndex)) + "<mark>" + escapeHtml(rawSnippet.substring(highlightIndex, highlightIndex + normalizedQuery.length)) + "</mark>" + escapeHtml(rawSnippet.substring(highlightIndex + normalizedQuery.length)) + "...";
            } else {
              snippet = "..." + escapeHtml(rawSnippet) + "...";
            }
          } else {
            snippet = escapeHtml(item.content.substring(0, 150)) + "...";
          }
        }

        return '<a href="' + escapeHtml(item.link) + '" class="result-item"><div class="result-title">' + escapeHtml(humanize(item.title)) + '</div><div class="result-link">' + escapeHtml(item.link) + "</div>" + (snippet ? '<div class="result-snippet">' + snippet + "</div>" : "") + "</a>";
      })
      .join("");
  }

  function triggerSearch() {
    var query = searchInput.value;

    if (!query || query.length < MIN_SEARCH_LENGTH) {
      searchResults.classList.add("hidden");
      directoryBrowser.classList.remove("hidden");
      return;
    }

    var normalizedQuery = normalizeQuery(query);
    if (searchMode === "title") {
      if (!fuseTitleInstance) {
        return;
      }
      displayTitleResults(fuseTitleInstance.search(normalizedQuery));
      return;
    }

    if (fuseFullInstance) {
      displayFullResults(fuseFullInstance.search(normalizedQuery), query);
      return;
    }

    if (!fullIndexLoading) {
      resultsList.innerHTML = LOADING_INDEX_MESSAGE;
    }
    searchResults.classList.remove("hidden");
    directoryBrowser.classList.add("hidden");

    loadFullIndex()
      .then(function() {
        displayFullResults(fuseFullInstance.search(normalizedQuery), query);
      })
      .catch(function() {
        resultsList.innerHTML = SEARCH_ERROR_MESSAGE;
      });
  }

  prevPageBtn.addEventListener("click", function() {
    if (currentPage > 1) {
      currentPage--;
      render();
    }
  });

  nextPageBtn.addEventListener("click", function() {
    currentPage++;
    render();
  });

  breadcrumbContent.addEventListener("click", function(event) {
    var link = event.target.closest(".breadcrumb-link");
    if (!link) {
      return;
    }
    var path = link.getAttribute("data-path");
    navigate(path ? path.split("/") : []);
  });

  folderTabs.addEventListener("click", function(event) {
    var tab = event.target.closest("[data-folder]");
    if (!tab) {
      return;
    }
    navigate(currentPath.concat([tab.getAttribute("data-folder")]));
  });

  btnTitleSearch.addEventListener("click", function() {
    if (searchMode === "title") {
      return;
    }
    setSearchMode("title");
    triggerSearch();
  });

  btnFullSearch.addEventListener("click", function() {
    if (searchMode === "full") {
      return;
    }
    setSearchMode("full");
    triggerSearch();
  });

  searchInput.addEventListener("input", debounce(triggerSearch, SEARCH_DEBOUNCE_MS));

  document.addEventListener("keydown", function(event) {
    if (event.key === "/" && document.activeElement !== searchInput) {
      event.preventDefault();
      searchInput.focus();
    }

    if (event.key === "Escape" && document.activeElement === searchInput) {
      searchInput.value = "";
      triggerSearch();
    }
  });

  loadTitleIndex().catch(function(error) {
    console.error("Error loading title index:", error);
  });

  setSearchMode("title");

  // Deep-link: if URL hash is a 4-digit year (e.g. #1989), navigate straight into that folder.
  var hashYear = window.location.hash.replace(/^#/, "");
  if (/^\d{4}$/.test(hashYear) && DIRECTORY_DATA[hashYear]) {
    navigate([hashYear]);
  } else {
    navigate([]);
  }
})();
