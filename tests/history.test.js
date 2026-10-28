const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../app/app.js"), "utf8");

function load(names, overrides = {}) {
  const values = new Map();
  const context = {
    STORE: {
      get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
      set: (key, value) => values.set(key, value),
    },
    KEYS: { HISTORY: "history", RECENT_SORT: "sort" },
    Date: { now: () => 1000 },
    document: { querySelectorAll: () => [], getElementById: () => ({ textContent: "" }) },
    resolveNasUrl: value => value,
    stripNasPrefix: value => value,
    toast: () => {},
    ...overrides,
  };
  vm.createContext(context);
  for (const name of names) {
    const start = source.indexOf("  function " + name + "(");
    const end = source.indexOf("\n  }", start) + 4;
    assert.ok(start >= 0 && end > start, name);
    vm.runInContext(source.slice(start, end), context);
  }
  return context;
}

const history = () => [
  { detail_url: "/a", title: "가나다", updatedAt: 300, addedAt: 100 },
  { detail_url: "/b", title: "하하", updatedAt: 100, addedAt: 300 },
  { detail_url: "/c", title: "마바사", updatedAt: 200, addedAt: 200 },
];
const urls = items => Array.from(items, item => item.detail_url);

test("기본값과 잘못된 설정은 최근 시청순, 선택한 정렬은 기억한다", () => {
  let renders = 0;
  const ctx = load(["getRecentSort", "setRecentSort"], { renderRecentTab: () => renders++ });
  assert.equal(ctx.getRecentSort(), "watched");
  ctx.STORE.set("sort", "invalid");
  assert.equal(ctx.getRecentSort(), "watched");
  ctx.setRecentSort("added");
  assert.equal(ctx.getRecentSort(), "added");
  assert.equal(renders, 1);
});

test("시청순과 등록순을 각각 내림차순으로 표시하며 원본은 보존한다", () => {
  const ctx = load(["sortHistory"]);
  const items = history();
  const snapshot = JSON.stringify(items);
  assert.deepEqual(urls(ctx.sortHistory(items, "watched")), ["/a", "/c", "/b"]);
  assert.deepEqual(urls(ctx.sortHistory(items, "added")), ["/b", "/c", "/a"]);
  assert.equal(JSON.stringify(items), snapshot);
  assert.equal(ctx.sortHistory([], "watched").length, 0);
});

test("기존 기록은 시청 시각으로 등록 기준을 보완하고 이후에는 바꾸지 않는다", () => {
  const ctx = load(["ensureHistoryAddedAt", "sortHistory"]);
  const items = [
    { detail_url: "/old", updatedAt: 100 },
    { detail_url: "/new", updatedAt: 300, addedAt: 200 },
    { detail_url: "/unknown" },
  ];
  ctx.ensureHistoryAddedAt(items);
  assert.deepEqual(items.map(item => item.addedAt), [100, 200, 0]);
  items[0].updatedAt = 1000;
  ctx.ensureHistoryAddedAt(items);
  assert.equal(items[0].addedAt, 100);
  assert.deepEqual(urls(ctx.sortHistory(items, "added")), ["/new", "/old", "/unknown"]);
  assert.deepEqual(urls(ctx.sortHistory(items, "watched")), ["/old", "/new", "/unknown"]);
});

test("정렬 메뉴 표시와 상세 연결은 선택한 순서와 일치한다", () => {
  let rendered, opened;
  const buttons = ["watched", "added"].map(mode => ({
    dataset: { action: "recent-sort-" + mode },
    setAttribute: function (key, value) { this[key] = value; },
  }));
  const ctx = load(["getRecentSort", "sortHistory", "renderRecentTab"], {
    document: { querySelectorAll: () => buttons },
    renderGrid: (items, onClick) => { rendered = { items, onClick }; },
    openDetail: (item, hit) => { opened = hit; },
  });
  ctx.STORE.set("history", history());
  ctx.STORE.set("sort", "added");
  ctx.renderRecentTab();
  assert.deepEqual(Array.from(rendered.items, item => item.url), ["/b", "/c", "/a"]);
  assert.equal(buttons[0]["aria-checked"], "false");
  assert.equal(buttons[1]["aria-checked"], "true");
  rendered.onClick(rendered.items[0]);
  assert.equal(opened.detail_url, "/b");
});

test("정렬한 뒤 최신 60개를 표시한다", () => {
  let rendered;
  const ctx = load(["getRecentSort", "sortHistory", "renderRecentTab"], {
    renderGrid: items => { rendered = items; },
  });
  ctx.STORE.set("history", Array.from({ length: 65 }, (_, i) => ({ detail_url: "/" + i, updatedAt: i })));
  ctx.renderRecentTab();
  assert.equal(rendered.length, 60);
  assert.equal(rendered[0].url, "/64");
  assert.equal(rendered[59].url, "/5");
});

function playback(overrides = {}) {
  return load(["persistHistory", "toggleHistory", "rememberEpisode", "playEpisode"], {
    detailState: { item: { url: "/a", title: "작품" }, info: null },
    player: { currentEp: { play_url: "/ep", name: "회차", episode: 1 }, video: { currentTime: 30, duration: 100 } },
    updateHistoryButton: () => {},
    show: () => {},
    applyFitMode: () => {},
    getPlaybackSource: () => new Promise(() => {}),
    ...overrides,
  });
}

test("재생 위치 저장은 시청 시각만 갱신하고 등록 시각을 보존한다", () => {
  const ctx = playback();
  ctx.STORE.set("history", history());
  ctx.persistHistory();
  const saved = ctx.STORE.get("history")[0];
  assert.equal(saved.detail_url, "/a");
  assert.equal(saved.updatedAt, 1000);
  assert.equal(saved.addedAt, 100);
  assert.equal(saved.lastEpisode.position, 30);
});

test("재생 위치 저장으로 새 기록을 만들 때 등록 시각도 저장한다", () => {
  const ctx = playback();
  ctx.STORE.set("history", []);
  ctx.persistHistory();
  assert.equal(ctx.STORE.get("history")[0].addedAt, 1000);
});

test("수동 등록과 제거 후 재등록은 새 등록 시각을 사용한다", () => {
  const ctx = playback();
  ctx.STORE.set("history", []);
  ctx.toggleHistory();
  assert.equal(ctx.STORE.get("history")[0].addedAt, 1000);
  ctx.toggleHistory();
  assert.equal(ctx.STORE.get("history").length, 0);
  ctx.Date.now = () => 2000;
  ctx.toggleHistory();
  assert.equal(ctx.STORE.get("history")[0].addedAt, 2000);
});

test("재생 시작 기록은 기존 등록 시각을 유지하고 새 항목에는 생성한다", () => {
  const classList = { remove: () => {} };
  const player = { titleEl: {}, loadingEl: { classList }, overlay: { classList } };
  const ctx = playback({ player });
  ctx.STORE.set("history", history());
  ctx.playEpisode({ play_url: "/ep", name: "회차" });
  assert.equal(ctx.STORE.get("history")[0].addedAt, 100);
  ctx.STORE.set("history", []);
  ctx.playEpisode({ play_url: "/ep", name: "회차" });
  assert.equal(ctx.STORE.get("history")[0].addedAt, 1000);
});

test("회차 글꼴은 한 줄 폭에 맞춰 14px 아래로도 축소하고 넓어지면 복원한다", () => {
  const names = [
    { style: {}, clientWidth: 63, scrollWidth: 77 },
    { style: {}, clientWidth: 63, scrollWidth: 600 },
    { style: {}, clientWidth: 200, scrollWidth: 70 },
    { style: {}, clientWidth: 0, scrollWidth: 100 },
  ];
  const ctx = load(["fitEpisodeNames"], {
    document: { querySelectorAll: () => names },
    window: { getComputedStyle: () => ({ fontSize: "20px" }) },
  });
  ctx.fitEpisodeNames();
  assert.equal(names[0].style.fontSize, "16px");
  assert.equal(names[1].style.fontSize, "2px");
  assert.equal(names[2].style.fontSize, "");
  assert.equal(names[3].style.fontSize, "");
  assert.ok(names.every(name => name.style.whiteSpace === ""));
  names[0].clientWidth = 200;
  ctx.fitEpisodeNames();
  assert.equal(names[0].style.fontSize, "");
});

test("회차 이름 스타일은 줄바꿈이나 말줄임 없이 한 줄로 고정한다", () => {
  const css = fs.readFileSync(path.join(__dirname, "../app/style.css"), "utf8");
  const rule = css.match(/\.ep-card \.ep-name\s*\{([^}]*)\}/);
  assert.ok(rule);
  assert.match(rule[1], /white-space:\s*nowrap/);
  assert.doesNotMatch(rule[1], /ellipsis|overflow-wrap|word-break/);
});

function episodeRenderer() {
  const cards = [], buttons = new Map();
  let preferred, played, fits = 0;
  const list = {
    innerHTML: "", appendChild: card => cards.push(card),
    querySelector: () => cards[0], querySelectorAll: () => cards,
  };
  const ctx = load(["escapeHtml", "renderEpisodes"], {
    detailState: { item: { url: "/show" }, historyHit: { lastEpisode: { play_url: "/play/3" } } },
    screens: { detail: {} },
    document: {
      createElement: () => ({ dataset: {}, handlers: {}, addEventListener: function (event, fn) { this.handlers[event] = fn; } }),
      getElementById: id => {
        if (id === "episode-list") return list;
        if (!buttons.has(id)) buttons.set(id, { dataset: {} });
        return buttons.get(id);
      },
      querySelector: () => ({ dataset: {} }),
    },
    fitEpisodeNames: () => fits++,
    rebuildFocus: (screen, card) => { preferred = card; },
    playEpisode: ep => { played = ep; },
  });
  return { ctx, cards, preferred: () => preferred, played: () => played, fits: () => fits };
}

test("최신 4화가 맨 앞이어도 순번을 붙이지 않고 서버 이름과 순서만 표시한다", () => {
  const view = episodeRenderer();
  view.ctx.renderEpisodes([
    { name: "4", episode: 1, play_url: "/play/4" },
    { name: "3", episode: 2, play_url: "/play/3" },
    { name: "2", episode: 3, play_url: "/play/2" },
  ]);
  assert.deepEqual(view.cards.map(card => card.innerHTML), [
    '<div class="ep-name">4</div>', '<div class="ep-name">3</div>', '<div class="ep-name">2</div>',
  ]);
  assert.deepEqual(view.cards.map(card => card._epPlayUrl), ["/play/4", "/play/3", "/play/2"]);
  assert.equal(view.preferred()._epPlayUrl, "/play/3");
  assert.equal(view.fits(), 1);
  view.cards[0].handlers.click();
  assert.equal(view.played().play_url, "/play/4");
});

test("날짜·원본 회차 이름은 그대로 표시하고 임의 회차나 HTML을 추가하지 않는다", () => {
  const view = episodeRenderer();
  view.ctx.renderEpisodes([
    { name: "26/10/20", episode: 1, play_url: "/date" },
    { name: "제4화", episode: 2, play_url: "/four" },
    { name: "<원본 이름>", episode: 3, play_url: "/text" },
  ]);
  assert.equal(view.cards[0].innerHTML, '<div class="ep-name">26/10/20</div>');
  assert.equal(view.cards[1].innerHTML, '<div class="ep-name">제4화</div>');
  assert.equal(view.cards[2].innerHTML, '<div class="ep-name">&lt;원본 이름&gt;</div>');
  assert.ok(view.cards.every(card => !card.innerHTML.includes("ep-num")));
});

test("회차 번호 표시를 없애도 기존 재생 진행률은 보존한다", () => {
  const view = episodeRenderer();
  view.ctx.STORE.set("history", [{ detail_url: "/show", episodes: { "/play/4": { position: 50, duration: 100 } } }]);
  view.ctx.renderEpisodes([{ name: "4", episode: 1, play_url: "/play/4" }]);
  assert.match(view.cards[0].innerHTML, /width:50%/);
  assert.ok(!view.cards[0].innerHTML.includes("1화"));
});

test("숫자 단축키는 추정 번호가 아니라 원본에 적힌 회차를 선택한다", () => {
  let played;
  const ctx = load(["handleNumberKey"], {
    currentScreen: "detail",
    detailState: { info: { episodes: [
      { name: "4", episode: 1, play_url: "/play/4" },
      { name: "제1회", episode: 2, play_url: "/play/1" },
      { name: "10화", episode: 3, play_url: "/play/10" },
    ] } },
    playEpisode: ep => { played = ep; },
  });
  assert.equal(ctx.handleNumberKey(1), true);
  assert.equal(played.play_url, "/play/1");
  assert.equal(ctx.handleNumberKey(4), true);
  assert.equal(played.play_url, "/play/4");
  assert.equal(ctx.handleNumberKey(0), true);
  assert.equal(played.play_url, "/play/10");
  assert.equal(ctx.handleNumberKey(2), false);
});

test("날짜나 일반 이름뿐인 항목은 추정 회차 단축키로 재생하지 않는다", () => {
  let plays = 0;
  const ctx = load(["handleNumberKey"], {
    currentScreen: "detail",
    detailState: { info: { episodes: [
      { name: "26/10/20", episode: 1 }, { name: "바로보기", episode: 2 },
    ] } },
    playEpisode: () => plays++,
  });
  assert.equal(ctx.handleNumberKey(1), false);
  assert.equal(ctx.handleNumberKey(2), false);
  assert.equal(plays, 0);
});

function externalPlayback(overrides = {}) {
  const flushes = [], cleared = [];
  const ctx = load(["rememberEpisode", "findHistory", "getExternalEpisodes", "playbackProxyUrl", "getPlaybackSource", "prepareExternalPlayback", "recordExternalPlayback"], {
    URL, currentScreen: "detail", playbackSources: Object.create(null), PLAYBACK_SOURCE_TTL_MS: 30000,
    detailState: { item: { url: "/show", title: "작품" }, info: { episodes: [
      { name: "4", episode: 1, play_url: "/play/4" },
    ] } },
    nasUrl: () => "http://nas.test:7777", _pushTimers: { history: 123 },
    clearTimeout: timer => cleared.push(timer),
    _pushHistory: keepalive => flushes.push(keepalive),
    updateHistoryButton: () => {}, updateResumeInfo: () => {},
    apiGet: async () => ({ proxy_url: "http://nas.test:7777/proxy?u=https%3A%2F%2Fmedia.test%2Fvideo.mp4" }),
    ...overrides,
  });
  ctx.STORE.set("history", []);
  return { ctx, flushes, cleared };
}

test("외부 재생 준비는 원본 회차와 NAS 프록시를 사용하고 시청 기록을 바꾸지 않는다", async () => {
  let options;
  const { ctx, flushes } = externalPlayback({ apiGet: async (url, opts) => {
    options = { url, opts };
    return { proxy_url: "http://nas.test:7777/proxy?u=video" };
  } });
  const details = ctx.getExternalEpisodes();
  details.episodes.pop();
  assert.equal(ctx.detailState.info.episodes.length, 1);
  const ready = await ctx.prepareExternalPlayback("/play/4");
  assert.equal(ready.url, "http://nas.test:7777/proxy?u=video");
  assert.equal(ready.episode.name, "4");
  assert.equal(ready.detailUrl, "/show");
  assert.equal(options.opts.bypass, true);
  assert.match(options.url, /%2Fplay%2F4/);
  assert.equal(ctx.STORE.get("history").length, 0);
  assert.deepEqual(flushes, []);
  assert.equal(ctx.currentScreen, "detail");
});

test("외부 재생은 현재 목록에 없는 회차와 NAS 이외의 주소를 거부한다", async () => {
  const { ctx } = externalPlayback();
  await assert.rejects(ctx.prepareExternalPlayback("/not-in-list"), /회차를 선택/);
  for (const proxy_url of ["https://evil.test/proxy?u=video", "http://nas.test:7777/not-proxy", "http://user:password@nas.test:7777/proxy"]) {
    ctx.apiGet = async () => ({ proxy_url });
    await assert.rejects(ctx.prepareExternalPlayback("/play/4"), /NAS 프록시/);
  }
});

test("외부 주소를 준비하는 동안 상세가 바뀌면 이전 응답을 사용하지 않는다", async () => {
  let resolve;
  const { ctx } = externalPlayback({ apiGet: () => new Promise(done => { resolve = done; }) });
  const pending = ctx.prepareExternalPlayback("/play/4");
  ctx.detailState = { item: { url: "/other" }, info: { episodes: [] } };
  resolve({ proxy_url: "http://nas.test:7777/proxy?u=video" });
  await assert.rejects(pending, /상세 화면이 변경/);
  assert.equal(ctx.STORE.get("history").length, 0);
});

test("외부 앱 열기 시도만 즉시 전송하고 기존 재생 위치와 등록 시각은 유지한다", () => {
  const { ctx, flushes, cleared } = externalPlayback();
  ctx.STORE.set("history", [{ detail_url: "/show", addedAt: 50, updatedAt: 100,
    episodes: { "/play/4": { name: "4", position: 70, duration: 100 } },
  }]);
  assert.equal(ctx.recordExternalPlayback("/play/4", "/wrong"), false);
  assert.deepEqual(flushes, []);
  assert.equal(ctx.recordExternalPlayback("/play/4", "/show"), true);
  const saved = ctx.STORE.get("history")[0];
  assert.equal(saved.addedAt, 50);
  assert.equal(saved.updatedAt, 1000);
  assert.equal(saved.lastEpisode.name, "4");
  assert.equal(saved.lastEpisode.position, 70);
  assert.equal(saved.episodes["/play/4"].duration, 100);
  assert.deepEqual(flushes, [true]);
  assert.deepEqual(cleared, [123]);
  ctx.currentScreen = "home";
  assert.equal(ctx.getExternalEpisodes(), null);
  assert.equal(ctx.recordExternalPlayback("/play/4", "/show"), false);
});

test("외부 앱 전환 시 작은 기록만 keepalive로 전송한다", () => {
  const requests = [];
  const ctx = load(["_pushHistory"], {
    profileCache: { id: "default", history: [{ title: "작품" }] },
    nasUrl: () => "http://nas.test:7777", fetch: async (url, opts) => { requests.push(opts); },
  });
  ctx._pushHistory(true);
  assert.equal(requests[0].keepalive, true);
  ctx.profileCache.history = [{ title: "가".repeat(17000) }];
  ctx._pushHistory(true);
  assert.equal(requests[1].keepalive, undefined);
  ctx.profileCache.history = [];
  ctx._pushHistory();
  assert.equal(requests[2].keepalive, undefined);
});

function sourceCache(overrides = {}) {
  const requests = [];
  let ctx;
  ctx = load(["playbackProxyUrl", "getPlaybackSource"], {
    URL, playbackSources: Object.create(null), PLAYBACK_SOURCE_TTL_MS: 30000,
    nasUrl: () => "http://nas.test:7777",
    apiGet: (path, opts) => {
      requests.push({ path, opts });
      return Promise.resolve({ proxy_url: ctx.nasUrl() + "/proxy?u=" + requests.length });
    },
    ...overrides,
  });
  return { ctx, requests };
}

test("같은 회차의 진행 중 추출은 한 번만 요청하고 Promise를 공유한다", async () => {
  let resolve, calls = 0;
  const { ctx } = sourceCache({ apiGet: () => {
    calls++;
    return new Promise(done => { resolve = done; });
  } });
  const first = ctx.getPlaybackSource("/play/4");
  const second = ctx.getPlaybackSource("/play/4");
  assert.equal(first, second);
  assert.equal(calls, 1);
  resolve({ proxy_url: "http://nas.test:7777/proxy?u=video" });
  assert.equal(await first, await second);
});

test("최근 30초 결과는 재사용하되 만료되면 새 영상 주소를 추출한다", async () => {
  const { ctx, requests } = sourceCache();
  const first = await ctx.getPlaybackSource("/play/4");
  assert.equal(await ctx.getPlaybackSource("/play/4"), first);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].opts.bypass, true);
  ctx.Date.now = () => 31000;
  const next = await ctx.getPlaybackSource("/play/4");
  assert.notEqual(next, first);
  assert.equal(requests.length, 2);
});

test("강제 재시도는 최근 주소도 무시하고 새 주소를 준비한다", async () => {
  const { ctx, requests } = sourceCache();
  await ctx.getPlaybackSource("/play/4");
  const forced = await ctx.getPlaybackSource("/play/4", true);
  assert.equal(requests.length, 2);
  assert.equal(await ctx.getPlaybackSource("/play/4"), forced);
  assert.equal(requests.length, 2);
});

test("강제 갱신 뒤 늦게 도착한 이전 응답은 최신 메모리 캐시를 덮지 않는다", async () => {
  const pending = [];
  const { ctx } = sourceCache({ apiGet: () => new Promise(resolve => pending.push(resolve)) });
  const old = ctx.getPlaybackSource("/play/4");
  const fresh = ctx.getPlaybackSource("/play/4", true);
  pending[1]({ proxy_url: "http://nas.test:7777/proxy?u=fresh" });
  const latest = await fresh;
  pending[0]({ proxy_url: "http://nas.test:7777/proxy?u=old" });
  await old;
  assert.equal(await ctx.getPlaybackSource("/play/4"), latest);
  assert.equal(pending.length, 2);
});

test("네트워크 오류·추출 오류·잘못된 프록시 결과는 재사용하지 않는다", async () => {
  let calls = 0;
  const { ctx } = sourceCache({ apiGet: () => {
    calls++;
    if (calls === 1) return Promise.reject(new Error("원본 서버 오류"));
    if (calls === 2) return Promise.resolve({ error: "추출 실패" });
    if (calls === 3) return Promise.resolve({ proxy_url: "https://evil.test/proxy?u=video" });
    return Promise.resolve({ proxy_url: "http://nas.test:7777/proxy?u=valid" });
  } });
  await assert.rejects(ctx.getPlaybackSource("/play/4"), /원본 서버 오류/);
  await assert.rejects(ctx.getPlaybackSource("/play/4"), /추출 실패/);
  await assert.rejects(ctx.getPlaybackSource("/play/4"), /NAS 프록시/);
  assert.match((await ctx.getPlaybackSource("/play/4")).proxy_url, /valid/);
  assert.equal(calls, 4);
});

test("NAS와 회차가 달라지거나 시계가 뒤로 가면 이전 주소를 재사용하지 않는다", async () => {
  const { ctx, requests } = sourceCache();
  await ctx.getPlaybackSource("/play/4");
  ctx.nasUrl = () => "http://other-nas.test:7777";
  await ctx.getPlaybackSource("/play/4");
  await ctx.getPlaybackSource("/play/3");
  assert.equal(requests.length, 3);
  ctx.Date.now = () => 999;
  await ctx.getPlaybackSource("/play/3");
  assert.equal(requests.length, 4);
});

test("상단 강제 최신화는 재생 주소 메모리도 비우고 상세를 다시 조회한다", () => {
  let bypass;
  const ctx = load(["refreshCurrent"], {
    currentScreen: "detail", detailState: { item: { url: "/show" }, historyHit: null },
    playbackSources: { old: { result: {} } }, closeCacheMenu: () => {},
    openDetail: (item, hit, force) => { bypass = force; },
  });
  ctx.refreshCurrent();
  assert.equal(Object.keys(ctx.playbackSources).length, 0);
  assert.equal(bypass, true);
});
