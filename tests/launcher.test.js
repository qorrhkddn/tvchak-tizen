const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const bridge = require("../app/host-bridge.js");
const launcher = require("../launcher/launcher.js");
const TOKEN = "0123456789abcdef0123456789abcdef";
const HOST = "http://127.0.0.1:18778";

function storage() {
  const values = new Map();
  return { getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)) };
}
function events(target = {}) {
  const listeners = new Map();
  return Object.assign(target, {
    addEventListener: (type, fn) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    removeEventListener: (type, fn) => { listeners.set(type, (listeners.get(type) || []).filter(item => item !== fn)); },
    emit: (type, event) => { for (const fn of listeners.get(type) || []) fn(event); },
  });
}
function fakeWindow() {
  const nodes = new Map(), timers = new Map();
  let timerId = 0;
  const doc = events({ activeElement: null, dispatched: [],
    getElementById: id => {
      if (!nodes.has(id)) {
        const classes = new Set();
        const node = events({ id, dataset: {}, style: {}, textContent: "", value: "",
          classList: { add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key) },
          setAttribute: function (key, value) { this[key] = value; },
          removeAttribute: function (key) { delete this[key]; },
          focus: function () { doc.activeElement = this; }, blur: () => { doc.activeElement = null; },
        });
        nodes.set(id, node);
      }
      return nodes.get(id);
    },
    createEvent: () => ({ initEvent: function (type) { this.type = type; } }),
  });
  doc.dispatchEvent = event => { doc.dispatched.push(event); doc.emit(event.type, event); };
  const root = events({
    document: doc, localStorage: storage(), location: { origin: HOST, href: HOST + "/launcher/index.html" },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    KeyboardEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    timers,
  });
  return root;
}
function fakeClient() {
  const root = fakeWindow();
  root.TVCHAK_WEB = { hosted: true, mode: "tv", bridgeVersion: 1 };
  root.location = { href: "http://127.0.0.1:18779/web/?tv=1&host_origin=" + encodeURIComponent(HOST) + "&host_token=" + TOKEN };
  root.sent = [];
  root.parent = { postMessage: (data, target) => root.sent.push({ data, target }) };
  root.deliver = (data, overrides = {}) => root.emit("message", {
    source: root.parent, origin: HOST, data: { version: 1, channel: TOKEN, ...data }, ...overrides,
  });
  return root;
}
function boot(root, settings = {}) {
  root.deliver({ type: "tvchak:boot", settings });
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("NAS 주소는 http(s) origin으로 제한하고 인증 정보·다른 프로토콜은 거부한다", () => {
  assert.equal(bridge.normalizeNas("ramel.local:7777/web/?tv=1"), "http://ramel.local:7777");
  assert.equal(bridge.normalizeNas("https://nas.test/web/"), "https://nas.test");
  for (const value of ["", "javascript:alert(1)", "ftp://nas.test", "http://user:password@nas.test"]) {
    assert.throws(() => bridge.normalizeNas(value));
  }
});

test("설정 이전은 허용된 값만 가져오고 기존 NAS 설정을 덮지 않는다", () => {
  const store = storage();
  store.setItem("tvchak.recentSort", JSON.stringify("added"));
  bridge.importSettings(store, {
    "tvchak.recentSort": "watched", "tvchak.profileId": "default", "tvchak.fitMode": "cover",
    "tvchak.cacheTtlHours": 500, "cookie": "secret", "tvchak.history": ["private"],
  });
  assert.deepEqual(bridge.readSettings(store), {
    "tvchak.profileId": "default", "tvchak.recentSort": "added", "tvchak.fitMode": "cover",
  });
  assert.equal(store.getItem("cookie"), null);
  assert.equal(store.getItem("tvchak.history"), null);
});

test("실행기 설정을 받은 뒤에만 시작하고 창·origin·채널이 다른 메시지는 무시한다", async () => {
  const root = fakeClient(), client = bridge.createClient(root);
  let ready = false;
  const pending = client.start(() => ({ screen: "home", canHandleBack: false })).then(() => { ready = true; });
  assert.equal(root.sent[0].data.type, "tvchak:ready");
  assert.equal(root.sent[0].data.channel, TOKEN);
  root.deliver({ type: "tvchak:boot", settings: { "tvchak.profileId": "wrong" } }, { origin: "https://evil.test" });
  root.deliver({ type: "tvchak:boot", settings: {} }, { source: {} });
  root.deliver({ type: "tvchak:boot", channel: "bad", settings: {} });
  await settle();
  assert.equal(ready, false);
  boot(root, { "tvchak.profileId": "family" });
  await pending;
  assert.equal(JSON.parse(root.localStorage.getItem("tvchak.profileId")), "family");
  assert.equal(root.sent.at(-1).data.type, "tvchak:state");
  client.destroy();
});

test("키 중계와 설정 동기화는 허용 목록으로 제한한다", async () => {
  const root = fakeClient(), client = bridge.createClient(root);
  const pending = client.start(() => ({ screen: "detail", canHandleBack: true }));
  boot(root);
  await pending;
  root.deliver({ type: "tvchak:key", keyCode: 13 });
  root.deliver({ type: "tvchak:key", keyCode: 999999 });
  root.deliver({ type: "tvchak:key", keyCode: 37 }, { origin: "https://evil.test" });
  assert.deepEqual(root.document.dispatched.map(event => event.keyCode), [13]);
  const before = root.sent.length;
  client.setSetting("cookie", "private");
  client.setSetting("tvchak.profileId", "../unsafe");
  assert.equal(root.sent.length, before);
  client.setSetting("tvchak.recentSort", "added");
  assert.equal(root.sent.at(-1).data.type, "tvchak:setting");
  assert.equal(client.changeNas("http://other-nas.test:7777/web/"), true);
  assert.equal(root.sent.at(-1).data.url, "http://other-nas.test:7777");
  client.destroy();
});

test("일반 웹·신뢰하지 않는 부모·채널 없는 TV 페이지는 실행기 통신을 하지 않는다", async () => {
  for (const mode of ["web", "untrusted", "missing-token"]) {
    const root = fakeClient();
    if (mode === "web") root.TVCHAK_WEB.mode = "web";
    if (mode === "untrusted") root.location.href = root.location.href.replace(encodeURIComponent(HOST), encodeURIComponent("https://evil.test"));
    if (mode === "missing-token") root.location.href = root.location.href.replace("&host_token=" + TOKEN, "");
    const client = bridge.createClient(root);
    assert.equal(client.active, false);
    await client.start(() => ({}));
    assert.equal(root.sent.length, 0);
    assert.equal(client.changeNas("http://nas.test"), false);
  }
});

test("실제 NAS는 TizenBrew 포트만 허용하고 CDN·다른 로컬 서비스는 거부한다", () => {
  for (const [origin, active] of [["http://127.0.0.1:8081", true], [HOST, false], ["https://cdn.jsdelivr.net", false], ["null", false]]) {
    const root = fakeClient();
    root.location.href = "http://192.168.1.230:7777/web/?tv=1&host_origin=" + encodeURIComponent(origin) + "&host_token=" + TOKEN;
    assert.equal(bridge.createClient(root).active, active, origin);
  }
});

test("사이트 저장소가 차단되어도 부트 메시지는 정상 완료된다", async () => {
  const root = fakeClient();
  Object.defineProperty(root, "localStorage", { get: () => { throw new Error("storage blocked"); } });
  const client = bridge.createClient(root), pending = client.start(() => ({ screen: "home", canHandleBack: false }));
  boot(root, { "tvchak.profileId": "family" });
  await pending;
  assert.equal(root.sent.at(-1).data.type, "tvchak:state");
  assert.equal(client.getSetting("tvchak.profileId", "default"), "family");
  assert.equal(client.setSetting("tvchak.recentSort", "added"), true);
  assert.equal(client.getSetting("tvchak.recentSort", "watched"), "added");
  assert.equal(root.sent.at(-1).data.type, "tvchak:setting");
  client.destroy();
});

async function fakeLauncher(health = { ok: true, web_client: { tv_mode: true, bridge_version: 1 } }) {
  const root = fakeWindow();
  root.localStorage.setItem("tvchak.nasUrl", JSON.stringify("http://nas.test:7777"));
  root.localStorage.setItem("tvchak.recentSort", JSON.stringify("added"));
  root.fetches = [];
  root.fetch = async (url, options) => { root.fetches.push({ url, options }); return { ok: true, json: async () => health }; };
  const frame = root.document.getElementById("web-client");
  frame.sent = [];
  frame.contentWindow = { postMessage: (data, target) => frame.sent.push({ data, target }), focus: () => {} };
  const controller = launcher.createController(root);
  await controller.start();
  const deliver = (data, overrides = {}) => root.emit("message", {
    source: frame.contentWindow, origin: controller.getState().nas,
    data: { version: 1, channel: controller.getState().channel, ...data }, ...overrides,
  });
  return { root, frame, controller, deliver };
}

test("구버전 NAS는 명확한 업데이트 안내를 보여주고 iframe에 진입하지 않는다", async () => {
  const { root, frame, controller } = await fakeLauncher({ ok: true, server_version: "2.7.21" });
  assert.equal(launcher.supportsWeb({ ok: true }), false);
  assert.equal(frame.src, undefined);
  assert.equal(controller.getState().loaded, false);
  assert.match(root.document.getElementById("connection-status").textContent, /NAS 서버를 먼저 업데이트/);
});

test("서버는 준비됐지만 웹 번들이 없으면 바로 웹 배포를 안내한다", async () => {
  const { root, frame } = await fakeLauncher({ ok: true, web_client: { tv_mode: true, bridge_version: 1, ui_ready: false } });
  assert.equal(frame.src, undefined);
  assert.match(root.document.getElementById("connection-status").textContent, /NAS 웹 화면을 먼저 배포/);
});

test("실행기는 NAS TV URL을 열고 올바른 ready·state를 받은 뒤에만 표시한다", async () => {
  const { root, frame, controller, deliver } = await fakeLauncher();
  const url = new URL(frame.src);
  assert.equal(url.pathname, "/web/");
  assert.equal(url.searchParams.get("tv"), "1");
  assert.equal(url.searchParams.get("host_origin"), HOST);
  assert.equal(url.searchParams.get("host_token"), controller.getState().channel);
  assert.equal(root.fetches[0].options.cache, "no-store");
  deliver({ type: "tvchak:ready" }, { origin: "https://evil.test" });
  assert.equal(frame.sent.length, 0);
  deliver({ type: "tvchak:ready" });
  assert.equal(frame.sent[0].target, "http://nas.test:7777");
  assert.equal(frame.sent[0].data.settings["tvchak.recentSort"], "added");
  deliver({ type: "tvchak:state", state: { screen: "loading", canHandleBack: true } });
  assert.equal(controller.getState().loaded, false);
  deliver({ type: "tvchak:state", state: { screen: "home", canHandleBack: false } });
  assert.equal(controller.getState().loaded, true);
  assert.equal(frame.classList.contains("ready"), true);
  assert.equal(root.document.getElementById("connection-screen").classList.contains("hidden"), true);
});

test("홈 상단의 뒤로 가기는 플랫폼에 양보하고 내부 화면의 키는 중계한다", async () => {
  const { root, frame, deliver } = await fakeLauncher();
  deliver({ type: "tvchak:ready" });
  deliver({ type: "tvchak:state", state: { screen: "home", canHandleBack: false } });
  function key(code) { return { keyCode: code, prevented: false, preventDefault: function () { this.prevented = true; } }; }
  const back = key(27);
  root.document.emit("keydown", back);
  assert.equal(back.prevented, false);
  const arrow = key(40);
  root.document.emit("keydown", arrow);
  assert.equal(arrow.prevented, true);
  assert.equal(frame.sent.at(-1).data.keyCode, 40);
  deliver({ type: "tvchak:state", state: { screen: "detail", canHandleBack: true } });
  const hardware = { keyName: "back", preventDefault: function () { this.prevented = true; } };
  root.document.emit("tizenhwkey", hardware);
  assert.equal(hardware.prevented, true);
  assert.equal(frame.sent.at(-1).data.keyCode, 10009);
});

test("이전 iframe 연결의 메시지는 같은 NAS로 재연결해도 무시한다", async () => {
  const { frame, controller, deliver } = await fakeLauncher();
  const previous = controller.getState().channel;
  await controller.connect("http://nas.test:7777");
  assert.notEqual(controller.getState().channel, previous);
  deliver({ type: "tvchak:ready", channel: previous });
  assert.equal(frame.sent.length, 0);
  deliver({ type: "tvchak:ready" });
  assert.equal(frame.sent.length, 1);
});

test("NAS에서 받은 임의 설정은 실행기 저장소에 쓰지 않는다", async () => {
  const { root, deliver } = await fakeLauncher();
  deliver({ type: "tvchak:setting", key: "cookie", value: "secret" });
  deliver({ type: "tvchak:setting", key: "tvchak.cacheTtlHours", value: 1000 });
  assert.equal(root.localStorage.getItem("cookie"), null);
  assert.equal(root.localStorage.getItem("tvchak.cacheTtlHours"), null);
  deliver({ type: "tvchak:setting", key: "tvchak.recentSort", value: "watched" });
  assert.equal(JSON.parse(root.localStorage.getItem("tvchak.recentSort")), "watched");
});

test("앱 진입점과 NAS UI는 분리하고 TV 쿼리는 화면 초기화 후에도 유지한다", () => {
  const base = path.join(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8"));
  assert.equal(manifest.appPath, "launcher/index.html");
  assert.ok(manifest.files.includes("launcher/"));
  const html = fs.readFileSync(path.join(base, "app/index.html"), "utf8");
  assert.ok(html.indexOf('src="host-bridge.js"') < html.indexOf('src="app.js"'));
  const app = fs.readFileSync(path.join(base, "app/app.js"), "utf8");
  assert.match(app, /location\.pathname \+ location\.search \+ \(location\.hash/);
  assert.match(app, /TVChakHost\.start\(getHostState\)\.then\(startApplication\)/);
  const start = app.indexOf("  function nasUrl(");
  const end = app.indexOf("\n  }", start) + 4;
  const context = { window: { TVCHAK_WEB: { hosted: true } }, location: { origin: "http://nas.test:7777" }, STORE: { get: () => "http://old.test" }, KEYS: { NAS: "nas" } };
  vm.createContext(context);
  vm.runInContext(app.slice(start, end), context);
  assert.equal(context.nasUrl(), "http://nas.test:7777");
});
