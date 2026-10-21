const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../app/app.js"), "utf8");
const prefix = "tvchak.api:";

function element() {
  const classes = new Set(["hidden"]);
  return {
    dataset: {}, textContent: "", style: {},
    classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
    setAttribute: function (key, value) { this[key] = value; },
  };
}

function load(names, overrides = {}) {
  const storage = new Map();
  const elements = new Map();
  const context = {
    API_CACHE_PREFIX: prefix, API_TIMEOUT_MS: 500,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    getCacheTtlMs: () => 86400000,
    nasUrl: () => "http://nas",
    pruneApiCache: () => {},
    setTimeout, clearTimeout, AbortController,
    document: { getElementById: id => {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    } },
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
const apiFunctions = ["_isCacheablePath", "cacheRead", "cacheWrite", "apiGet"];
const settle = () => new Promise(resolve => setImmediate(resolve));

test("캐시 읽기는 저장 시각을 보존하고 만료·잘못된 캐시는 무시한다", () => {
  const ctx = load(["cacheRead"]);
  const cached = { ts: Date.now() - 60000, data: { items: [1] } };
  ctx.localStorage.setItem(prefix + "/api/test", JSON.stringify(cached));
  assert.equal(JSON.stringify(ctx.cacheRead("/api/test")), JSON.stringify(cached));
  ctx.localStorage.setItem(prefix + "/api/test", JSON.stringify({ ...cached, ts: Date.now() - 86400001 }));
  assert.equal(ctx.cacheRead("/api/test"), null);
  ctx.localStorage.setItem(prefix + "/api/test", "invalid");
  assert.equal(ctx.cacheRead("/api/test"), null);
});

test("캐시 적중은 네트워크 요청 없이 실제 저장 시각과 출처를 전달한다", async () => {
  const ctx = load(apiFunctions, { fetch: () => { throw new Error("요청하면 안 됩니다"); } });
  const ts = Date.now() - 60000;
  ctx.localStorage.setItem(prefix + "/api/test", JSON.stringify({ ts, data: { cached: true } }));
  const info = {};
  const result = await ctx.apiGet("/api/test", { source: info });
  assert.equal(result.cached, true);
  assert.deepEqual(info, { cached: true, ts });
});

test("강제 갱신은 저장 캐시와 브라우저 캐시를 건너뛰고 새 응답을 저장한다", async () => {
  let options;
  const ctx = load(apiFunctions, { fetch: async (url, opts) => {
    options = opts;
    return { ok: true, text: async () => JSON.stringify({ fresh: true }) };
  } });
  ctx.localStorage.setItem(prefix + "/api/test", JSON.stringify({ ts: Date.now(), data: { old: true } }));
  const info = {};
  const before = Date.now();
  const result = await ctx.apiGet("/api/test", { bypass: true, source: info });
  assert.equal(result.fresh, true);
  assert.equal(options.cache, "no-store");
  assert.equal(info.cached, false);
  assert.ok(info.ts >= before);
  assert.equal(JSON.parse(ctx.localStorage.getItem(prefix + "/api/test")).data.fresh, true);
});

test("조회 실패는 최신 데이터로 표시하거나 기존 캐시를 덮어쓰지 않는다", async () => {
  const ctx = load(apiFunctions, { fetch: async () => ({ ok: false, status: 502, text: async () => '{"error":"실패"}' }) });
  const original = JSON.stringify({ ts: Date.now(), data: { old: true } });
  ctx.localStorage.setItem(prefix + "/api/test", original);
  const info = {};
  await assert.rejects(ctx.apiGet("/api/test", { bypass: true, source: info }), /실패/);
  assert.deepEqual(info, {});
  assert.equal(ctx.localStorage.getItem(prefix + "/api/test"), original);
});

test("캐시 대상이 아닌 스트림 추출은 매번 네트워크로 조회한다", async () => {
  let calls = 0;
  const ctx = load(apiFunctions, { fetch: async () => {
    calls++;
    return { ok: true, text: async () => '{"video_url":"new"}' };
  } });
  ctx.localStorage.setItem(prefix + "/api/extract?u=x", JSON.stringify({ ts: Date.now(), data: { video_url: "old" } }));
  assert.equal((await ctx.apiGet("/api/extract?u=x")).video_url, "new");
  assert.equal(calls, 1);
});

test("표시는 캐시·최신·캐시 혼합을 구분하고 조회 중과 실패 상태도 제공한다", () => {
  const ctx = load(["setCacheBadge"]);
  const badge = ctx.document.getElementById("badge");
  const ts = Date.now() - 60000;
  ctx.setCacheBadge("badge", "ready", [{ cached: true, ts }]);
  assert.equal(badge.dataset.state, "cached");
  assert.match(badge.textContent, /^캐시 · /);
  ctx.setCacheBadge("badge", "ready", [{ cached: true, ts }, { cached: false, ts: Date.now() }]);
  assert.match(badge.textContent, /^캐시 포함 · /);
  ctx.setCacheBadge("badge", "ready", [{ cached: false, ts }]);
  assert.equal(badge.dataset.state, "fresh");
  assert.match(badge.textContent, /^최신 조회 · /);
  ctx.setCacheBadge("badge", "loading");
  assert.equal(badge["aria-busy"], "true");
  ctx.setCacheBadge("badge", "error");
  assert.equal(badge.dataset.state, "error");
  assert.equal(badge["aria-busy"], "false");
  ctx.setCacheBadge("badge");
  assert.equal(badge.classList.contains("hidden"), true);
});

test("목록 최신화는 1페이지부터 다시 조회하고 추가 페이지도 캐시를 우회한다", async () => {
  let seq = 0;
  const requests = [];
  const ctx = load(["loadCategoryFirst", "loadCategoryMore"], {
    listState: { mode: "cat", cat: "1", page: 5, hasMore: true },
    newApiToken: () => ++seq,
    setCacheBadge: () => {},
    renderGrid: () => {}, appendToGrid: () => {}, openDetail: () => {},
    apiGet: async (url, opts) => {
      requests.push({ url, bypass: opts.bypass });
      Object.assign(opts.source, { cached: false, ts: Date.now() });
      return { items: Array(12).fill({}) };
    },
  });
  ctx.loadCategoryFirst(true);
  await settle();
  assert.match(requests[0].url, /page=1$/);
  assert.equal(ctx.listState.sources.length, 1);
  ctx.loadCategoryMore();
  await settle();
  assert.match(requests[1].url, /page=2$/);
  assert.ok(requests.every(request => request.bypass === true));
  assert.equal(ctx.listState.sources.length, 2);
});

test("늦게 도착한 이전 검색 응답은 결과와 캐시 표시를 덮어쓰지 않는다", async () => {
  let seq = 0, query = "first";
  const pending = [], rendered = [], badges = [];
  const ctx = load(["doSearch"], {
    listState: {}, newApiToken: () => ++seq, inputValue: () => query,
    setCacheBadge: (id, state, sources) => { if (state === "ready") badges.push(sources[0]); },
    _userIsTypingInInput: () => false, openDetail: () => {},
    renderGrid: items => rendered.push(items[0]),
    apiGet: (url, opts) => new Promise(resolve => pending.push({ resolve, opts })),
  });
  ctx.doSearch();
  query = "second";
  ctx.doSearch();
  pending[1].opts.source.cached = false;
  pending[1].resolve({ items: ["second"] });
  await settle();
  pending[0].opts.source.cached = true;
  pending[0].resolve({ items: ["first"] });
  await settle();
  assert.deepEqual(rendered, ["second"]);
  assert.equal(badges.length, 1);
  assert.equal(badges[0].cached, false);
});

test("상세 출처는 최신 요청에만 갱신되고 재조회 실패를 최신으로 표시하지 않는다", async () => {
  const pending = [], rendered = [];
  const oldFocus = element();
  oldFocus.classList.add("focused");
  const ctx = load(["setCacheBadge", "openDetail"], {
    currentScreen: "detail", detailState: null, focus: { current: oldFocus }, screens: { detail: {} },
    show: () => {}, findHistory: () => null,
    stripNasPrefix: value => value, wrapAsProxy: value => value, setCardImage: () => {},
    updateHistoryButton: () => {}, updateFavButton: () => {}, updateResumeInfo: () => {},
    rebuildFocus: () => {}, _pendingAutoPlay: null,
    renderEpisodes: episodes => rendered.push(episodes[0]),
    apiGet: (url, opts) => new Promise((resolve, reject) => pending.push({ opts, resolve, reject })),
  });
  ctx.document.querySelector = () => element();
  ctx.openDetail({ url: "/old", title: "이전 작품" });
  assert.equal(oldFocus.classList.contains("focused"), false);
  ctx.openDetail({ url: "/new", title: "현재 작품" });
  Object.assign(pending[1].opts.source, { cached: false, ts: Date.now() });
  pending[1].resolve({ title: "현재 작품", episodes: ["new"] });
  await settle();
  Object.assign(pending[0].opts.source, { cached: true, ts: Date.now() - 60000 });
  pending[0].resolve({ title: "이전 작품", episodes: ["old"] });
  await settle();
  assert.deepEqual(rendered, ["new"]);
  assert.equal(ctx.detailState.info.title, "현재 작품");
  assert.equal(ctx.document.getElementById("detail-cache").dataset.state, "fresh");
  ctx.openDetail({ url: "/new", title: "현재 작품" }, null, true);
  assert.equal(pending[2].opts.bypass, true);
  pending[2].reject(new Error("네트워크 실패"));
  await settle();
  assert.equal(ctx.document.getElementById("detail-cache").dataset.state, "error");
});
