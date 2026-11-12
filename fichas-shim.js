/* Fichas técnicas dentro do sistema de estoque.
 * Oferece ao app de fichas a mesma interface que ele usava (claude.use('db'|'user'|'assets'|'downloads')),
 * agora gravando no Supabase do sistema (coleções ft_*) com o login do funcionário.
 * Acesso: somente Diretoria. */
(function () {
  "use strict";
  var MANAGERS = ["Diretoria"];
  var user = window.SB && SB.auth.user();
  if (!window.SB || !SB.configured || !user) { location.replace("index.html"); return; }

  var emp = null, role = "", empNames = null;
  var ready = SB.auth.restore().catch(function () { return null; }).then(function () {
    return SB.db.collection("employees").where("authUserId", "==", user.id).get();
  }).then(function (s) {
    if (s.docs.length) { emp = Object.assign({ id: s.docs[0].id }, s.docs[0].data()); role = emp.role || ""; }
    return emp;
  }).catch(function () { return null; });
  function isManager() { return !!emp && emp.active !== false && MANAGERS.indexOf(role) !== -1; }

  function wrapDb() {
    return {
      doc: function (p) { return SB.db.doc("ft_" + p); },
      collection: function (c) { return SB.db.collection("ft_" + c); }
    };
  }

  function names(ids) {
    var p = empNames ? Promise.resolve(empNames) : SB.db.collection("employees").get().then(function (s) {
      empNames = {}; s.docs.forEach(function (d) { empNames[d.id] = { name: d.data().name || "" }; }); return empNames;
    });
    return p.then(function (all) { var o = {}; (ids || []).forEach(function (i) { if (all[i]) o[i] = all[i]; }); return o; });
  }

  // ---- fotos: reduz no aparelho e envia para o Storage do sistema ----
  function shrink(file) {
    return new Promise(function (res, rej) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var s = Math.min(1, 1000 / Math.max(img.width, img.height)), c = document.createElement("canvas");
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? res(b) : rej(new Error("imagem")); }, "image/jpeg", 0.82);
      };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error("imagem")); };
      img.src = url;
    });
  }
  function uploadBlob(blob, id) {
    var path = "fotos/" + id + ".jpg";
    return SB.auth.token().then(function (tk) {
      return fetch(SB.base + "/storage/v1/object/fichas-fotos/" + path, {
        method: "POST", body: blob,
        headers: { "apikey": SB.key, "Authorization": "Bearer " + tk, "Content-Type": "image/jpeg", "x-upsert": "true" }
      });
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error("Falha ao enviar a foto (" + r.status + ") " + t); });
      return { id: id, url: SB.base + "/storage/v1/object/public/fichas-fotos/" + path + "?v=" + Date.now() };
    });
  }
  function rid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  var assets = { upload: function (file) { return shrink(file).then(function (b) { return uploadBlob(b, rid()); }); } };

  // ---- downloads: PDF e CSV salvos pelo navegador ----
  var downloads = {
    save: function (o) {
      var blob = o.data instanceof Blob ? o.data : new Blob([o.data], { type: /\.csv$/i.test(o.filename) ? "text/csv;charset=utf-8" : "application/octet-stream" });
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = o.filename || "arquivo";
      document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
      return Promise.resolve();
    }
  };

  window.claude = {
    use: function (name) {
      if (name === "db") return ready.then(function () { return isManager() ? wrapDb() : null; });
      if (name === "user") return ready.then(function () {
        if (!emp) return null;
        return { id: function () { return Promise.resolve(emp.id); }, can: function () { return Promise.resolve(isManager()); }, profiles: names };
      });
      if (name === "assets") return Promise.resolve(assets);
      if (name === "downloads") return Promise.resolve(downloads);
      return Promise.resolve(null); // leitura de cardápio com IA não existe fora do Claude
    }
  };

  // ---- cabeçalho: quem está usando + importação da base (Diretoria) ----
  function bar(html) { var b = document.getElementById("ftBar"); if (b) { b.innerHTML = html; b.hidden = !html; } }
  ready.then(function () {
    var who = document.getElementById("ftWho");
    if (who && emp) who.textContent = (emp.name || "") + " · " + role;
    if (!isManager()) return;
    var imp = document.getElementById("ftImport");
    if (role === "Diretoria" && imp) { imp.hidden = false; imp.addEventListener("click", pickImport); }
    SB.db.collection("ft_fichas").limit(1).get().then(function (s) {
      if (!s.docs.length) bar(role === "Diretoria"
        ? '<b>A base de fichas ainda está vazia.</b> Toque em <b>Importar base</b> e escolha o arquivo <i>Base-Fichas-Tecnicas.json</i> para trazer os insumos, as fichas e as fotos.'
        : '');
    });
  });

  function pickImport() {
    var inp = document.createElement("input"); inp.type = "file"; inp.accept = ".json,application/json";
    inp.onchange = function () { if (inp.files[0]) runImport(inp.files[0]); };
    inp.click();
  }
  function dataUrlToBlob(u) {
    var p = u.split(","), bin = atob(p[1]), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return new Blob([a], { type: "image/jpeg" });
  }
  function runImport(file) {
    var rd = new FileReader();
    rd.onload = function () {
      var pkg; try { pkg = JSON.parse(rd.result); } catch (e) { bar("Arquivo inválido."); return; }
      if (!pkg || pkg.tipo !== "fichas-tecnicas-tropical" || !Array.isArray(pkg.docs)) { bar("Este arquivo não é uma base de fichas técnicas."); return; }
      if (!confirm("Importar " + pkg.docs.length + " registros (insumos, fichas e configuração)? Registros com o mesmo código serão substituídos.")) return;
      var fotoIds = Object.keys(pkg.fotos || {}), urls = {}, done = 0, total = fotoIds.length + pkg.docs.length;
      function prog() { bar("Importando… " + Math.round(done / total * 100) + "% (" + done + " de " + total + ")"); }
      prog();
      var chain = Promise.resolve();
      fotoIds.forEach(function (id) {
        chain = chain.then(function () { return uploadBlob(dataUrlToBlob(pkg.fotos[id]), id).then(function (r) { urls[id] = r.url; done++; prog(); }); });
      });
      chain.then(function () {
        var q = pkg.docs.slice(), errs = 0;
        function worker() {
          var it = q.shift(); if (!it) return Promise.resolve();
          var col = String(it[0]), id = String(it[1]), d = it[2] || {};
          if (col.indexOf("ft_") !== 0) { done++; return worker(); }
          if (d.fotoId && urls[d.fotoId]) d.fotoUrl = urls[d.fotoId];
          return SB.db.doc(col + "/" + id).set(d).then(function () { done++; prog(); }, function () { errs++; done++; }).then(worker);
        }
        return Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]).then(function () { return errs; });
      }).then(function (errs) {
        bar(errs ? "Importação concluída com " + errs + " erro(s). Tente importar de novo." : "✅ Base importada: " + pkg.docs.length + " registros e " + fotoIds.length + " fotos.");
        SB.db.refresh && SB.db.refresh();
      }).catch(function (e) { bar("Erro na importação: " + (e && e.message || e)); });
    };
    rd.readAsText(file);
  }
})();
