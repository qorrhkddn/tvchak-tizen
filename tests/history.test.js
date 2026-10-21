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
  return load(["persistHistory", "toggleHistory", "playEpisode"], {
    detailState: { item: { url: "/a", title: "작품" }, info: null },
    player: { currentEp: { play_url: "/ep", name: "회차", episode: 1 }, video: { currentTime: 30, duration: 100 } },
    updateHistoryButton: () => {},
    show: () => {},
    applyFitMode: () => {},
    apiGet: () => new Promise(() => {}),
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

test("회차 글꼴은 폭에 맞춰 축소하되 최소 크기와 줄바꿈을 보장한다", () => {
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
  assert.equal(names[1].style.fontSize, "14px");
  assert.equal(names[2].style.fontSize, "");
  assert.equal(names[3].style.fontSize, "");
  assert.ok(names.every(name => name.style.whiteSpace === ""));
  names[0].clientWidth = 200;
  ctx.fitEpisodeNames();
  assert.equal(names[0].style.fontSize, "");
});
