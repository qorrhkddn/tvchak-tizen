/* NAS 웹과 TV 실행기 사이의 제한된 키·설정 전달. */
(function (root, factory) {
  var bridge = factory();
  if (typeof module === "object" && module.exports) module.exports = bridge;
  else {
    root.TVChakBridge = bridge;
    root.TVChakHost = bridge.createClient(root);
  }
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  var VERSION = 1;
  var SETTINGS = ["tvchak.profileId", "tvchak.recentSort", "tvchak.fitMode", "tvchak.cacheTtlHours"];
  var KEY_CODES = [8, 13, 19, 27, 37, 38, 39, 40, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57,
                   403, 404, 405, 406, 412, 413, 415, 417, 10009, 10252];

  function normalizeNas(value) {
    value = String(value || "").trim();
    if (!value) throw new Error("NAS 주소를 입력하세요.");
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = "http://" + value;
    var url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw new Error("인증 정보 없는 http 또는 https NAS 주소를 입력하세요.");
    }
    return url.origin;
  }

  function validSetting(key, value) {
    if (key === "tvchak.profileId") return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
    if (key === "tvchak.recentSort") return value === "watched" || value === "added";
    if (key === "tvchak.fitMode") return ["contain", "cover", "fill", "none"].indexOf(value) >= 0;
    if (key === "tvchak.cacheTtlHours") return typeof value === "number" && isFinite(value) && value >= 1 && value <= 168;
    return false;
  }

  function readSettings(storage) {
    var settings = {};
    SETTINGS.forEach(function (key) {
      try {
        var value = JSON.parse(storage.getItem(key));
        if (validSetting(key, value)) settings[key] = value;
      } catch (_) {}
    });
    return settings;
  }

  function importSettings(storage, settings) {
    SETTINGS.forEach(function (key) {
      if (!settings || !validSetting(key, settings[key])) return;
      try {
        if (storage.getItem(key) == null) storage.setItem(key, JSON.stringify(settings[key]));
      } catch (_) {}
    });
  }

  function queryValue(href, key) {
    var query = String(href).split("?")[1] || "";
    var pairs = query.split("#")[0].split("&");
    for (var i = 0; i < pairs.length; i++) {
      var at = pairs[i].indexOf("=");
      if (at < 0) continue;
      if (decodeURIComponent(pairs[i].slice(0, at)) === key) return decodeURIComponent(pairs[i].slice(at + 1));
    }
    return "";
  }

  function parentOrigin(root) {
    if (!root.TVCHAK_WEB || root.TVCHAK_WEB.mode !== "tv" || root.parent === root) return null;
    try {
      var origin = queryValue(root.location.href, "host_origin");
      var url = new URL(origin);
      if (url.origin !== origin || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
      if (origin === "http://127.0.0.1:8081" || origin === "http://localhost:8081") return origin;
      // 다른 포트는 NAS도 루프백인 로컬 통합 테스트에서만 허용한다.
      var here = new URL(root.location.href);
      var loopback = ["127.0.0.1", "localhost", "[::1]"];
      if (loopback.indexOf(here.hostname) >= 0 && loopback.indexOf(url.hostname) >= 0) return origin;
      return null;
    } catch (_) { return null; }
  }

  function createClient(root) {
    var origin = parentOrigin(root);
    var channel = "";
    try { channel = queryValue(root.location.href, "host_token"); } catch (_) {}
    if (!/^[a-f0-9]{16,128}$/.test(channel)) origin = null;
    var started = false, booted = false, settled = false;
    var settingsCache = {};
    var timer = null, observer = null, resolveReady = null, stateReader = null;
    var ready = null;

    function send(type, data) {
      if (!origin) return;
      var message = { type: type, version: VERSION, channel: channel };
      Object.keys(data || {}).forEach(function (key) { message[key] = data[key]; });
      root.parent.postMessage(message, origin);
    }

    function notifyState() {
      if (!booted || !stateReader) return;
      try { send("tvchak:state", { state: stateReader() }); } catch (_) {}
    }

    function finish() {
      if (settled) return;
      settled = true;
      root.clearTimeout(timer);
      if (resolveReady) resolveReady();
    }

    function onMessage(event) {
      var data = event.data;
      if (!origin || event.source !== root.parent || event.origin !== origin || !data
          || data.version !== VERSION || data.channel !== channel) return;
      if (data.type === "tvchak:boot" && !settled) {
        SETTINGS.forEach(function (key) {
          if (data.settings && validSetting(key, data.settings[key])) settingsCache[key] = data.settings[key];
        });
        try {
          importSettings(root.localStorage, data.settings);
          var stored = readSettings(root.localStorage);
          Object.keys(stored).forEach(function (key) { settingsCache[key] = stored[key]; });
        } catch (_) {}
        booted = true;
        finish();
        Object.keys(settingsCache).forEach(function (key) {
          send("tvchak:setting", { key: key, value: settingsCache[key] });
        });
        notifyState();
        return;
      }
      if (data.type !== "tvchak:key" || !booted || KEY_CODES.indexOf(data.keyCode) < 0) return;
      var key;
      try {
        key = new root.KeyboardEvent("keydown", { keyCode: data.keyCode, which: data.keyCode, bubbles: true, cancelable: true });
        if (key.keyCode !== data.keyCode) {
          Object.defineProperty(key, "keyCode", { get: function () { return data.keyCode; } });
          Object.defineProperty(key, "which", { get: function () { return data.keyCode; } });
        }
      } catch (_) {
        key = root.document.createEvent("Event");
        key.initEvent("keydown", true, true);
        key.keyCode = data.keyCode;
        key.which = data.keyCode;
      }
      root.document.dispatchEvent(key);
      notifyState();
    }

    function start(getState) {
      if (ready) return ready;
      stateReader = getState;
      ready = new Promise(function (resolve) {
        resolveReady = resolve;
        if (!origin) { finish(); return; }
        started = true;
        root.addEventListener("message", onMessage);
        root.document.addEventListener("click", notifyState);
        root.document.addEventListener("keydown", notifyState);
        root.document.addEventListener("tizenhwkey", notifyState);
        if (root.MutationObserver) {
          observer = new root.MutationObserver(notifyState);
          var app = root.document.getElementById("app");
          if (app) observer.observe(app, { attributes: true, subtree: true, attributeFilter: ["class"] });
        }
        timer = root.setTimeout(finish, 2000);
        send("tvchak:ready", {});
      });
      return ready;
    }

    return {
      active: !!origin,
      start: start,
      notifyState: notifyState,
      getSetting: function (key, fallback) {
        return validSetting(key, settingsCache[key]) ? settingsCache[key] : fallback;
      },
      setSetting: function (key, value) {
        if (!validSetting(key, value)) return false;
        settingsCache[key] = value;
        if (booted) send("tvchak:setting", { key: key, value: value });
        return true;
      },
      changeNas: function (value) {
        if (!booted) return false;
        send("tvchak:nas", { url: normalizeNas(value) });
        return true;
      },
      destroy: function () {
        finish();
        if (observer) observer.disconnect();
        if (!started) return;
        root.removeEventListener("message", onMessage);
        root.document.removeEventListener("click", notifyState);
        root.document.removeEventListener("keydown", notifyState);
        root.document.removeEventListener("tizenhwkey", notifyState);
      },
    };
  }

  return { VERSION: VERSION, SETTINGS: SETTINGS, KEY_CODES: KEY_CODES,
           normalizeNas: normalizeNas, validSetting: validSetting, readSettings: readSettings,
           importSettings: importSettings, createClient: createClient };
});
