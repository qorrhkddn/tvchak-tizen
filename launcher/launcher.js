/* TizenBrew에는 이 실행기만 두고 실제 화면은 NAS에서 불러온다. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("../app/host-bridge.js"));
  else {
    root.TVChakLauncher = factory(root.TVChakBridge);
    root.TVChakLauncher.createController(root).start();
  }
})(typeof window !== "undefined" ? window : this, function (bridge) {
  "use strict";

  function supportsWeb(health) {
    return !!(health && health.ok && health.web_client && health.web_client.tv_mode
      && health.web_client.bridge_version >= bridge.VERSION);
  }

  function createController(root) {
    var doc = root.document, storage = root.localStorage;
    var frame = doc.getElementById("web-client");
    var screen = doc.getElementById("connection-screen");
    var input = doc.getElementById("nas-url");
    var status = doc.getElementById("connection-status");
    var generation = 0, currentNas = "", channel = "", loaded = false;
    var readyTimer = null, canHandleBack = true;

    function showStatus(message, error) {
      status.textContent = message;
      status.setAttribute("data-error", String(!!error));
      screen.classList.remove("hidden");
      frame.classList.remove("ready");
    }

    function send(type, values) {
      if (!currentNas) return;
      var data = { type: type, version: bridge.VERSION, channel: channel };
      Object.keys(values || {}).forEach(function (key) { data[key] = values[key]; });
      frame.contentWindow.postMessage(data, currentNas);
    }

    function requestHealth(nas) {
      return new Promise(function (resolve, reject) {
        var done = false;
        var controller = root.AbortController ? new root.AbortController() : null;
        var timer = root.setTimeout(function () {
          if (done) return;
          done = true;
          if (controller) controller.abort();
          reject(new Error("NAS 응답 시간이 초과되었습니다."));
        }, 4000);
        var options = { cache: "no-store" };
        if (controller) options.signal = controller.signal;
        root.fetch(nas + "/healthz", options).then(function (response) {
          if (!response.ok) throw new Error("NAS 연결 실패: HTTP " + response.status);
          return response.json();
        }).then(function (health) {
          if (done) return;
          done = true;
          root.clearTimeout(timer);
          resolve(health);
        }).catch(function (error) {
          if (done) return;
          done = true;
          root.clearTimeout(timer);
          reject(error);
        });
      });
    }

    function connect(value) {
      var token = ++generation;
      loaded = false;
      currentNas = "";
      root.clearTimeout(readyTimer);
      var nas;
      try { nas = bridge.normalizeNas(value); }
      catch (error) { showStatus(error.message, true); return Promise.reject(error); }
      input.value = nas;
      showStatus("NAS 연결을 확인합니다…", false);
      return requestHealth(nas).then(function (health) {
        if (token !== generation) return;
        if (!supportsWeb(health)) {
          var upgrade = new Error("NAS 서버를 먼저 업데이트하세요. 최초 한 번 ./deploy와 ./deploy --web 실행이 필요합니다.");
          upgrade.upgradeRequired = true;
          throw upgrade;
        }
        if (health.web_client.ui_ready === false) {
          var missing = new Error("NAS 웹 화면을 먼저 배포하세요. ./deploy --web 실행 후 다시 연결하세요.");
          missing.upgradeRequired = true;
          throw missing;
        }
        currentNas = nas;
        channel = ("0000000000000000" + Date.now().toString(16) + generation.toString(16)
          + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)).slice(-64);
        canHandleBack = true;
        var origin = root.location.origin || "null";
        frame.src = nas + "/web/?tv=1&host_origin=" + encodeURIComponent(origin)
          + "&host_token=" + channel + "&_=" + Date.now();
        showStatus("NAS에서 TV 화면을 불러옵니다…", false);
        readyTimer = root.setTimeout(function () {
          if (token !== generation || loaded) return;
          showStatus("NAS 웹을 불러오지 못했습니다. ./deploy --web 실행 후 다시 연결하세요.", true);
          doc.getElementById("connect").focus();
        }, 15000);
      }).catch(function (error) {
        if (token === generation) showStatus(error.message || "NAS에 연결하지 못했습니다.", true);
        throw error;
      });
    }

    function onMessage(event) {
      var data = event.data;
      if (!currentNas || event.source !== frame.contentWindow || event.origin !== currentNas
          || !data || data.version !== bridge.VERSION || data.channel !== channel) return;
      if (data.type === "tvchak:ready") {
        send("tvchak:boot", { settings: bridge.readSettings(storage) });
      } else if (data.type === "tvchak:state" && data.state && typeof data.state.canHandleBack === "boolean") {
        canHandleBack = data.state.canHandleBack;
        if (["home", "detail", "player", "settings"].indexOf(data.state.screen) < 0 || loaded) return;
        loaded = true;
        root.clearTimeout(readyTimer);
        try { storage.setItem("tvchak.nasUrl", JSON.stringify(currentNas)); } catch (_) {}
        frame.classList.add("ready");
        screen.classList.add("hidden");
        frame.focus();
        try { frame.contentWindow.focus(); } catch (_) {}
      } else if (data.type === "tvchak:setting" && bridge.validSetting(data.key, data.value)) {
        try { storage.setItem(data.key, JSON.stringify(data.value)); } catch (_) {}
      } else if (data.type === "tvchak:nas") {
        connect(data.url).catch(function () {});
      }
    }

    function isBack(code) { return code === 8 || code === 27 || code === 10009; }

    function onKey(event) {
      var code = event.keyCode;
      if (!loaded) {
        if (doc.activeElement === input) {
          if (code === 13) {
            connect(input.value).catch(function () {});
            event.preventDefault();
          } else if (code === 38 || code === 40 || isBack(code)) {
            input.blur();
            doc.getElementById("connect").focus();
            event.preventDefault();
          }
          return;
        }
        if (code === 37 || code === 38 || code === 39 || code === 40) {
          var controls = [input, doc.getElementById("connect"), doc.getElementById("change-address")];
          var index = controls.indexOf(doc.activeElement);
          controls[(index + (code === 37 || code === 38 ? controls.length - 1 : 1)) % controls.length].focus();
          event.preventDefault();
        }
        return;
      }
      if (bridge.KEY_CODES.indexOf(code) < 0 || (isBack(code) && !canHandleBack)) return;
      send("tvchak:key", { keyCode: code });
      event.preventDefault();
    }

    function onHardwareKey(event) {
      if (event.keyName !== "back" || !loaded || !canHandleBack) return;
      send("tvchak:key", { keyCode: 10009 });
      event.preventDefault();
    }

    function start() {
      root.addEventListener("message", onMessage);
      doc.addEventListener("keydown", onKey);
      doc.addEventListener("tizenhwkey", onHardwareKey);
      try {
        if (root.tizen && root.tizen.tvinputdevice) {
          ["ColorF0Red", "ColorF1Green", "ColorF2Yellow", "ColorF3Blue", "MediaPlayPause", "MediaPlay",
           "MediaPause", "MediaStop", "MediaFastForward", "MediaRewind", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]
            .forEach(function (key) { try { root.tizen.tvinputdevice.registerKey(key); } catch (_) {} });
        }
      } catch (_) {}
      doc.getElementById("connection-form").addEventListener("submit", function (event) {
        event.preventDefault();
        connect(input.value).catch(function () {});
      });
      doc.getElementById("change-address").addEventListener("click", function () {
        generation++;
        currentNas = "";
        loaded = false;
        root.clearTimeout(readyTimer);
        frame.removeAttribute("src");
        showStatus("NAS 주소를 수정한 뒤 연결을 누르세요.", false);
        input.focus();
      });
      var saved = "";
      try { saved = JSON.parse(storage.getItem("tvchak.nasUrl")) || ""; } catch (_) {}
      var candidates = saved ? [saved] : ["http://ramel.local:7777", "http://192.168.1.230:7777", "http://192.168.1.240:7777"];
      input.value = candidates[0];
      function attempt(index) {
        var token = generation + 1;
        return connect(candidates[index]).catch(function (error) {
          if (token !== generation) return;
          if (!error.upgradeRequired && index + 1 < candidates.length) return attempt(index + 1);
          doc.getElementById("connect").focus();
        });
      }
      return attempt(0);
    }

    return { start: start, connect: connect,
      getState: function () { return { nas: currentNas, channel: channel, loaded: loaded, canHandleBack: canHandleBack }; } };
  }

  return { supportsWeb: supportsWeb, createController: createController };
});
