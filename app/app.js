/* TVChak Tizen client (TizenBrew application module)
 *
 * NAS의 TVChak 프록시 서버(:7777)에 붙어서 검색/메인/상세/스트림 URL을 받아 재생.
 * Referer / CORS 같은 까다로운 부분은 전부 NAS가 처리한다.
 */

(function () {
  "use strict";

  // ---------- TizenBrew TVInputDevice ----------
  function registerKeys() {
    try {
      if (typeof tizen !== "undefined" && tizen.tvinputdevice) {
        var keys = [
          "MediaPlayPause", "MediaPlay", "MediaPause",
          "MediaStop", "MediaFastForward", "MediaRewind",
          "ColorF0Red", "ColorF1Green", "ColorF2Yellow", "ColorF3Blue",
          "0","1","2","3","4","5","6","7","8","9"
        ];
        keys.forEach(function (k) {
          try { tizen.tvinputdevice.registerKey(k); } catch (_) {}
        });
      }
    } catch (e) {
      console.warn("키 등록 실패", e);
    }
  }

  // ---------- 로컬 스토리지 헬퍼 ----------
  var STORE = {
    get: function (k, def) {
      try {
        var v = localStorage.getItem(k);
        return v == null ? def : JSON.parse(v);
      } catch (e) { return def; }
    },
    set: function (k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
    },
  };
  var KEYS = {
    NAS: "tvchak.nasUrl",
    HISTORY: "tvchak.history",
    FAVORITES: "tvchak.favorites",
    FIT_MODE: "tvchak.fitMode",
  };

  var FIT_MODES = ["contain", "cover", "fill", "none"];
  var FIT_NAMES = {
    contain: "맞춤(기본)",
    cover: "꽉 채움(잘림)",
    fill: "왜곡 채움",
    none: "원본 크기"
  };

  function nasUrl() { return STORE.get(KEYS.NAS, ""); }

  // ---------- 토스트 ----------
  var toastEl = document.getElementById("toast");
  var toastTimer = null;
  function toast(msg, kind) {
    toastEl.textContent = msg;
    toastEl.className = "toast " + (kind || "");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.add("hidden");
    }, 2500);
  }

  // ---------- 화면 전환 ----------
  var screens = {
    settings: document.getElementById("screen-settings"),
    home: document.getElementById("screen-home"),
    detail: document.getElementById("screen-detail"),
    player: document.getElementById("screen-player"),
  };
  var currentScreen = null;
  var screenStack = [];

  function show(name, push) {
    Object.keys(screens).forEach(function (k) { screens[k].classList.add("hidden"); });
    screens[name].classList.remove("hidden");
    if (push !== false && currentScreen && currentScreen !== name) {
      screenStack.push(currentScreen);
    }
    currentScreen = name;
    onScreenEnter(name);
  }

  function goBack() {
    if (currentScreen === "player") { stopPlayback(); }
    var prev = screenStack.pop();
    if (!prev) {
      // 홈이 아니면 홈으로
      if (currentScreen !== "home") { show("home", false); return; }
      // 그 외엔 그대로
      return;
    }
    show(prev, false);
  }

  // ---------- 포커스 매니저 ----------
  // 화면별로 focusable 요소들을 그리드 좌표로 관리.
  var focus = {
    items: [],      // [{el, row, col}]
    rowMap: {},     // row → cols
    current: null,
  };

  function isEffectivelyHidden(el) {
    var node = el;
    while (node && node !== document) {
      if (node.classList && node.classList.contains("hidden")) return true;
      if (node.style && node.style.display === "none") return true;
      node = node.parentElement;
    }
    // offsetParent 가 null이면 화면에서 렌더 안됨 (display:none 부모 등)
    if (el.offsetParent === null && el.tagName !== "BODY") return true;
    return false;
  }

  function rebuildFocus(container) {
    focus.items = [];
    focus.rowMap = {};
    var nodes = container.querySelectorAll(".focusable");
    nodes.forEach(function (el) {
      if (isEffectivelyHidden(el)) return;
      var row = parseInt(el.dataset.row || "0", 10);
      var col = parseInt(el.dataset.col || "0", 10);
      focus.items.push({ el: el, row: row, col: col });
      (focus.rowMap[row] = focus.rowMap[row] || []).push(col);
    });
    // 기본 포커스 — 이미 포커스된 게 여전히 유효하면 유지
    if (focus.current && focus.items.some(function (i) { return i.el === focus.current; })) {
      return;
    }
    var first = focus.items[0];
    if (first) setFocus(first.el);
    else focus.current = null;
  }

  function setFocus(el) {
    if (focus.current) focus.current.classList.remove("focused");
    focus.current = el;
    if (el) {
      el.classList.add("focused");
      if (el.scrollIntoView) {
        // 카드면 가운데로 끌어와 잘리지 않게, 작은 요소(탭 등)는 nearest로
        var block = el.classList.contains("card") ? "center" : "nearest";
        el.scrollIntoView({ block: block, inline: "nearest" });
      }
      // 거의 끝에 도달하면 다음 페이지 자동 로드
      maybeAutoLoadMore();
    }
  }

  function maybeAutoLoadMore() {
    if (listState.mode !== "cat" || !listState.hasMore || listState.loading) return;
    var content = document.querySelector("#screen-home .content");
    if (!content) return;
    var remaining = content.scrollHeight - (content.scrollTop + content.clientHeight);
    if (remaining < LOAD_MORE_THRESHOLD_PX) loadCategoryMore();
  }

  function move(dx, dy) {
    if (!focus.current) return;
    var cur = focus.items.find(function (i) { return i.el === focus.current; });
    if (!cur) return;
    var candidates = focus.items.filter(function (i) {
      if (dx) return i.row === cur.row && (dx > 0 ? i.col > cur.col : i.col < cur.col);
      if (dy) return (dy > 0 ? i.row > cur.row : i.row < cur.row);
      return false;
    });
    if (!candidates.length) return;
    candidates.sort(function (a, b) {
      var da = Math.abs(a.row - cur.row) * 100 + Math.abs(a.col - cur.col);
      var db = Math.abs(b.row - cur.row) * 100 + Math.abs(b.col - cur.col);
      return da - db;
    });
    setFocus(candidates[0].el);
  }

  // ---------- API 호출 ----------
  function apiGet(path) {
    var base = nasUrl();
    if (!base) return Promise.reject(new Error("NAS 주소가 설정되지 않았습니다."));
    return fetch(base.replace(/\/$/, "") + path)
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || ("HTTP " + r.status)); });
        return r.json();
      });
  }

  // ---------- 텍스트 입력 (Tizen native IME) ----------
  // 진짜 <input> 요소를 쓰므로 포커스 시 Tizen OSD 키보드가 자동으로 뜬다.
  function inputValue(elId) {
    return (document.getElementById(elId).value || "").trim();
  }
  function inputSet(elId, v) {
    document.getElementById(elId).value = v || "";
  }
  function inputFocus(elId) {
    var el = document.getElementById(elId);
    el.focus();
    try { el.select(); } catch (_) {}
  }
  function inputIsFocused() {
    var a = document.activeElement;
    return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA");
  }

  // ---------- 설정 화면 ----------
  function renderSettings() {
    var nasInput = document.getElementById("nas-input");
    nasInput.value = nasUrl() || "http://192.168.1.230:7777";
    nasInput.dataset.row = "0"; nasInput.dataset.col = "0";

    var actions = document.querySelectorAll("#screen-settings .settings-actions .focusable");
    actions[0].dataset.row = "1"; actions[0].dataset.col = "0";
    actions[1].dataset.row = "1"; actions[1].dataset.col = "1";

    document.getElementById("settings-status").textContent = "";
    focus.current = null;
    rebuildFocus(screens.settings);
  }

  function onSettingsKey(ch, isAction) {
    if (isAction === "backspace") { inputBackspace("nas-input"); return; }
    if (isAction === "punct") { inputAppend("nas-input", ":"); return; }
    if (isAction === "slash") { inputAppend("nas-input", "/"); return; }
    if (isAction === "clear") { inputClear("nas-input"); return; }
    if (ch) { inputAppend("nas-input", ch); }
  }

  function saveNasAndContinue() {
    var v = inputValue("nas-input").trim();
    if (!v) { toast("주소를 입력하세요", "danger"); return; }
    if (!/^https?:\/\//.test(v)) v = "http://" + v;
    STORE.set(KEYS.NAS, v);
    document.getElementById("settings-status").textContent = "확인 중...";
    apiGet("/healthz").then(function (j) {
      toast("NAS 연결 OK · " + (j.seed_domain || ""), "ok");
      enterHome();
    }).catch(function (e) {
      toast("연결 실패: " + e.message, "danger");
      document.getElementById("settings-status").textContent = "연결 실패: " + e.message;
    });
  }

  function refreshSeedDomain() {
    document.getElementById("settings-status").textContent = "도메인 자동 탐색 중...";
    fetch(nasUrl().replace(/\/$/, "") + "/api/domain/refresh", { method: "POST",
      headers: { "Accept": "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.error) throw new Error(j.error);
        toast("새 도메인: " + j.seed_domain, "ok");
        document.getElementById("settings-status").textContent = "새 도메인: " + j.seed_domain;
      })
      .catch(function (e) {
        toast("실패: " + e.message, "danger");
        document.getElementById("settings-status").textContent = "실패: " + e.message;
      });
  }

  // ---------- 홈 ----------
  // 기본 탭 = 이어보기 (메인 카테고리에 가끔 선정적 썸네일이 섞여서)
  var homeState = { tab: "recent", category: "1" };
  var pendingClearAt = 0;  // 노란색 키 두 번으로 전체 삭제 확정용

  // 무한 로드 상태 (카테고리 탭 전용)
  var listState = {
    mode: null,    // "cat" | null
    cat: null,
    page: 1,
    hasMore: false,
    loading: false,
    itemCount: 0,
  };
  var LOAD_MORE_THRESHOLD_PX = 600;  // 그리드 끝에서 이만큼 남으면 다음 페이지

  function enterHome() {
    show("home", false);
    selectTab(homeState.tab);
  }

  function selectTab(name) {
    homeState.tab = name;
    document.querySelectorAll("#tabs .tab").forEach(function (t) {
      t.classList.toggle("active", t.dataset.tab === name);
    });
    document.getElementById("search-area").classList.toggle("hidden", name !== "search");

    if (name.indexOf("cat-") === 0) {
      homeState.category = name.split("-")[1];
      listState = { mode: "cat", cat: homeState.category, page: 1,
                    hasMore: false, loading: false, itemCount: 0 };
      loadCategoryFirst();
    } else if (name === "search") {
      renderSearchTab();
    } else if (name === "recent") {
      renderRecentTab();
    } else if (name === "fav") {
      renderFavTab();
    } else if (name === "settings") {
      show("settings");
    }
  }

  function renderGrid(items, onClickItem, opts) {
    opts = opts || {};
    var grid = document.getElementById("grid");
    grid.innerHTML = "";
    listState.itemCount = 0;
    document.getElementById("grid-status").textContent = "";

    // 탭에 row=0
    var tabs = document.querySelectorAll("#tabs .focusable");
    tabs.forEach(function (t, i) { t.dataset.row = "0"; t.dataset.col = String(i); });

    if (!items.length) {
      document.getElementById("grid-status").textContent = opts.emptyHint || "결과가 없습니다.";
      rebuildFocus(screens.home);
      return;
    }
    items.forEach(function (it) { appendCard(grid, it, onClickItem, opts); });

    if (opts.deleteHint) {
      document.getElementById("grid-status").textContent = opts.deleteHint;
    }
    rebuildFocus(screens.home);
  }

  function appendToGrid(items, onClickItem, opts) {
    opts = opts || {};
    var grid = document.getElementById("grid");
    items.forEach(function (it) { appendCard(grid, it, onClickItem, opts); });
    rebuildFocus(screens.home);  // 새 카드만 추가, 현재 포커스는 유지됨
  }

  function appendCard(grid, it, onClickItem, opts) {
    var i = listState.itemCount;
    var card = document.createElement("div");
    card.className = "card focusable";
    card.dataset.row = String(2 + Math.floor(i / 6));
    card.dataset.col = String(i % 6);
    var posterUrl = it.poster_proxy_url || it.poster || "";
    card.innerHTML =
      '<div class="card-img-wrap">' +
        (posterUrl ? '<img src="' + posterUrl + '" loading="lazy" onerror="this.style.display=\'none\'">' : '') +
      '</div>' +
      '<div class="card-title">' + escapeHtml(it.title || "") + '</div>';
    card.addEventListener("click", function () { onClickItem(it); });
    if (opts && typeof opts.onDelete === "function") {
      card._deleteHandler = function () { opts.onDelete(it); };
    }
    grid.appendChild(card);
    listState.itemCount = i + 1;
  }

  function loadCategoryFirst() {
    document.getElementById("grid-status").textContent = "불러오는 중...";
    document.getElementById("grid").innerHTML = "";
    listState.itemCount = 0;
    listState.loading = true;
    apiGet("/api/mainpage?cat=" + listState.cat + "&page=" + listState.page)
      .then(function (j) {
        listState.loading = false;
        var items = j.items || [];
        listState.hasMore = items.length >= 12;  // 한 페이지 가득 차면 더 있을 거라 가정
        renderGrid(items, openDetail);
      })
      .catch(function (e) {
        listState.loading = false;
        document.getElementById("grid-status").textContent = "실패: " + e.message;
      });
  }

  function loadCategoryMore() {
    if (listState.mode !== "cat" || !listState.hasMore || listState.loading) return;
    listState.loading = true;
    listState.page += 1;
    document.getElementById("grid-status").textContent =
      "더 불러오는 중... (페이지 " + listState.page + ")";
    apiGet("/api/mainpage?cat=" + listState.cat + "&page=" + listState.page)
      .then(function (j) {
        listState.loading = false;
        var items = j.items || [];
        if (!items.length) {
          listState.hasMore = false;
          document.getElementById("grid-status").textContent = "마지막 페이지입니다.";
          return;
        }
        if (items.length < 12) listState.hasMore = false;
        appendToGrid(items, openDetail);
        document.getElementById("grid-status").textContent =
          listState.hasMore ? "" : "마지막 페이지입니다.";
      })
      .catch(function (e) {
        listState.loading = false;
        listState.page -= 1;  // 실패 시 페이지 롤백
        document.getElementById("grid-status").textContent = "추가 로드 실패: " + e.message;
      });
  }

  function renderSearchTab() {
    var input = document.getElementById("search-input");
    input.dataset.row = "1"; input.dataset.col = "0";
    var goBtn = document.querySelector('[data-action="search-go"]');
    goBtn.dataset.row = "1"; goBtn.dataset.col = "1";
    // 그리드 초기화
    document.getElementById("grid").innerHTML = "";
    document.getElementById("grid-status").textContent = "검색어를 입력하세요.";
    rebuildFocus(screens.home);
  }

  function doSearch() {
    var q = inputValue("search-input").trim();
    if (!q) { toast("검색어를 입력하세요", "danger"); return; }
    document.getElementById("grid-status").textContent = "검색 중: " + q;
    apiGet("/api/search?q=" + encodeURIComponent(q)).then(function (j) {
      renderGrid(j.items || [], openDetail);
    }).catch(function (e) {
      document.getElementById("grid-status").textContent = "검색 실패: " + e.message;
    });
  }

  function renderRecentTab() {
    var items = STORE.get(KEYS.HISTORY, []).slice().reverse().slice(0, 60);
    var mapped = items.map(function (h) {
      return { title: h.title, url: h.detail_url, poster_proxy_url: h.poster_proxy_url, poster: h.poster };
    });
    renderGrid(mapped, function (it) {
      var hit = items.find(function (h) { return h.detail_url === it.url; });
      openDetail(it, hit);
    }, {
      emptyHint: "최근 시청한 항목이 없습니다. 다른 탭에서 컨텐츠를 골라 재생해보세요.",
      deleteHint: "빨강 키: 선택 항목 삭제 · 노랑 키 두 번: 전체 삭제",
      onDelete: function (it) {
        removeHistory(it.url);
        toast("삭제됨", "ok");
        renderRecentTab();
      }
    });
  }

  function renderFavTab() {
    var favs = STORE.get(KEYS.FAVORITES, []);
    var mapped = favs.map(function (f) {
      return { title: f.title, url: f.detail_url, poster_proxy_url: f.poster_proxy_url, poster: f.poster };
    });
    renderGrid(mapped, openDetail, {
      emptyHint: "즐겨찾기에 추가된 항목이 없습니다. 상세 화면에서 '즐겨찾기 추가'를 눌러주세요.",
      deleteHint: "빨강 키: 선택 항목 삭제 · 노랑 키 두 번: 전체 삭제",
      onDelete: function (it) {
        removeFavorite(it.url);
        toast("즐겨찾기 해제", "ok");
        renderFavTab();
      }
    });
  }

  function removeHistory(detailUrl) {
    var h = STORE.get(KEYS.HISTORY, []);
    STORE.set(KEYS.HISTORY, h.filter(function (x) { return x.detail_url !== detailUrl; }));
  }
  function removeFavorite(detailUrl) {
    var f = STORE.get(KEYS.FAVORITES, []);
    STORE.set(KEYS.FAVORITES, f.filter(function (x) { return x.detail_url !== detailUrl; }));
  }
  function clearCurrentTab() {
    if (homeState.tab === "recent") {
      STORE.set(KEYS.HISTORY, []);
      selectTab("recent");
    } else if (homeState.tab === "fav") {
      STORE.set(KEYS.FAVORITES, []);
      selectTab("fav");
    }
  }

  // ---------- 상세 ----------
  var detailState = null;

  function openDetail(item, historyHit) {
    detailState = { item: item, info: null, historyHit: historyHit || findHistory(item.url) };
    show("detail");
    document.getElementById("detail-title").textContent = item.title || "";
    document.getElementById("detail-poster").src = item.poster_proxy_url || item.poster || "";
    document.getElementById("detail-plot").textContent = "불러오는 중...";
    document.getElementById("episode-list").innerHTML = "";
    document.getElementById("detail-resume-info").textContent = "";

    apiGet("/api/detail?u=" + encodeURIComponent(item.url)).then(function (j) {
      detailState.info = j;
      document.getElementById("detail-title").textContent = j.title || item.title || "";
      document.getElementById("detail-plot").textContent = j.plot || "";
      if (j.poster_proxy_url) document.getElementById("detail-poster").src = j.poster_proxy_url;
      renderEpisodes(j.episodes || []);
      updateFavButton();
      updateResumeInfo();
    }).catch(function (e) {
      document.getElementById("detail-plot").textContent = "실패: " + e.message;
    });
  }

  function renderEpisodes(episodes) {
    var list = document.getElementById("episode-list");
    list.innerHTML = "";
    var history = STORE.get(KEYS.HISTORY, []);
    var byEpUrl = {};
    history.forEach(function (h) {
      if (h.detail_url === detailState.item.url && h.episodes) {
        Object.keys(h.episodes).forEach(function (epUrl) { byEpUrl[epUrl] = h.episodes[epUrl]; });
      }
    });

    episodes.forEach(function (ep, i) {
      var card = document.createElement("div");
      card.className = "ep-card focusable";
      card.dataset.row = String(2 + Math.floor(i / 5));
      card.dataset.col = String(i % 5);
      var watched = byEpUrl[ep.play_url];
      var pct = 0;
      if (watched && watched.duration) pct = Math.min(100, Math.round(watched.position / watched.duration * 100));
      card.innerHTML =
        '<div class="ep-num">' + ep.episode + '화</div>' +
        '<div class="ep-name">' + escapeHtml(ep.name || "") + '</div>' +
        (pct > 0 ? '<div class="ep-progress"><div class="ep-progress-bar" style="width:' + pct + '%"></div></div>' : '');
      card.addEventListener("click", function () { playEpisode(ep); });
      list.appendChild(card);
    });

    // 뒤로 버튼 / 즐겨찾기 버튼은 row=0,1로
    document.querySelector('#screen-detail [data-action="back"]').dataset.row = "0";
    document.querySelector('#screen-detail [data-action="back"]').dataset.col = "0";
    document.getElementById("fav-btn").dataset.row = "1";
    document.getElementById("fav-btn").dataset.col = "0";
    rebuildFocus(screens.detail);
  }

  function updateFavButton() {
    var favs = STORE.get(KEYS.FAVORITES, []);
    var on = favs.some(function (f) { return f.detail_url === detailState.item.url; });
    document.getElementById("fav-btn").textContent = on ? "즐겨찾기 해제" : "즐겨찾기 추가";
  }

  function toggleFavorite() {
    var favs = STORE.get(KEYS.FAVORITES, []);
    var idx = favs.findIndex(function (f) { return f.detail_url === detailState.item.url; });
    if (idx >= 0) {
      favs.splice(idx, 1);
      toast("즐겨찾기 해제");
    } else {
      favs.push({
        title: detailState.info ? detailState.info.title : detailState.item.title,
        detail_url: detailState.item.url,
        poster: detailState.info ? detailState.info.poster : detailState.item.poster,
        poster_proxy_url: detailState.info ? detailState.info.poster_proxy_url : detailState.item.poster_proxy_url,
      });
      toast("즐겨찾기 추가", "ok");
    }
    STORE.set(KEYS.FAVORITES, favs);
    updateFavButton();
  }

  function updateResumeInfo() {
    if (!detailState.historyHit) return;
    var h = detailState.historyHit;
    if (!h.lastEpisode) return;
    document.getElementById("detail-resume-info").textContent =
      "마지막: " + h.lastEpisode.name + " (" + formatTime(h.lastEpisode.position) + ")";
  }

  // ---------- 플레이어 ----------
  var player = {
    video: document.getElementById("video"),
    overlay: document.getElementById("player-overlay"),
    overlayTimer: null,
    progressBar: document.getElementById("player-progress-bar"),
    curEl: document.getElementById("player-cur"),
    durEl: document.getElementById("player-dur"),
    titleEl: document.getElementById("player-title"),
    loadingEl: document.getElementById("player-loading"),
    currentEp: null,
    saveTimer: null,
  };

  function applyFitMode() {
    var mode = STORE.get(KEYS.FIT_MODE, "contain");
    if (FIT_MODES.indexOf(mode) === -1) mode = "contain";
    player.video.className = "fit-" + mode;
    var info = document.getElementById("player-fit-info");
    if (info) info.textContent = "화면: " + FIT_NAMES[mode];
  }

  function cycleFitMode() {
    var cur = STORE.get(KEYS.FIT_MODE, "contain");
    if (FIT_MODES.indexOf(cur) === -1) cur = "contain";
    var next = FIT_MODES[(FIT_MODES.indexOf(cur) + 1) % FIT_MODES.length];
    STORE.set(KEYS.FIT_MODE, next);
    applyFitMode();
    toast("화면 맞춤: " + FIT_NAMES[next], "ok");
    showOverlayBriefly();
  }

  function playEpisode(ep) {
    show("player");
    player.titleEl.textContent =
      (detailState.info ? detailState.info.title : "") + " · " + (ep.name || "");
    player.loadingEl.classList.remove("hidden");
    player.overlay.classList.remove("hidden");
    applyFitMode();

    apiGet("/api/extract?u=" + encodeURIComponent(ep.play_url)).then(function (j) {
      if (j.error) throw new Error(j.error);
      var src = j.proxy_url;
      player.video.src = src;

      // 이어보기 위치 적용
      var history = STORE.get(KEYS.HISTORY, []);
      var hh = history.find(function (h) { return h.detail_url === detailState.item.url; });
      if (hh && hh.episodes && hh.episodes[ep.play_url]) {
        var pos = hh.episodes[ep.play_url].position;
        if (pos > 5) {
          player.video.addEventListener("loadedmetadata", function once() {
            try { player.video.currentTime = pos; } catch (e) {}
            player.video.removeEventListener("loadedmetadata", once);
          });
        }
      }

      player.currentEp = ep;
      player.video.play().catch(function (e) { console.warn("play() 실패", e); });
      schedulePersist();
    }).catch(function (e) {
      toast("스트림 추출 실패: " + e.message, "danger");
      goBack();
    });
  }

  function stopPlayback() {
    if (player.saveTimer) { clearInterval(player.saveTimer); player.saveTimer = null; }
    persistHistory();
    try { player.video.pause(); } catch (_) {}
    player.video.removeAttribute("src");
    player.video.load();
    player.currentEp = null;
  }

  function schedulePersist() {
    if (player.saveTimer) clearInterval(player.saveTimer);
    player.saveTimer = setInterval(persistHistory, 5000);
  }

  function persistHistory() {
    if (!player.currentEp || !detailState) return;
    var pos = player.video.currentTime;
    var dur = player.video.duration || 0;
    if (!isFinite(pos) || pos < 1) return;
    var history = STORE.get(KEYS.HISTORY, []);
    var idx = history.findIndex(function (h) { return h.detail_url === detailState.item.url; });
    var entry = idx >= 0 ? history[idx] : {
      detail_url: detailState.item.url,
      title: detailState.info ? detailState.info.title : detailState.item.title,
      poster: detailState.info ? detailState.info.poster : detailState.item.poster,
      poster_proxy_url: detailState.info ? detailState.info.poster_proxy_url : detailState.item.poster_proxy_url,
      episodes: {},
    };
    entry.episodes = entry.episodes || {};
    entry.episodes[player.currentEp.play_url] = {
      position: pos, duration: dur,
      name: player.currentEp.name, episode: player.currentEp.episode,
    };
    entry.lastEpisode = {
      play_url: player.currentEp.play_url,
      name: player.currentEp.name,
      position: pos,
    };
    entry.updatedAt = Date.now();
    if (idx >= 0) history[idx] = entry; else history.push(entry);
    // 최근 50개만 유지
    history.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    if (history.length > 50) history.length = 50;
    STORE.set(KEYS.HISTORY, history);
  }

  function showOverlayBriefly() {
    player.overlay.classList.remove("hidden");
    if (player.overlayTimer) clearTimeout(player.overlayTimer);
    player.overlayTimer = setTimeout(function () {
      player.overlay.classList.add("hidden");
    }, 4000);
  }

  player.video.addEventListener("timeupdate", function () {
    var cur = player.video.currentTime || 0;
    var dur = player.video.duration || 0;
    player.curEl.textContent = formatTime(cur);
    player.durEl.textContent = formatTime(dur);
    if (dur) player.progressBar.style.width = (cur / dur * 100) + "%";
    if (player.loadingEl && !player.loadingEl.classList.contains("hidden")) {
      player.loadingEl.classList.add("hidden");
    }
  });
  player.video.addEventListener("ended", function () { goBack(); });
  player.video.addEventListener("playing", function () { player.loadingEl.classList.add("hidden"); });
  player.video.addEventListener("waiting", function () { player.loadingEl.classList.remove("hidden"); });
  player.video.addEventListener("error", function () { toast("재생 오류", "danger"); });

  // ---------- 화면 전환시 ----------
  function onScreenEnter(name) {
    if (name === "settings") renderSettings();
    if (name === "home") {
      // 진입 시 시드 도메인 표시
      apiGet("/api/domain").then(function (j) {
        document.getElementById("seed-info").textContent = j.seed_domain || "";
      }).catch(function () {});
      selectTab(homeState.tab);
    }
  }

  // ---------- 클릭 / 액션 핸들러 ----------
  document.addEventListener("click", function (e) {
    var el = e.target.closest(".focusable");
    if (el) setFocus(el);
    var act = e.target.closest("[data-action]");
    if (act) handleAction(act.dataset.action);
    var tab = e.target.closest("[data-tab]");
    if (tab) selectTab(tab.dataset.tab);
  });

  function handleAction(action) {
    if (action === "save-nas") return saveNasAndContinue();
    if (action === "refresh-domain") return refreshSeedDomain();
    if (action === "back") return goBack();
    if (action === "fav-toggle") return toggleFavorite();
    if (action === "search-go") return doSearch();
  }

  function clickFocusable() {
    if (!focus.current) return;
    var el = focus.current;
    // input은 클릭 → Tizen IME가 자동으로 뜸
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      inputFocus(el.id);
      return;
    }
    el.click();
  }

  // ---------- 키 이벤트 ----------
  document.addEventListener("keydown", function (e) {
    var k = e.keyCode;
    var active = document.activeElement;
    var inInput = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");

    // input 포커스 상태에선 IME에 키를 양보. 단 일부는 우리가 처리.
    if (inInput) {
      if (k === 10009 || k === 27) {     // Return/Esc: IME 닫고 input 벗어남
        active.blur();
        e.preventDefault();
        return;
      }
      if (k === 13) {                    // Enter: 제출
        active.blur();
        if (currentScreen === "settings") saveNasAndContinue();
        else if (currentScreen === "home" && homeState.tab === "search") doSearch();
        e.preventDefault();
        return;
      }
      if (k === 38 || k === 40) {        // 위/아래: input 떠나서 다음 포커스로
        active.blur();
        onArrow(0, k === 40 ? 1 : -1);
        e.preventDefault();
        return;
      }
      // 좌우/글자/백스페이스 등은 native에 양보 (preventDefault X)
      return;
    }

    // Tizen 리모컨 키코드
    // 37/38/39/40: 방향, 13: Enter, 10009/8: Back, 415: Play, 19: Pause, 10252: PlayPause
    // 413: Stop, 417: FF, 412: Rewind, 403/404/405/406: Red/Green/Yellow/Blue
    if (k === 37) { onArrow(-1, 0); e.preventDefault(); return; }
    if (k === 39) { onArrow(1, 0); e.preventDefault(); return; }
    if (k === 38) { onArrow(0, -1); e.preventDefault(); return; }
    if (k === 40) { onArrow(0, 1); e.preventDefault(); return; }
    if (k === 13) { onOk(); e.preventDefault(); return; }
    if (k === 10009 || k === 8 || k === 27) { onBack(); e.preventDefault(); return; }
    if (k === 415 || k === 19 || k === 10252) { onPlayPause(); e.preventDefault(); return; }
    if (k === 413) { onStop(); e.preventDefault(); return; }
    if (k === 417) { onSeek(10); e.preventDefault(); return; }
    if (k === 412) { onSeek(-10); e.preventDefault(); return; }
    if (k === 403) { onColor("red"); e.preventDefault(); return; }
    if (k === 404) { onColor("green"); e.preventDefault(); return; }
    if (k === 405) { onColor("yellow"); e.preventDefault(); return; }
    if (k === 406) { onColor("blue"); e.preventDefault(); return; }
  });

  function onArrow(dx, dy) {
    if (currentScreen === "player") {
      if (dx) { onSeek(dx > 0 ? 10 : -10); showOverlayBriefly(); }
      else { showOverlayBriefly(); }
      return;
    }
    move(dx, dy);
  }

  function onOk() {
    if (currentScreen === "player") { onPlayPause(); return; }
    clickFocusable();
  }

  function onBack() {
    if (currentScreen === "settings" && !nasUrl()) { return; }  // 첫 진입 시 강제 머무름

    // 홈에서 카드(또는 검색 입력)에 포커스가 있으면 상단 탭으로 먼저 올라감.
    // 탭에서 한 번 더 Return을 누르면 그 때 화면 이동.
    if (currentScreen === "home" && focus.current) {
      var cur = focus.items.find(function (i) { return i.el === focus.current; });
      if (cur && cur.row > 0) {
        var activeTab = document.querySelector("#tabs .tab.active");
        if (activeTab) { setFocus(activeTab); return; }
      }
    }
    goBack();
  }

  function onPlayPause() {
    if (currentScreen !== "player") return;
    if (player.video.paused) player.video.play();
    else player.video.pause();
    showOverlayBriefly();
  }
  function onStop() { if (currentScreen === "player") goBack(); }
  function onSeek(delta) {
    if (currentScreen !== "player") return;
    try { player.video.currentTime = Math.max(0, (player.video.currentTime || 0) + delta); } catch (_) {}
    showOverlayBriefly();
  }
  function onColor(color) {
    if (currentScreen === "player") {
      if (color === "blue") cycleFitMode();
      return;
    }
    if (currentScreen === "settings") {
      if (color === "yellow") inputSet("nas-input", "");
      if (color === "green") saveNasAndContinue();
      return;
    }
    if (currentScreen === "home") {
      // 검색 탭의 입력 클리어
      if (homeState.tab === "search") {
        if (color === "yellow") { inputSet("search-input", ""); return; }
        if (color === "green") { doSearch(); return; }
      }
      // 이어보기 / 즐겨찾기에서 항목 삭제 / 전체 삭제
      if (homeState.tab === "recent" || homeState.tab === "fav") {
        if (color === "red") {
          if (focus.current && typeof focus.current._deleteHandler === "function") {
            focus.current._deleteHandler();
          } else {
            toast("삭제할 항목을 선택하세요", "danger");
          }
          return;
        }
        if (color === "yellow") {
          var now = Date.now();
          if (now - pendingClearAt < 5000) {
            clearCurrentTab();
            pendingClearAt = 0;
            toast("전체 삭제 완료", "ok");
          } else {
            pendingClearAt = now;
            toast("한 번 더 노란색 키를 누르면 전체 삭제됩니다", "danger");
          }
          return;
        }
      }
    }
  }

  // ---------- 유틸 ----------
  function escapeHtml(s) {
    return (s + "").replace(/[&<>"']/g, function (c) {
      return ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c];
    });
  }
  function formatTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return (h ? h + ":" : "") + pad(m) + ":" + pad(s);
  }
  function findHistory(detailUrl) {
    return STORE.get(KEYS.HISTORY, []).find(function (h) { return h.detail_url === detailUrl; });
  }

  // ---------- 시작 ----------
  registerKeys();
  if (nasUrl()) {
    enterHome();
  } else {
    show("settings", false);
  }
})();
