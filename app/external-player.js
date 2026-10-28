/* iOS 상세 화면의 선택적 외부 재생. 기본 웹 재생 카드에는 손대지 않는다. */
(function (root, factory) {
  var player = factory();
  if (typeof module === "object" && module.exports) module.exports = player;
  if (root) {
    root.TVChakExternalPlayer = player;
    if (player.isEligible(root)) {
      if (root.document.readyState === "loading") {
        root.document.addEventListener("DOMContentLoaded", function () { player.init(root); });
      } else {
        player.init(root);
      }
    }
  }
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  var instances = [];

  function isEligible(root) {
    if (!root || !root.document || (root.TVCHAK_WEB && root.TVCHAK_WEB.mode === "tv")) return false;
    var nav = root.navigator || {};
    var ua = nav.userAgent || "";
    return /iPhone|iPod|iPad/i.test(ua) || (/Macintosh/i.test(ua) && nav.maxTouchPoints > 1);
  }

  // 절대 HTTP(S) 프록시 주소만 외부 앱으로 넘긴다. 인증 정보가 포함된 주소는 거부.
  function toNPlayerUrl(url) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url) || url !== url.trim()) return null;
    try {
      var parsed = new URL(url);
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
          !parsed.hostname || parsed.username || parsed.password) return null;
      return "nplayer-" + parsed.href;
    } catch (_) {
      return null;
    }
  }

  function fallbackCopy(text, doc) {
    if (!doc || !doc.body || typeof doc.execCommand !== "function") return false;
    // showModal 중 dialog 밖 body 자식은 inert이므로 열린 dialog 내부에서 선택한다.
    var parent = typeof doc.querySelector === "function" &&
      doc.querySelector(".external-player-dialog[open] .external-player-panel") || doc.body;
    var input = doc.createElement("textarea");
    input.value = text;
    input.readOnly = true;
    input.setAttribute("aria-label", "복사할 재생 주소");
    input.style.position = "fixed";
    input.style.left = "-9999px";
    var previous = doc.activeElement;
    parent.appendChild(input);
    try {
      input.focus();
      input.select();
      return !!doc.execCommand("copy");
    } catch (_) {
      return false;
    } finally {
      parent.removeChild(input);
      if (previous && typeof previous.focus === "function") previous.focus();
    }
  }

  // HTTP LAN에서는 execCommand를 탭 핸들러 안에서 바로 실행한다.
  function copyText(text, root) {
    var nav = root.navigator || {};
    if (root.location && root.location.protocol === "https:" &&
        nav.clipboard && typeof nav.clipboard.writeText === "function") {
      try {
        return Promise.resolve(nav.clipboard.writeText(text)).then(function () {
          return true;
        }, function () {
          return fallbackCopy(text, root.document);
        });
      } catch (_) {
        return Promise.resolve(fallbackCopy(text, root.document));
      }
    }
    return Promise.resolve(fallbackCopy(text, root.document));
  }

  // 비동기 추출/선택 경쟁은 이 세션에서 통제한다. core가 제공한 회차 이름과 순서만 사용.
  function createSession(api, onChange) {
    var token = 0;
    var openId = 0;
    var state = { phase: "closed", intent: "nplayer", detailUrl: "", title: "",
      episodes: [], selected: "", ready: null, message: "" };

    function view() {
      return { phase: state.phase, intent: state.intent, detailUrl: state.detailUrl,
        title: state.title, episodes: state.episodes.slice(), selected: state.selected,
        ready: state.ready, message: state.message, token: token, openId: openId };
    }
    function emit() { if (onChange) onChange(view()); }
    function details() {
      try { return api.getExternalEpisodes(); } catch (_) { return null; }
    }
    function validDetail(playUrl) {
      var current = details();
      if (!current || current.detailUrl !== state.detailUrl || !Array.isArray(current.episodes)) return false;
      if (!playUrl) return true;
      return current.episodes.some(function (episode) { return episode.play_url === playUrl; });
    }
    function close() {
      if (state.phase === "closed") return;
      token++;
      state.phase = "closed";
      state.ready = null;
      state.selected = "";
      emit();
    }
    function sync() {
      if (state.phase === "closed" || state.phase === "unavailable") return state.phase !== "closed";
      if (validDetail(state.selected)) return true;
      close();
      return false;
    }
    function open(intent) {
      token++;
      openId++;
      var current = details();
      state.intent = intent === "copy" ? "copy" : "nplayer";
      state.detailUrl = current && current.detailUrl || "";
      state.title = current && current.title || "";
      state.episodes = current && Array.isArray(current.episodes) ? current.episodes.map(function (episode) {
        return { name: episode.name || "", episode: episode.episode, play_url: episode.play_url };
      }) : [];
      state.selected = "";
      state.ready = null;
      state.phase = current && current.detailUrl && state.episodes.length ? "choose" : "unavailable";
      state.message = state.phase === "choose" ? "원본 회차를 선택해 주세요." :
        "상세 정보를 불러온 뒤 다시 시도해 주세요.";
      emit();
      return state.phase === "choose";
    }
    function select(playUrl) {
      if (state.phase !== "choose" && state.phase !== "preparing" &&
          state.phase !== "ready" && state.phase !== "error") return Promise.resolve(false);
      if (!sync()) return Promise.resolve(false);
      var selected = state.episodes.filter(function (episode) {
        return episode.play_url === playUrl && typeof playUrl === "string" && !!playUrl;
      })[0];
      if (!selected || !validDetail(playUrl)) return Promise.resolve(false);
      token++;
      var request = token;
      var detailUrl = state.detailUrl;
      state.phase = "preparing";
      state.selected = playUrl;
      state.ready = null;
      state.message = "재생 주소를 준비하고 있습니다…";
      emit();
      var pending;
      try { pending = api.prepareExternalPlayback(playUrl); }
      catch (error) { pending = Promise.reject(error); }
      return Promise.resolve(pending).then(function (result) {
        if (token !== request || state.phase !== "preparing") return false;
        if (!validDetail(playUrl)) { close(); return false; }
        var href = result && toNPlayerUrl(result.url);
        if (!href || result.detailUrl !== detailUrl || !result.episode ||
            result.episode.play_url !== playUrl) {
          state.phase = "error";
          state.message = "올바른 재생 주소를 받지 못했습니다. 다시 선택해 주세요.";
          emit();
          return false;
        }
        state.ready = { url: result.url, href: href, detailUrl: detailUrl, episode: result.episode };
        state.phase = "ready";
        state.message = "준비되었습니다. 아래에서 nPlayer로 열기 또는 주소 복사를 직접 누르세요.";
        emit();
        return true;
      }, function () {
        if (token !== request || state.phase !== "preparing") return false;
        if (!validDetail(playUrl)) { close(); return false; }
        state.phase = "error";
        state.message = "주소를 준비하지 못했습니다. 회차를 다시 선택해 주세요.";
        emit();
        return false;
      });
    }
    function recordOpen() {
      if (state.phase !== "ready" || !state.ready || !sync()) return false;
      try { return !!api.recordExternalPlayback(state.selected, state.detailUrl); }
      catch (_) { return false; }
    }
    return { getState: view, open: open, select: select, close: close,
      sync: sync, recordOpen: recordOpen };
  }

  function init(root) {
    if (!isEligible(root)) return null;
    var i;
    for (i = 0; i < instances.length; i++) {
      if (instances[i].root === root) return instances[i].session;
    }
    var doc = root.document;
    if (doc.readyState === "loading") {
      doc.addEventListener("DOMContentLoaded", function () { init(root); });
      return null;
    }
    var historyBtn = doc.getElementById("history-btn");
    var screen = doc.getElementById("screen-detail");
    if (!historyBtn || !historyBtn.parentElement || !screen) return null;
    var row = historyBtn.parentElement;
    var toolbar = doc.createElement("div");
    toolbar.className = "external-player-toolbar";
    var openButton = doc.createElement("button");
    openButton.type = "button";
    openButton.className = "external-player-toolbar-button";
    openButton.textContent = "nPlayer로 열기";
    var copyButton = doc.createElement("button");
    copyButton.type = "button";
    copyButton.className = "external-player-toolbar-button";
    copyButton.textContent = "주소 복사";
    toolbar.appendChild(openButton);
    toolbar.appendChild(copyButton);
    row.parentNode.insertBefore(toolbar, row.nextSibling);

    var nativeDialog = typeof doc.createElement("dialog").showModal === "function";
    var dialog = doc.createElement(nativeDialog ? "dialog" : "div");
    dialog.className = nativeDialog ? "external-player-dialog" : "external-player-fallback";
    if (!nativeDialog) dialog.hidden = true;
    dialog.setAttribute("aria-label", "외부 재생 회차 선택");
    if (!nativeDialog) {
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
    }
    var panel = doc.createElement("div");
    panel.className = "external-player-panel";
    var heading = doc.createElement("h3");
    heading.className = "external-player-heading";
    var list = doc.createElement("div");
    list.className = "external-player-episodes";
    var status = doc.createElement("p");
    status.className = "external-player-status";
    status.setAttribute("role", "status");
    var actions = doc.createElement("div");
    actions.className = "external-player-actions";
    var link = doc.createElement("a");
    link.className = "external-player-action external-player-open";
    link.textContent = "nPlayer로 열기";
    var copyReady = doc.createElement("button");
    copyReady.type = "button";
    copyReady.className = "external-player-action";
    copyReady.textContent = "주소 복사";
    actions.appendChild(link);
    actions.appendChild(copyReady);
    var manual = doc.createElement("textarea");
    manual.className = "external-player-manual";
    manual.readOnly = true;
    manual.setAttribute("aria-label", "수동 복사할 재생 주소");
    manual.hidden = true;
    var note = doc.createElement("p");
    note.className = "external-player-note";
    note.textContent = "nPlayer 설치 및 NAS 접근 필요 · 외부 재생 위치는 자동 동기화되지 않습니다.";
    var cancel = doc.createElement("button");
    cancel.type = "button";
    cancel.className = "external-player-cancel";
    cancel.textContent = "닫기";
    panel.appendChild(heading);
    panel.appendChild(list);
    panel.appendChild(status);
    panel.appendChild(actions);
    panel.appendChild(manual);
    panel.appendChild(note);
    panel.appendChild(cancel);
    dialog.appendChild(panel);
    doc.body.appendChild(dialog);

    var previousFocus = null;
    var requestedFocus = null;
    var previousOverflow = "";
    var previousScroll = 0;
    var detailScroll = 0;
    var renderedOpenId = -1;
    var copyId = 0;
    function api() { return root.TVChakAPI || {}; }
    var session = createSession({
      getExternalEpisodes: function () {
        return typeof api().getExternalEpisodes === "function" ? api().getExternalEpisodes() : null;
      },
      prepareExternalPlayback: function (playUrl) {
        return api().prepareExternalPlayback(playUrl);
      },
      recordExternalPlayback: function (playUrl, detailUrl) {
        return api().recordExternalPlayback(playUrl, detailUrl);
      }
    }, render);
    instances.push({ root: root, session: session });

    function fitNames() {
      if (typeof api().fitEpisodeNames === "function") api().fitEpisodeNames();
    }
    function showDialog() {
      if ((nativeDialog && dialog.open) || (!nativeDialog && !dialog.hidden)) return;
      previousFocus = requestedFocus || doc.activeElement;
      requestedFocus = null;
      previousOverflow = doc.body.style.overflow;
      previousScroll = root.scrollY || root.pageYOffset || 0;
      var detailRight = screen.querySelector(".detail-right");
      detailScroll = detailRight ? detailRight.scrollTop : 0;
      doc.body.style.overflow = "hidden";
      if (nativeDialog) dialog.showModal();
      else dialog.hidden = false;
      cancel.focus();
      fitNames();
    }
    function hideDialog() {
      if ((nativeDialog && !dialog.open) || (!nativeDialog && dialog.hidden)) return;
      if (nativeDialog) dialog.close();
      else dialog.hidden = true;
      doc.body.style.overflow = previousOverflow;
      var detailRight = screen.querySelector(".detail-right");
      if (detailRight) detailRight.scrollTop = detailScroll;
      if (typeof root.scrollTo === "function" && (root.scrollY || root.pageYOffset || 0) !== previousScroll) {
        root.scrollTo(0, previousScroll);
      }
      if (previousFocus && typeof previousFocus.focus === "function") previousFocus.focus();
    }
    function renderEpisodes(state) {
      if (renderedOpenId === state.openId) return;
      renderedOpenId = state.openId;
      while (list.firstChild) list.removeChild(list.firstChild);
      state.episodes.forEach(function (episode) {
        var button = doc.createElement("button");
        button.type = "button";
        button.className = "external-player-episode";
        var name = doc.createElement("span");
        name.className = "external-episode-name";
        name.textContent = episode.name;
        button.appendChild(name);
        button.addEventListener("click", function () { session.select(episode.play_url); });
        list.appendChild(button);
      });
      fitNames();
    }
    function render(state) {
      if (state.phase === "closed") { hideDialog(); return; }
      heading.textContent = state.intent === "copy" ? "주소 복사 · 원본 회차 선택" : "nPlayer · 원본 회차 선택";
      renderEpisodes(state);
      var buttons = list.querySelectorAll(".external-player-episode");
      for (var j = 0; j < buttons.length; j++) {
        buttons[j].setAttribute("aria-pressed", state.episodes[j].play_url === state.selected ? "true" : "false");
      }
      status.textContent = state.message;
      status.setAttribute("data-state", state.phase);
      var ready = state.phase === "ready" && state.ready;
      actions.hidden = !ready;
      if (ready) link.href = state.ready.href;
      else link.removeAttribute("href");
      manual.hidden = true;
      manual.value = "";
      showDialog();
    }
    function enter(intent, event) {
      event.stopPropagation();
      requestedFocus = event.currentTarget;
      session.open(intent);
    }
    openButton.addEventListener("click", function (event) { enter("nplayer", event); });
    copyButton.addEventListener("click", function (event) { enter("copy", event); });
    // base의 document keydown이 기존 회차 카드를 대신 재생하지 않도록 막는다.
    toolbar.addEventListener("keydown", function (event) { event.stopPropagation(); });
    dialog.addEventListener("keydown", function (event) {
      event.stopPropagation();
      if (event.key === "Escape" || event.keyCode === 27) {
        event.preventDefault();
        session.close();
      }
    });
    dialog.addEventListener("click", function (event) {
      event.stopPropagation();
      if (event.target !== dialog) return;
      if (!nativeDialog) { session.close(); return; }
      var bounds = panel.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right ||
          event.clientY < bounds.top || event.clientY > bounds.bottom) session.close();
    });
    if (nativeDialog) dialog.addEventListener("cancel", function (event) {
      event.preventDefault();
      event.stopPropagation();
      session.close();
    });
    cancel.addEventListener("click", function () { session.close(); });
    link.addEventListener("click", function (event) {
      if (!session.recordOpen()) {
        event.preventDefault();
        return;
      }
      // 기본 href 이동은 이 실제 사용자 탭 뒤에 브라우저가 직접 처리한다.
      var media = doc.querySelectorAll("audio, video");
      for (var j = 0; j < media.length; j++) {
        try { media[j].pause(); } catch (_) {}
      }
      status.textContent = "nPlayer가 열리지 않으면 주소 복사로 재생 주소를 이용해 주세요.";
    });
    copyReady.addEventListener("click", function () {
      if (!session.sync()) return;
      var ready = session.getState();
      if (ready.phase !== "ready" || !ready.ready) return;
      var id = ++copyId;
      // 추출 Promise 완료 시점이 아닌 명시적 탭 시점에 복사를 시작한다.
      copyText(ready.ready.url, root).then(function (copied) {
        var current = session.getState();
        if (id !== copyId || current.token !== ready.token || current.phase !== "ready") return;
        if (copied) {
          status.textContent = "주소를 복사했습니다. nPlayer가 설치되지 않았다면 직접 붙여넣어 주세요.";
        } else {
          status.textContent = "자동 복사에 실패했습니다. 아래 주소를 길게 누르거나 선택해서 수동 복사해 주세요.";
          manual.hidden = false;
          manual.value = ready.ready.url;
          manual.focus();
          manual.select();
        }
      });
    });
    if (root.MutationObserver) {
      var observer = new root.MutationObserver(function () {
        if (session.getState().phase === "closed") return;
        if (screen.classList.contains("hidden")) session.close();
        else session.sync();
      });
      observer.observe(screen, { attributes: true, attributeFilter: ["class"] });
      var title = doc.getElementById("detail-title");
      if (title) observer.observe(title, { childList: true, characterData: true, subtree: true });
    }
    return session;
  }

  return { isEligible: isEligible, toNPlayerUrl: toNPlayerUrl,
    copyText: copyText, createSession: createSession, init: init };
});
