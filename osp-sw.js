(function () {
  var CLEAR = [".nojekyll","CNAME","assets/site.css","assets/obsidian.css","assets/site.js","assets/overlay.js","assets/unlock.js","osp-sw.js"];
  var ASK_TIMEOUT = 3000;
  var SILENT_RETRY = 10000;

  function b2u(value) {
    var binary = atob(value);
    var out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  function importKey(bits) {
    return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, [
      "decrypt",
    ]);
  }

  function decrypt(key, blob) {
    return crypto.subtle
      .decrypt({ name: "AES-GCM", iv: b2u(blob.iv) }, key, b2u(blob.data))
      .then(function (plain) {
        return new Uint8Array(plain);
      });
  }

  /*
   * The type a blob URL will serve its bytes as.
   *
   * A stylesheet is refused unless it arrives as text/css and a module
   * script unless it arrives as a JavaScript type, so this is not a
   * nicety -- a typeless blob fails in exactly the two places that
   * decide whether a page renders. The extension is all there is to go
   * on once the bytes are ciphertext.
   */
  var TYPES = {
    js: "text/javascript",
    mjs: "text/javascript",
    css: "text/css",
    json: "application/json",
    map: "application/json",
    wasm: "application/wasm",
    html: "text/html",
    htm: "text/html",
    txt: "text/plain",
    xml: "application/xml",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    wav: "audio/wav",
    flac: "audio/flac",
    m4a: "audio/mp4",
    pdf: "application/pdf"
  };

  function mimeFor(path) {
    var at = String(path).lastIndexOf(".");
    var ext = at === -1 ? "" : String(path).slice(at + 1).toLowerCase();
    return TYPES[ext] || "application/octet-stream";
  }

  self.addEventListener("install", function (event) {
    event.waitUntil(self.skipWaiting());
  });

  // Claimed straight away, so the page that has just unlocked is served by
  // this worker from now on, and not only the next page it opens.
  self.addEventListener("activate", function (event) {
    event.waitUntil(self.clients.claim());
  });

  /* What each page answered: its key and its list of locked files. */
  var states = Object.create(null);
  /* Imported keys, by the bits they were made from. */
  var keys = Object.create(null);

  function scopePath() {
    return new URL(self.registration.scope).pathname;
  }

  /* A URL as a path from the root of the site, or null if it is outside. */
  function sitePathOf(url) {
    var base = scopePath();
    if (url.pathname.indexOf(base) !== 0) return null;
    try {
      return decodeURIComponent(url.pathname.slice(base.length));
    } catch (e) {
      return null;
    }
  }

  function exempt(path) {
    if (!path) return true;
    if (CLEAR.indexOf(path) !== -1) return true;
    return /\.(enc|html?|woff2?|ttf|otf|eot)$/i.test(path);
  }

  function keyFor(bits) {
    if (!keys[bits]) {
      keys[bits] = importKey(b2u(bits)).catch(function () {
        delete keys[bits];
        return null;
      });
    }
    return keys[bits];
  }

  /*
   * The answer of the page that made a request.
   *
   * A page that is still locked answers with nothing, and that is not kept:
   * it will have a key in a moment. A page that does not answer at all --
   * a page from a site published without a password, say -- is left alone
   * for a while, so it does not pay the wait on every request it makes.
   */
  function ask(clientId) {
    if (states[clientId]) return states[clientId];
    var pending = self.clients
      .get(clientId)
      .then(function (client) {
        if (!client) return { silent: true };
        return new Promise(function (resolve) {
          var channel = new MessageChannel();
          var timer = setTimeout(function () {
            resolve({ silent: true });
          }, ASK_TIMEOUT);
          channel.port1.onmessage = function (event) {
            clearTimeout(timer);
            resolve({ reply: event.data || null });
          };
          client.postMessage({ type: "osp-sw-state" }, [channel.port2]);
        });
      })
      .then(function (outcome) {
        var reply = outcome.reply;
        if (outcome.silent) {
          setTimeout(function () {
            if (states[clientId] === pending) delete states[clientId];
          }, SILENT_RETRY);
          return null;
        }
        if (!reply || !reply.bits || !reply.assets) {
          delete states[clientId];
          return null;
        }
        return keyFor(reply.bits).then(function (key) {
          if (!key) {
            delete states[clientId];
            return null;
          }
          var wanted = Object.create(null);
          for (var i = 0; i < reply.assets.length; i++) wanted[reply.assets[i]] = true;
          return { key: key, wanted: wanted };
        });
      })
      .catch(function () {
        delete states[clientId];
        return null;
      });
    states[clientId] = pending;
    return pending;
  }

  function serve(request, url, path, state) {
    return fetch(url.origin + url.pathname + ".enc", { credentials: "same-origin" })
      .then(function (response) {
        if (!response.ok) {
          return new Response(null, { status: response.status, statusText: response.statusText });
        }
        return response
          .json()
          .then(function (blob) {
            return decrypt(state.key, blob);
          })
          .then(
            function (bytes) {
              return new Response(bytes, {
                status: 200,
                headers: { "Content-Type": mimeFor(path) },
              });
            },
            // Never the ciphertext, and never a hang: a file that will not
            // decrypt is an error the page can see.
            function () {
              return new Response(null, { status: 500 });
            },
          );
      });
  }

  self.addEventListener("fetch", function (event) {
    var request = event.request;
    if (request.method !== "GET") return;
    // A navigation has no client yet. Pages go through the lock shell.
    if (!event.clientId) return;
    var url;
    try {
      url = new URL(request.url);
    } catch (e) {
      return;
    }
    if (url.origin !== self.location.origin) return;
    var path = sitePathOf(url);
    if (path === null || exempt(path)) return;

    event.respondWith(
      ask(event.clientId).then(function (state) {
        if (!state || !state.wanted[path]) return fetch(request);
        return serve(request, url, path, state);
      }),
    );
  });
})();
