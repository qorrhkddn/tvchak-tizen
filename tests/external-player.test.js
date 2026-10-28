const test = require("node:test");
const assert = require("node:assert/strict");
const external = require("../app/external-player.js");

const episodes = [
  { name: "극장판 특별편", episode: 0, play_url: "/special" },
  { name: "제12화 원본", episode: 12, play_url: "/twelve" },
];
const mediaUrl = "http://ramel.local:7777/api/proxy/stream?u=abc";
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const pending = [];
  const records = [];
  const changes = [];
  let current = { detailUrl: "/detail", title: "작품", episodes };
  const api = {
    getExternalEpisodes: () => current,
    prepareExternalPlayback: playUrl => {
      const request = deferred();
      pending.push({ playUrl, ...request });
      return request.promise;
    },
    recordExternalPlayback: (playUrl, detailUrl) => {
      records.push({ playUrl, detailUrl });
      return true;
    },
  };
  const session = external.createSession(api, state => changes.push(state));
  return { session, pending, records, changes, setCurrent: value => { current = value; } };
}
function ready(playUrl) {
  return { url: mediaUrl, detailUrl: "/detail", episode: { play_url: playUrl, name: "원본" } };
}

test("원본 회차 이름과 배열 순서만 표시하며 임의 번호를 만들지 않는다", () => {
  const { session, pending } = fixture();
  assert.equal(session.open("nplayer"), true);
  assert.deepEqual(session.getState().episodes.map(ep => ep.name), ["극장판 특별편", "제12화 원본"]);
  assert.deepEqual(session.getState().episodes.map(ep => ep.play_url), ["/special", "/twelve"]);
  assert.equal(session.select("/not-in-detail") instanceof Promise, true);
  assert.equal(pending.length, 0);
  assert.equal(session.getState().phase, "choose");
});

test("A 다음 B를 선택하면 늦게 도착한 A 응답을 무시한다", async () => {
  const { session, pending, records } = fixture();
  session.open("copy");
  const a = session.select("/special");
  const b = session.select("/twelve");
  assert.deepEqual(pending.map(request => request.playUrl), ["/special", "/twelve"]);
  pending[1].resolve(ready("/twelve"));
  assert.equal(await b, true);
  assert.equal(session.getState().ready.episode.play_url, "/twelve");
  pending[0].resolve(ready("/special"));
  assert.equal(await a, false);
  assert.equal(session.getState().ready.episode.play_url, "/twelve");
  assert.deepEqual(records, []);
});

test("모달을 닫은 뒤 응답이 오더라도 외부 주소를 다시 노출하지 않는다", async () => {
  const { session, pending } = fixture();
  session.open();
  const request = session.select("/special");
  session.close();
  pending[0].resolve(ready("/special"));
  assert.equal(await request, false);
  assert.equal(session.getState().phase, "closed");
  assert.equal(session.getState().ready, null);
  assert.equal(session.recordOpen(), false);
});

test("다른 상세 화면으로 이동하거나 정보가 사라지면 기존 요청과 링크를 무효화한다", async () => {
  const f = fixture();
  f.session.open();
  const request = f.session.select("/special");
  f.setCurrent({ detailUrl: "/other", episodes });
  f.pending[0].resolve(ready("/special"));
  assert.equal(await request, false);
  assert.equal(f.session.getState().phase, "closed");
  assert.equal(f.records.length, 0);

  f.setCurrent({ detailUrl: "/detail", episodes });
  f.session.open();
  const second = f.session.select("/special");
  f.pending[1].resolve(ready("/special"));
  assert.equal(await second, true);
  f.setCurrent(null);
  assert.equal(f.session.recordOpen(), false);
  assert.equal(f.session.getState().phase, "closed");
});

test("준비 및 주소 복사 선택은 기록하지 않고 실제 열기 시도에서만 기록한다", async () => {
  const { session, pending, records } = fixture();
  session.open("copy");
  const request = session.select("/special");
  assert.deepEqual(records, []);
  pending[0].resolve(ready("/special"));
  assert.equal(await request, true);
  assert.deepEqual(records, []);
  assert.equal(session.getState().ready.href, "nplayer-" + mediaUrl);
  assert.equal(session.recordOpen(), true);
  assert.deepEqual(records, [{ playUrl: "/special", detailUrl: "/detail" }]);
});

test("준비 응답의 URL·원본 회차·상세 정보가 맞지 않으면 열 수 없다", async () => {
  const f = fixture();
  f.session.open();
  const request = f.session.select("/special");
  f.pending[0].resolve({ ...ready("/special"), url: "file:///secret" });
  assert.equal(await request, false);
  assert.equal(f.session.getState().phase, "error");
  assert.equal(f.session.recordOpen(), false);

  const retry = f.session.select("/special");
  f.pending[1].resolve({ ...ready("/special"), episode: { play_url: "/twelve" } });
  assert.equal(await retry, false);
  assert.equal(f.session.getState().ready, null);
  assert.deepEqual(f.records, []);
});

test("nPlayer URL은 HTTP(S) 절대주소만 허용하고 사용자 인증 정보를 거부한다", () => {
  assert.equal(external.toNPlayerUrl("http://nas.local:7777/video?x=1"),
    "nplayer-http://nas.local:7777/video?x=1");
  assert.equal(external.toNPlayerUrl("https://nas.local/video"), "nplayer-https://nas.local/video");
  for (const value of ["/video", "javascript:alert(1)", "file:///video", "ftp://nas.local/v",
    "http://user@nas.local/video", "https://user:password@nas.local/video",
    " https://nas.local/video", "https://nas.local/video ", "https://", "http://[invalid"] ) {
    assert.equal(external.toNPlayerUrl(value), null, value);
  }
});

function fakeDocument(copyResult) {
  const body = {
    appendChild(input) { input.parent = this; },
    removeChild(input) { assert.equal(input.parent, this); input.parent = null; },
  };
  const doc = {
    body,
    activeElement: { focus() { doc.restored = true; } },
    createElement(tag) {
      assert.equal(tag, "textarea");
      return { style: {}, setAttribute() {}, focus() { doc.focused = true; },
        select() { doc.selected = true; } };
    },
    execCommand(name) { assert.equal(name, "copy"); doc.commands++; return copyResult; },
    commands: 0,
  };
  return doc;
}

test("LAN HTTP 복사는 탭 안에서 동기적 execCommand를 사용하고 포커스를 돌린다", async () => {
  const doc = fakeDocument(true);
  let clipboardCalled = 0;
  const root = { location: { protocol: "http:" }, document: doc,
    navigator: { clipboard: { writeText: () => { clipboardCalled++; } } } };
  const result = external.copyText(mediaUrl, root);
  assert.equal(doc.commands, 1);
  assert.equal(doc.focused, true);
  assert.equal(doc.selected, true);
  assert.equal(doc.restored, true);
  assert.equal(clipboardCalled, 0);
  assert.equal(await result, true);
});

test("열린 native dialog 안에 임시 복사 필드를 넣어 inert body를 피한다", async () => {
  const doc = fakeDocument(false);
  const panel = {
    input: null,
    appendChild(input) { this.input = input; input.parent = this; },
    removeChild(input) { assert.equal(this.input, input); this.input = null; input.parent = null; },
  };
  doc.querySelector = selector => {
    assert.equal(selector, ".external-player-dialog[open] .external-player-panel");
    return panel;
  };
  doc.body.appendChild = () => { throw new Error("모달 바깥 body는 inert"); };
  doc.execCommand = name => {
    assert.equal(name, "copy");
    assert.equal(panel.input.parent, panel);
    assert.equal(panel.input.value, mediaUrl);
    return true;
  };
  const result = external.copyText(mediaUrl, {
    location: { protocol: "http:" }, navigator: {}, document: doc,
  });
  assert.equal(panel.input, null);
  assert.equal(doc.restored, true);
  assert.equal(await result, true);
});

test("HTTPS에서는 Clipboard API 우선, 거부되면 execCommand, 둘 다 실패하면 수동 복사", async () => {
  const doc = fakeDocument(true);
  const root = { location: { protocol: "https:" }, document: doc,
    navigator: { clipboard: { writeText: text => {
      assert.equal(text, mediaUrl);
      return Promise.resolve();
    } } } };
  assert.equal(await external.copyText(mediaUrl, root), true);
  assert.equal(doc.commands, 0);
  root.navigator.clipboard.writeText = () => Promise.reject(new Error("권한 없음"));
  assert.equal(await external.copyText(mediaUrl, root), true);
  assert.equal(doc.commands, 1);
  root.location.protocol = "http:";
  doc.execCommand = () => false;
  assert.equal(await external.copyText(mediaUrl, root), false);
});

test("iPhone/iPod/iPad와 터치 Mac에서만 활성화하고 TV 모드는 항상 비활성화한다", () => {
  const root = { document: {}, navigator: { userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)" } };
  assert.equal(external.isEligible(root), true);
  root.navigator.userAgent = "Mozilla/5.0 (iPod touch; CPU iPhone OS 16_0)";
  assert.equal(external.isEligible(root), true);
  root.navigator.userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)";
  assert.equal(external.isEligible(root), true);
  root.navigator.userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)";
  root.navigator.maxTouchPoints = 5;
  assert.equal(external.isEligible(root), true);
  root.navigator.maxTouchPoints = 0;
  assert.equal(external.isEligible(root), false);
  root.navigator.userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
  root.navigator.maxTouchPoints = 10;
  assert.equal(external.isEligible(root), false);
  root.navigator.userAgent = "Mozilla/5.0 (iPad; CPU OS 17_0)";
  root.TVCHAK_WEB = { mode: "tv" };
  assert.equal(external.isEligible(root), false);
  assert.equal(external.init(root), null);
});
