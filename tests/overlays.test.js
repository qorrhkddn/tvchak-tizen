const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../app/app.js"), "utf8");

// 앱 전체를 실행하지 않고 기존 테스트와 같이 private 함수 본문만 VM에 올린다.
function load(names, context) {
  vm.createContext(context);
  for (const name of names) {
    const start = source.indexOf("  function " + name + "(");
    const end = source.indexOf("\n  }", start) + 4;
    assert.ok(start >= 0 && end > start, name);
    vm.runInContext(source.slice(start, end), context);
  }
  return context;
}

const functions = [
  "isEffectivelyHidden", "setFocus", "rebuildFocus", "_moveByVisual", "move",
  "isCookieOverlayVisible", "openCookieOverlay", "closeCookieOverlay", "triggerCookieRefresh",
  "playerOverlayEnabled", "isPlayerOverlayVisible", "hidePlayerOverlay",
  "showOverlayBriefly", "focusPlayerControls", "handleAction", "clickFocusable",
  "handleNumberKey", "onArrow", "onOk", "onBack", "onPlayPause", "onSeek",
  "onColor", "getHostState",
];

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(mode = "tv") {
  const elements = new Map(), timers = new Map(), cleared = [], requests = [];
  const media = { plays: 0, pauses: 0, stops: 0, backs: 0, swaps: 0 };
  let nextTimer = 0, ctx;

  // 포커스 가능한 버튼과 조상 hidden 여부만 구현한 작은 DOM 대역이다.
  function element(id, { hidden = false, focusable = false, action, row = 0, col = 0, left = 0, top = 0 } = {}) {
    const classes = new Set([
      ...(hidden ? ["hidden"] : []), ...(focusable ? ["focusable"] : []),
    ]);
    const el = {
      id, tagName: "BUTTON", dataset: { row: String(row), col: String(col) },
      style: {}, textContent: "", innerHTML: "", parentElement: null, children: [],
      classList: {
        add: name => classes.add(name), remove: name => classes.delete(name),
        contains: name => classes.has(name),
      },
      appendChild(child) { child.parentElement = this; this.children.push(child); return child; },
      contains(child) {
        for (let node = child; node; node = node.parentElement) if (node === this) return true;
        return false;
      },
      querySelectorAll(selector) {
        assert.equal(selector, ".focusable");
        const found = [];
        function visit(parent) {
          for (const child of parent.children) {
            if (child.classList.contains("focusable")) found.push(child);
            visit(child);
          }
        }
        visit(this);
        return found;
      },
      getBoundingClientRect: () => ({ left, top, width: 80, height: 40 }),
      scrollIntoView() {},
      click() {
        if (this.onclick) this.onclick();
        else if (this.dataset.action) ctx.handleAction(this.dataset.action);
      },
    };
    if (action) el.dataset.action = action;
    elements.set(id, el);
    return el;
  }

  const screens = {
    home: element("screen-home"), detail: element("screen-detail"),
    player: element("screen-player"),
  };
  const tab = screens.home.appendChild(element("active-tab", { focusable: true }));
  const overlay = screens.player.appendChild(element("player-overlay", { hidden: true }));
  const playerClose = overlay.appendChild(element("player-overlay-close", {
    focusable: true, action: "player-overlay-close", left: 0,
  }));
  const swap = overlay.appendChild(element("swap-src-btn", {
    focusable: true, action: "swap-src", left: 120,
  }));
  const cookie = element("cookie-refresh-overlay", { hidden: true });
  const cookieClose = cookie.appendChild(element("cr-close", {
    focusable: true, action: "cookie-overlay-close", left: 120,
  }));
  const actions = cookie.appendChild(element("cr-actions", { hidden: true }));
  const confirm = actions.appendChild(element("cr-confirm", { focusable: true, left: 0 }));
  for (const id of ["cr-icon", "cr-title", "cr-detail"]) cookie.appendChild(element(id));

  const video = {
    currentTime: 60, duration: 120, paused: false,
    play() { media.plays++; this.paused = false; },
    pause() { media.pauses++; this.paused = true; },
  };
  const document = {
    activeElement: null,
    getElementById: id => elements.get(id) || null,
    querySelector: selector => selector === "#tabs .tab.active" ? tab : null,
  };
  ctx = load(functions, {
    document, screens, currentScreen: "player", focus: { current: null, items: [], rowMap: {} },
    homeState: { tab: "recent" }, cacheMenuId: null, closeCacheMenu: () => false,
    player: { video, overlay, overlayTimer: null, controlsFocused: false, overlayDismissed: false },
    window: { TVCHAK_WEB: { mode }, getComputedStyle: el => ({
      display: el.style.display || (el.classList.contains("hidden") ? "none" : "block"),
    }) },
    _cookieOverlayDismissed: false, _autoRefreshInFlight: false, _cookieOverlayReturnFocus: null,
    nasUrl: () => "http://nas.test:7777", maybeAutoLoadMore: () => {},
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => { cleared.push(id); timers.delete(id); },
    fetch: (url, opts) => {
      const request = deferred();
      request.url = url;
      request.opts = opts;
      request.aborted = false;
      if (opts.signal) opts.signal.addEventListener("abort", () => { request.aborted = true; });
      requests.push(request);
      return request.promise;
    },
    location: { reload: () => {} },
    stopPlayback: () => media.stops++,
    goBack: () => { media.backs++; ctx.currentScreen = "detail"; },
    swapPlayerSrc: () => media.swaps++,
    toast: () => {},
  });
  return { ctx, elements, screens, tab, overlay, playerClose, swap, cookie, cookieClose,
    actions, confirm, video, media, timers, cleared, requests };
}

function home(view) {
  view.ctx.currentScreen = "home";
  view.ctx.rebuildFocus(view.screens.home, view.tab);
}
function respond(request, body = { cookie_names: ["cf_clearance"], cookie_length: 42 }) {
  request.resolve({ ok: true, status: 200, json: async () => body });
}

test("플레이어 닫기 버튼은 영상과 화면을 유지하고 타이머·컨트롤 포커스만 해제한다", () => {
  const view = fixture();
  view.ctx.showOverlayBriefly();
  const timer = view.ctx.player.overlayTimer;
  assert.equal(view.timers.get(timer).delay, 4000);
  view.ctx.focusPlayerControls();
  assert.ok(view.cleared.includes(timer));
  assert.equal(view.ctx.player.overlayTimer, null);
  assert.equal(view.ctx.focus.current, view.playerClose);
  view.ctx.handleAction("player-overlay-close");
  assert.equal(view.overlay.classList.contains("hidden"), true);
  assert.equal(view.ctx.player.controlsFocused, false);
  assert.equal(view.ctx.player.overlayTimer, null);
  assert.equal(view.ctx.focus.current, null);
  assert.equal(view.ctx.currentScreen, "player");
  assert.equal(view.video.currentTime, 60);
  assert.deepEqual(view.media, { plays: 0, pauses: 0, stops: 0, backs: 0, swaps: 0 });
});

test("플레이어 ↑/↓는 닫기 버튼으로 컨트롤 모드에 진입하고 자동 숨김을 중단한다", () => {
  for (const dy of [-1, 1]) {
    const view = fixture();
    view.ctx.onArrow(0, dy);
    assert.equal(view.ctx.player.controlsFocused, true);
    assert.equal(view.overlay.classList.contains("hidden"), false);
    assert.equal(view.ctx.focus.current, view.playerClose);
    assert.equal(view.ctx.player.overlayTimer, null);
    assert.equal(view.timers.size, 0);
    assert.equal(view.video.currentTime, 60);
  }
});

test("컨트롤 모드의 방향키는 포커스를 이동하고 OK는 선택 버튼만 실행한다", () => {
  const view = fixture();
  view.ctx.onArrow(0, -1);
  view.ctx.onArrow(1, 0);
  assert.equal(view.ctx.focus.current, view.swap);
  view.ctx.onOk();
  assert.equal(view.media.swaps, 1);
  assert.equal(view.video.currentTime, 60);
  assert.equal(view.media.pauses, 0);
  view.ctx.onArrow(-1, 0);
  assert.equal(view.ctx.focus.current, view.playerClose);
  view.ctx.onOk();
  assert.equal(view.overlay.classList.contains("hidden"), true);
  assert.equal(view.media.backs, 0);
});

test("기본 모드 좌우는 10초 seek, OK는 재생 토글을 유지한다", () => {
  const view = fixture();
  view.ctx.onArrow(1, 0);
  assert.equal(view.video.currentTime, 70);
  view.ctx.onArrow(-1, 0);
  assert.equal(view.video.currentTime, 60);
  view.ctx.onOk();
  assert.equal(view.media.pauses, 1);
  assert.equal(view.ctx.player.controlsFocused, false);
  assert.ok(view.ctx.player.overlayTimer);
});

test("Return 첫 번은 플레이어 오버레이만 닫고 다음 Return은 뒤로 간다", () => {
  const view = fixture();
  view.ctx.showOverlayBriefly();
  const timer = view.ctx.player.overlayTimer;
  assert.equal(view.ctx.onBack(), true);
  assert.equal(view.ctx.currentScreen, "player");
  assert.equal(view.overlay.classList.contains("hidden"), true);
  assert.equal(view.ctx.player.overlayTimer, null);
  assert.ok(view.cleared.includes(timer));
  assert.equal(view.timers.size, 0);
  assert.equal(view.media.backs, 0);
  assert.equal(view.media.pauses, 0);
  assert.equal(view.media.stops, 0);
  assert.equal(view.ctx.onBack(), true);
  assert.equal(view.media.backs, 1);
});

test("web 모드의 숨겨진 native 오버레이는 Return 닫기 단계를 추가하지 않는다", () => {
  const view = fixture("web");
  view.overlay.classList.remove("hidden");
  view.overlay.style.display = "none";
  assert.equal(view.ctx.playerOverlayEnabled(), false);
  assert.equal(view.ctx.isPlayerOverlayVisible(), false);
  assert.equal(view.ctx.onBack(), true);
  assert.equal(view.media.backs, 1);
  assert.equal(view.overlay.classList.contains("hidden"), false);
});

test("쿠키 갱신 진행 중 숨긴 결과 버튼과 무관하게 닫기가 초기 포커스다", () => {
  const view = fixture();
  home(view);
  let blurred = 0;
  view.ctx.document.activeElement = { tagName: "INPUT", blur: () => blurred++ };
  view.ctx.triggerCookieRefresh();
  assert.equal(view.requests.length, 1);
  assert.equal(view.actions.classList.contains("hidden"), true);
  assert.equal(view.ctx.isCookieOverlayVisible(), true);
  assert.equal(view.ctx.focus.current, view.cookieClose);
  assert.equal(view.ctx.focus.items.length, 1);
  assert.equal(blurred, 1);
  assert.equal(view.cookieClose.classList.contains("focused"), true);
  assert.equal(view.ctx.closeCookieOverlay(), true);
  assert.equal(view.ctx.focus.current, view.tab);
});

test("플레이어 위의 쿠키 창은 방향/OK를 먼저 받아 seek·재생을 건드리지 않는다", () => {
  const view = fixture();
  view.ctx.showOverlayBriefly();
  view.ctx.triggerCookieRefresh();
  view.ctx.onArrow(1, 0);
  view.ctx.onArrow(0, -1);
  assert.equal(view.ctx.focus.current, view.cookieClose);
  assert.equal(view.video.currentTime, 60);
  view.ctx.onOk();
  assert.equal(view.ctx.isCookieOverlayVisible(), false);
  assert.equal(view.overlay.classList.contains("hidden"), true);
  assert.equal(view.media.pauses, 0);
  assert.equal(view.media.stops, 0);
  assert.equal(view.media.backs, 0);
});

test("쿠키 창 닫기는 진행 중 요청을 취소하지 않고 늦은 성공에도 재오픈/포커스 탈취하지 않는다", async () => {
  const view = fixture();
  home(view);
  view.ctx.triggerCookieRefresh();
  let rebuilds = 0;
  const rebuild = view.ctx.rebuildFocus;
  view.ctx.rebuildFocus = (...args) => { rebuilds++; return rebuild(...args); };
  assert.equal(view.ctx.closeCookieOverlay(), true);
  const countAfterClose = rebuilds;
  assert.equal(view.ctx._autoRefreshInFlight, true);
  assert.equal(view.requests[0].aborted, false);
  respond(view.requests[0]);
  await settle();
  assert.equal(view.ctx._autoRefreshInFlight, false);
  assert.equal(view.requests[0].aborted, false);
  assert.equal(view.ctx.isCookieOverlayVisible(), false);
  assert.equal(view.ctx.focus.current, view.tab);
  assert.equal(rebuilds, countAfterClose);
  assert.equal(view.elements.get("cr-title").textContent, "발급 완료");
});

test("닫힌 쿠키 창에 늦은 오류가 와도 배경 화면의 포커스를 유지한다", async () => {
  const view = fixture();
  home(view);
  view.ctx.triggerCookieRefresh();
  view.ctx.onBack();
  let rebuilds = 0;
  view.ctx.rebuildFocus = () => rebuilds++;
  view.requests[0].reject(new Error("네트워크 오류"));
  await settle();
  assert.equal(view.ctx._autoRefreshInFlight, false);
  assert.equal(view.ctx.isCookieOverlayVisible(), false);
  assert.equal(view.ctx.focus.current, view.tab);
  assert.equal(rebuilds, 0);
  assert.equal(view.elements.get("cr-title").textContent, "호출 실패");
});

test("진행 중 수동 재호출은 새 요청 없이 기존 쿠키 창만 다시 연다", async () => {
  const view = fixture();
  home(view);
  view.ctx.triggerCookieRefresh();
  view.ctx.closeCookieOverlay();
  view.ctx.triggerCookieRefresh();
  assert.equal(view.requests.length, 1);
  assert.equal(view.ctx.isCookieOverlayVisible(), true);
  assert.equal(view.ctx.focus.current, view.cookieClose);
  respond(view.requests[0]);
  await settle();
  assert.equal(view.ctx.focus.current, view.confirm);
  assert.equal(view.ctx.isCookieOverlayVisible(), true);
  view.ctx.closeCookieOverlay();
});

test("홈 탭 0행에서도 쿠키 창이 열려 있으면 host가 Return을 처리한다", () => {
  const view = fixture();
  home(view);
  assert.equal(view.ctx.getHostState().canHandleBack, false);
  view.ctx.openCookieOverlay();
  assert.equal(view.ctx.getHostState().screen, "home");
  assert.equal(view.ctx.getHostState().canHandleBack, true);
  assert.equal(view.ctx.onBack(), true);
  assert.equal(view.ctx.focus.current, view.tab);
  assert.equal(view.ctx.getHostState().canHandleBack, false);
  assert.equal(view.ctx.onBack(), false);
});

test("다른 화면의 비동기 포커스 재구성도 열린 쿠키 창의 닫기 포커스를 빼앗지 못한다", () => {
  const view = fixture();
  home(view);
  view.ctx.openCookieOverlay();
  view.ctx.rebuildFocus(view.screens.detail);
  assert.equal(view.ctx.focus.current, view.cookieClose);
  assert.equal(view.ctx.focus.items.length, 1);
  assert.equal(view.ctx.focus.items[0].el, view.cookieClose);
  view.ctx.rebuildFocus(view.screens.home, view.tab);
  assert.equal(view.ctx.focus.current, view.cookieClose);
});

test("쿠키 창에서 숫자키는 홈 탭 이동과 상세 회차 재생을 차단한다", () => {
  const view = fixture();
  let tabs = 0, episodes = 0;
  view.ctx.selectTab = () => tabs++;
  view.ctx.playEpisode = () => episodes++;
  home(view);
  view.ctx.openCookieOverlay();
  for (const number of [0, 1, 5, 9]) assert.equal(view.ctx.handleNumberKey(number), true);
  view.ctx.currentScreen = "detail";
  view.ctx.detailState = { info: { episodes: [{ name: "1화" }] } };
  assert.equal(view.ctx.handleNumberKey(1), true);
  assert.equal(tabs, 0);
  assert.equal(episodes, 0);
  assert.equal(view.ctx.focus.current, view.cookieClose);
});

test("쿠키 창에서 색상키는 뒤쪽 삭제·전체 삭제·탭 갱신·영상 동작을 차단한다", () => {
  const view = fixture();
  const calls = [];
  home(view);
  view.tab._deleteHandler = () => calls.push("delete");
  view.ctx.clearCurrentTab = () => calls.push("clear");
  view.ctx.refreshCurrent = () => calls.push("refresh");
  view.ctx.cycleFitMode = () => calls.push("fit");
  view.ctx.playEpisode = () => calls.push("play");
  view.ctx.pendingClearAt = Date.now();
  view.ctx.openCookieOverlay();
  for (const color of ["red", "yellow", "blue", "green"]) view.ctx.onColor(color);
  view.ctx.currentScreen = "player";
  for (const color of ["red", "blue", "green"]) view.ctx.onColor(color);
  assert.deepEqual(calls, []);
  assert.equal(view.media.stops, 0);
  assert.equal(view.ctx.focus.current, view.cookieClose);
});
