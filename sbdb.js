/*
 * Camada de dados do sistema sobre o Supabase (REST + login).
 * Oferece a mesma interface que o sistema já usava (collection/doc/where/orderBy/onSnapshot...),
 * para que as telas não precisem mudar.
 * Atualização em tempo quase real: a cada poucos segundos o sistema consulta a tabela
 * collection_versions (pequena) e só recarrega as listas que mudaram.
 */
(function () {
  "use strict";
  var cfg = window.APP_CONFIG || {};
  var BASE = String(cfg.SUPABASE_URL || "").replace(/\/+$/, "");
  var KEY = cfg.SUPABASE_ANON_KEY || "";
  var DOMAIN = cfg.LOGIN_DOMAIN || "tropical.local";
  var POLL_MS = cfg.POLL_MS || 5000;
  var SKEY = "tropical_session_v1";
  var session = null;

  function mkErr(code, message, extra) {
    var e = new Error(message || code);
    e.code = code;
    if (extra) for (var k in extra) e[k] = extra[k];
    return e;
  }
  function loadSession() {
    try { session = JSON.parse(localStorage.getItem(SKEY) || "null"); } catch (e) { session = null; }
  }
  function saveSession(s) {
    session = s;
    try { if (s) localStorage.setItem(SKEY, JSON.stringify(s)); else localStorage.removeItem(SKEY); } catch (e) {}
  }
  function toSession(r) {
    return {
      access_token: r.access_token,
      refresh_token: r.refresh_token,
      expires_at: r.expires_at ? r.expires_at * 1000 : Date.now() + (r.expires_in || 3600) * 1000,
      user: r.user || (session && session.user) || null
    };
  }
  function loginToEmail(login) {
    login = String(login || "").trim().toLowerCase();
    return login.indexOf("@") >= 0 ? login : login + "@" + DOMAIN;
  }
  function parseBody(res) {
    return res.text().then(function (t) {
      if (!t) return null;
      try { return JSON.parse(t); } catch (e) { return t; }
    });
  }

  // ---------------- AUTENTICAÇÃO ----------------
  function authCall(path, method, body, useToken) {
    var h = { "apikey": KEY, "Content-Type": "application/json" };
    if (useToken && session) h["Authorization"] = "Bearer " + session.access_token;
    return fetch(BASE + "/auth/v1/" + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) {
        return parseBody(res).then(function (b) {
          if (!res.ok) {
            var msg = (b && (b.error_description || b.msg || b.message || b.error)) || ("Erro " + res.status);
            throw mkErr(res.status === 400 || res.status === 401 ? "auth_failed" : "unavailable", msg, { status: res.status });
          }
          return b;
        });
      }, function () { throw mkErr("unavailable", "Sem conexão com o servidor"); });
  }
  var refreshing = null;
  function refreshSession() {
    if (!session || !session.refresh_token) return Promise.reject(mkErr("auth_required", "Sessão expirada"));
    if (refreshing) return refreshing;
    refreshing = authCall("token?grant_type=refresh_token", "POST", { refresh_token: session.refresh_token })
      .then(function (r) { saveSession(toSession(r)); refreshing = null; return session; },
            function (e) { refreshing = null; if (e.code === "auth_failed") { saveSession(null); fire("signedOut"); } throw e; });
    return refreshing;
  }
  function ensureFresh() {
    if (!session) return Promise.reject(mkErr("auth_required", "Faça login"));
    if (session.expires_at - Date.now() < 60000) return refreshSession();
    return Promise.resolve(session);
  }
  var listeners = { signedOut: [] };
  function fire(ev) { (listeners[ev] || []).forEach(function (fn) { try { fn(); } catch (e) {} }); }

  var auth = {
    hasSession: function () { return !!session; },
    user: function () { return session ? session.user : null; },
    signIn: function (login, password) {
      return authCall("token?grant_type=password", "POST", { email: loginToEmail(login), password: password })
        .then(function (r) { saveSession(toSession(r)); return session.user; }, function (e) {
          if (e.code === "auth_failed") throw mkErr("auth_failed", "Usuário ou senha incorretos");
          throw e;
        });
    },
    // Confirma que a sessão salva ainda vale (e renova o token se preciso)
    restore: function () {
      if (!session) return Promise.resolve(null);
      return ensureFresh().then(function () { return authCall("user", "GET", null, true); })
        .then(function (u) { session.user = u; saveSession(session); return u; },
              function (e) { if (e.code !== "unavailable") saveSession(null); throw e; });
    },
    changePassword: function (pw) {
      return ensureFresh().then(function () { return authCall("user", "PUT", { password: pw }, true); });
    },
    signOut: function () {
      var p = session ? authCall("logout", "POST", {}, true).catch(function () {}) : Promise.resolve();
      return p.then(function () { saveSession(null); stopPolling(); });
    },
    onSignedOut: function (fn) { listeners.signedOut.push(fn); }
  };

  // ---------------- REST ----------------
  function rest(method, path, body, extraHeaders, retried) {
    return ensureFresh().then(function () {
      var h = { "apikey": KEY, "Authorization": "Bearer " + session.access_token, "Content-Type": "application/json" };
      if (extraHeaders) for (var k in extraHeaders) h[k] = extraHeaders[k];
      return fetch(BASE + "/rest/v1/" + path, { method: method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined })
        .then(null, function () { throw mkErr("unavailable", "Sem conexão com o servidor"); });
    }).then(function (res) {
      if (res.status === 401 && !retried) {
        return refreshSession().then(function () { return rest(method, path, body, extraHeaders, true); });
      }
      return parseBody(res).then(function (b) {
        if (!res.ok) {
          var msg = (b && (b.message || b.hint || b.details)) || ("Erro " + res.status);
          var code = "unavailable";
          if (res.status === 401 || res.status === 403 || (b && b.code === "42501")) { code = "permission_denied"; msg = "Sem permissão para esta ação (" + msg + ")"; }
          else if (res.status === 400 || res.status === 404 || res.status === 409 || (b && /^(P0|22|23)/.test(b.code || ""))) code = "invalid_argument";
          throw mkErr(code, msg, { status: res.status });
        }
        return b;
      });
    });
  }
  function enc(v) { return encodeURIComponent(v); }
  function rpc(fn, args) { return rest("POST", "rpc/" + fn, args || {}); }

  // ---------------- DOCUMENTOS ----------------
  function randomId() {
    var a = "abcdefghijklmnopqrstuvwxyz0123456789", s = "";
    var buf = new Uint8Array(20);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    for (var i = 0; i < 20; i++) s += a[buf[i] % a.length];
    return s;
  }
  function split(path) { return String(path).split("/").filter(function (x) { return x !== ""; }); }
  function freeze(o) { return o; }
  function mkDocSnap(id, data) {
    return { id: id, exists: data !== undefined, data: function () { return data; }, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function mkQuerySnap(docs) {
    return {
      docs: docs, size: docs.length, empty: docs.length === 0,
      docChanges: function () { return docs.map(function (d, i) { return { type: "added", doc: d, oldIndex: -1, newIndex: i }; }); },
      metadata: { fromCache: false, hasPendingWrites: false }
    };
  }

  var OPS = { "==": "eq", "!=": "neq", "<": "lt", "<=": "lte", ">": "gt", ">=": "gte" };
  function getField(obj, f) { return obj ? obj[f] : undefined; }
  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function testFilter(data, f) {
    var v = getField(data, f[0]), op = f[1], w = f[2];
    switch (op) {
      case "==": return v === w;
      case "!=": return v !== undefined && v !== w;
      case "<": return v !== undefined && v < w;
      case "<=": return v !== undefined && v <= w;
      case ">": return v !== undefined && v > w;
      case ">=": return v !== undefined && v >= w;
      case "in": return Array.isArray(w) && w.indexOf(v) >= 0;
      case "not-in": return Array.isArray(w) && v !== undefined && w.indexOf(v) < 0;
      case "array-contains": return Array.isArray(v) && v.indexOf(w) >= 0;
    }
    return false;
  }

  function fetchCollection(col, filters, order, limit) {
    var params = ["select=id,data", "collection=eq." + enc(col)];
    var clientFilters = [];
    (filters || []).forEach(function (f) {
      if (typeof f[2] === "string" && OPS[f[1]]) params.push(enc("data->>" + f[0]) + "=" + OPS[f[1]] + "." + enc(f[2]));
      else clientFilters.push(f);
    });
    if (order) params.push("order=" + enc("data->" + order.field) + "." + (order.dir === "desc" ? "desc" : "asc") + ".nullslast");
    else params.push("order=id.asc");
    if (limit && !clientFilters.length) params.push("limit=" + limit);
    return rest("GET", "docs?" + params.join("&")).then(function (rows) {
      rows = rows || [];
      if (clientFilters.length) rows = rows.filter(function (r) { return clientFilters.every(function (f) { return testFilter(r.data, f); }); });
      if (limit && clientFilters.length) rows = rows.slice(0, limit);
      return mkQuerySnap(rows.map(function (r) { return mkDocSnap(r.id, freeze(r.data)); }));
    });
  }
  function fetchDoc(col, id) {
    return rest("GET", "docs?select=id,data&collection=eq." + enc(col) + "&id=eq." + enc(id)).then(function (rows) {
      return mkDocSnap(id, rows && rows.length ? rows[0].data : undefined);
    });
  }

  // ---------------- ATUALIZAÇÃO AUTOMÁTICA ----------------
  var subs = [];            // {col, run, lastVersion, active}
  var versions = {};        // coleção -> versão conhecida
  var pollTimer = null, pollInFlight = false, pollAgain = false;

  function pollNow() {
    if (!session) return;
    if (pollInFlight) { pollAgain = true; return; }
    pollInFlight = true;
    rest("GET", "collection_versions?select=collection,version").then(function (rows) {
      (rows || []).forEach(function (r) { versions[r.collection] = r.version; });
      subs.forEach(function (s) {
        if (!s.active) return;
        var v = versions[s.col] || 0;
        if (s.lastVersion !== v) { s.lastVersion = v; s.run(); }
      });
    }).catch(function () {}).then(function () {
      pollInFlight = false;
      if (pollAgain) { pollAgain = false; setTimeout(pollNow, 50); }
    });
  }
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () { if (!document.hidden) pollNow(); }, POLL_MS);
  }
  function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; subs = []; versions = {}; }
  document.addEventListener("visibilitychange", function () { if (!document.hidden) pollNow(); });
  var soonTimer = null;
  function pollSoon() { clearTimeout(soonTimer); soonTimer = setTimeout(pollNow, 150); }

  function subscribe(col, fetcher, next, error) {
    var s = { col: col, lastVersion: versions[col] || 0, active: true, run: null };
    s.run = function () {
      fetcher().then(function (snap) { if (s.active) next(snap); }, function (e) {
        if (!s.active) return;
        if (e && e.code === "permission_denied" && error) error(e);
      });
    };
    subs.push(s);
    s.run();
    startPolling();
    return function () { s.active = false; subs = subs.filter(function (x) { return x !== s; }); };
  }

  // ---------------- API (mesma forma usada pelas telas) ----------------
  function Query(col, filters, order, lim) {
    this._col = col; this._filters = filters || []; this._order = order || null; this._limit = lim || 0;
  }
  Query.prototype.where = function (f, op, v) { return new Query(this._col, this._filters.concat([[f, op, v]]), this._order, this._limit); };
  Query.prototype.orderBy = function (f, dir) { return new Query(this._col, this._filters, { field: f, dir: dir || "asc" }, this._limit); };
  Query.prototype.limit = function (n) { return new Query(this._col, this._filters, this._order, n); };
  Query.prototype.get = function () { return fetchCollection(this._col, this._filters, this._order, this._limit); };
  Query.prototype.onSnapshot = function (next, error) {
    var q = this;
    return subscribe(q._col, function () { return q.get(); }, next, error);
  };

  function CollectionRef(path) { Query.call(this, path); this.path = path; }
  CollectionRef.prototype = Object.create(Query.prototype);
  CollectionRef.prototype.doc = function (id) { return new DocRef(this.path, id || randomId()); };
  CollectionRef.prototype.add = function (data) {
    var ref = this.doc();
    return ref.set(data).then(function () { return ref; });
  };

  function DocRef(col, id) { this._col = col; this.id = id; this.path = col + "/" + id; }
  DocRef.prototype.get = function () { return fetchDoc(this._col, this.id); };
  DocRef.prototype.set = function (data) {
    var col = this._col;
    return rest("POST", "docs", { collection: col, id: this.id, data: data || {} },
      { "Prefer": "resolution=merge-duplicates,return=minimal" }).then(function () { pollSoon(); });
  };
  DocRef.prototype.update = function (patch) {
    return rpc("doc_merge", { p_collection: this._col, p_id: this.id, p_patch: patch || {} }).then(function () { pollSoon(); });
  };
  DocRef.prototype["delete"] = function () {
    return rest("DELETE", "docs?collection=eq." + enc(this._col) + "&id=eq." + enc(this.id), undefined,
      { "Prefer": "return=minimal" }).then(function () { pollSoon(); });
  };
  DocRef.prototype.acquire = function () { return Promise.resolve({ acquired: true }); };
  DocRef.prototype.onSnapshot = function (next, error) {
    var ref = this;
    return subscribe(ref._col, function () { return ref.get(); }, next, error);
  };
  DocRef.prototype.collection = function (sub) { return new CollectionRef(this.path + "/" + sub); };

  var db = {
    collection: function (path) {
      var p = split(path);
      if (p.length % 2 !== 1) throw new TypeError("Caminho de coleção inválido: " + path);
      return new CollectionRef(p.join("/"));
    },
    doc: function (path) {
      var p = split(path);
      if (p.length % 2 !== 0 || !p.length) throw new TypeError("Caminho de documento inválido: " + path);
      return new DocRef(p.slice(0, -1).join("/"), p[p.length - 1]);
    },
    rpc: rpc,
    refresh: pollNow
  };

  loadSession();
  var configured = !!(BASE && KEY) && BASE.indexOf("SEU-PROJETO") < 0 && KEY.indexOf("COLE-AQUI") < 0;
  window.SB = { auth: auth, db: db, configured: configured, loginToEmail: loginToEmail, domain: DOMAIN };
})();
