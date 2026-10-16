/* C-Pay — scripts de la vitrine (démo détection, formulaires, navigation, documentation développeurs).
   Vanilla JS, aucune dépendance. Tous les appels réseau ciblent l'API publique
   dont la base est lue dans <meta name="cpay-api">. */
(function () {
  'use strict';

  var API_BASE = (function () {
    var m = document.querySelector('meta[name="cpay-api"]');
    var v = m && m.getAttribute('content');
    return (v || 'https://api.c-pay.global').replace(/\/+$/, '');
  })();

  var ROUTES = {
    detect: API_BASE + '/api/v1/detect/phone',       // POST { phone } — public, 30 req/min
    leads:  API_BASE + '/api/v1/public/leads',       // POST lead
    claims: API_BASE + '/api/v1/public/claims'       // POST claim → { reference }
  };

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function fetchJSON(url, opts, timeoutMs) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 8000) : null;
    var o = opts || {};
    if (ctrl) o.signal = ctrl.signal;
    return fetch(url, o).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
        return { ok: res.ok, status: res.status, data: data };
      });
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  /* ── Navigation mobile ──────────────────────────────────── */
  (function nav() {
    var header = $('site-header');
    var toggle = $('nav-toggle');
    if (!header || !toggle) return;
    toggle.addEventListener('click', function () {
      var open = header.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Fermer le menu' : 'Ouvrir le menu');
    });
    header.addEventListener('click', function (e) {
      if (e.target.tagName === 'A' && header.classList.contains('is-open')) {
        header.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  })();

  /* ── Table locale de détection (repli hors ligne) ─────────
     Copie indicative de la table du moteur serveur. Le serveur fait foi. */
  var LOCAL = {
    countries: {
      '237': { country: 'CM', name: 'Cameroun', currency: 'XAF', alternatives: ['Express Union'] },
      '236': { country: 'CF', name: 'République centrafricaine', currency: 'XAF', alternatives: [] },
      '242': { country: 'CG', name: 'République du Congo', currency: 'XAF', alternatives: [] },
      '241': { country: 'GA', name: 'Gabon', currency: 'XAF', alternatives: [] },
      '240': { country: 'GQ', name: 'Guinée équatoriale', currency: 'XAF', alternatives: [] },
      '235': { country: 'TD', name: 'Tchad', currency: 'XAF', alternatives: [] },
      '243': { country: 'CD', name: 'RD Congo', currency: 'CDF', alternatives: [] }
    },
    // Only prefixes already documented by the server; never guess an operator.
    operators: {
      CM: [
        [/^237(?:6[78]\d{7}|65[0-4]\d{6})$/, 'MTN Mobile Money'],
        [/^237(?:69\d{7}|65[5-9]\d{6})$/, 'Orange Money']
      ],
      CG: [
        [/^24206\d{7}$/, 'MTN Mobile Money'],
        [/^24205\d{7}$/, 'Airtel Money']
      ],
      CD: [
        [/^243(81|82)\d{7}$/, 'Vodacom M-Pesa'],
        [/^243(97|98|99)\d{7}$/, 'Airtel Money'],
        [/^243(84|85|89)\d{7}$/, 'Orange Money']
      ]
    }
  };

  function normalizePhone(raw) {
    var s = String(raw || '').replace(/[\s\-().]/g, '');
    if (s.indexOf('00') === 0) s = '+' + s.slice(2);
    if (s.charAt(0) === '0' && s.length <= 10) return null; // numéro local sans indicatif
    if (s.charAt(0) !== '+') s = '+' + s;
    if (!/^\+\d{8,15}$/.test(s)) return null;
    return s;
  }

  function detectLocally(raw) {
    var phone = normalizePhone(raw);
    if (!phone) return { success: false, error: 'Numéro invalide. Saisissez-le avec son indicatif, par exemple +237 6 70 12 34 56.' };
    var digits = phone.slice(1);
    var cc = digits.slice(0, 3);
    var c = LOCAL.countries[cc];
    if (!c) return { success: false, error: 'Indicatif +' + cc + ' hors périmètre de lancement. C-Pay se concentre sur la CEMAC et la RD Congo.' };
    var ops = LOCAL.operators[c.country] || [];
    if (!ops.length) return { success: false, error: 'Pays du périmètre de lancement ; la détection des opérateurs est en cours d’intégration.', countryInfo: c };
    for (var i = 0; i < ops.length; i++) {
      if (ops[i][0].test(digits)) {
        return { success: true, phone: phone, country: c.country, countryName: c.name, currency: c.currency, brand: ops[i][1], alternatives: c.alternatives };
      }
    }
    return { success: false, error: 'Opérateur non reconnu dans cette démonstration pour ' + c.name + '. Vérifiez le numéro ou contactez le support.', countryInfo: c };
  }

  /* ── Démo détection ─────────────────────────────────────── */
  (function detectDemo() {
    var form = $('detect-form');
    var input = $('detect-phone');
    var btn = $('detect-btn');
    var out = $('detect-result');
    if (!form || !input || !out) return;

    var COUNTRY_NAMES = { CM: 'Cameroun', CF: 'République centrafricaine', CG: 'République du Congo', GA: 'Gabon', GQ: 'Guinée équatoriale', TD: 'Tchad', CD: 'RD Congo' };
    var ALT_BY_COUNTRY = { CM: ['Express Union'] };

    function altLabel(a) {
      if (!a) return '';
      if (typeof a === 'string') return a;
      return a.brand || a.name || a.label || a.operator || '';
    }

    function render(result, source) {
      clear(out);
      if (!result || !result.success) {
        var msg = (result && result.error) || 'Détection impossible.';
        var a = el('div', 'alert alert--err', msg);
        a.setAttribute('role', 'alert');
        out.appendChild(a);
        if (result && result.countryInfo) {
          var dl0 = el('dl', 'result-rows');
          addRow(dl0, 'Pays reconnu', result.countryInfo.name || result.countryInfo.country);
          addRow(dl0, 'Devise', result.countryInfo.currency);
          out.appendChild(dl0);
        }
        out.appendChild(el('p', 'result-source', source));
        return;
      }
      var ok = el('div', 'alert alert--ok', 'Opérateur détecté — le marchand n’a rien eu à choisir.');
      out.appendChild(ok);
      var dl = el('dl', 'result-rows');
      addRow(dl, 'Numéro normalisé', result.phone || '');
      addRow(dl, 'Pays', (result.countryName || COUNTRY_NAMES[result.country] || result.country || '') + (result.country ? ' (' + result.country + ')' : ''));
      addRow(dl, 'Devise', result.currency || '');
      addRow(dl, 'Opérateur', result.brand || result.operator || '');
      var alts = Array.isArray(result.alternatives) ? result.alternatives.map(altLabel).filter(Boolean)
               : (ALT_BY_COUNTRY[result.country] || []);
      if (alts.length) addRow(dl, 'Au choix du client', alts.join(', '));
      out.appendChild(dl);
      out.appendChild(el('p', 'result-source', source));
    }

    function addRow(dl, k, v) {
      var row = el('div');
      row.appendChild(el('dt', null, k));
      row.appendChild(el('dd', null, v == null ? '' : String(v)));
      dl.appendChild(row);
    }

    function setBusy(b) {
      btn.disabled = b;
      btn.textContent = b ? 'Détection…' : 'Détecter';
    }

    function run(raw) {
      var phone = String(raw || '').trim();
      if (!phone) { input.focus(); return; }
      var normalized = normalizePhone(phone);
      var country = normalized && LOCAL.countries[normalized.slice(1, 4)];
      // Do not let the legacy API advertise an out-of-launch country, or invent support.
      if (!country || !LOCAL.operators[country.country]) {
        render(detectLocally(phone), 'Source : périmètre de lancement C-Pay.');
        return;
      }
      setBusy(true);
      fetchJSON(ROUTES.detect, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ phone: phone })
      }, 6000).then(function (r) {
        setBusy(false);
        if (r.status === 429) {
          render({ success: false, error: 'Trop de tentatives depuis votre adresse. Réessayez dans une minute.' }, 'Source : API C-Pay (limite de débit).');
          return;
        }
        if (r.status === 400) {
          render({ success: false, error: (r.data && r.data.error) || 'Numéro requis.' }, 'Source : API C-Pay.');
          return;
        }
        if (!r.ok || !r.data || typeof r.data !== 'object') {
          render(detectLocally(phone), 'Source : table locale indicative (réponse API inattendue, code ' + r.status + ').');
          return;
        }
        render(r.data, 'Source : moteur de détection C-Pay (api.c-pay.global).');
      }).catch(function () {
        setBusy(false);
        render(detectLocally(phone), 'Source : table locale indicative — l’API n’est pas joignable depuis votre navigateur.');
      });
    }

    form.addEventListener('submit', function (e) { e.preventDefault(); run(input.value); });
    var chips = document.querySelectorAll('.chip[data-phone]');
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener('click', function () {
        input.value = this.getAttribute('data-phone');
        run(input.value);
      });
    }
  })();

  /* ── Formulaires contact (lead) et réclamation (claim) ──── */
  function bindForm(opts) {
    var form = $(opts.formId);
    var status = $(opts.statusId);
    if (!form || !status) return;
    var submitBtn = form.querySelector('button[type="submit"]');
    var submitLabel = submitBtn ? submitBtn.textContent : '';

    function setStatus(kind, text, extraNode) {
      clear(status);
      var box = el('div', 'alert alert--' + kind);
      box.appendChild(document.createTextNode(text));
      if (extraNode) box.appendChild(extraNode);
      status.appendChild(box);
    }

    function invalidMessage() {
      var fields = form.querySelectorAll('[required]');
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (f.type === 'checkbox' && !f.checked) return { f: f, m: 'Merci de cocher la case de consentement.' };
        if (!f.checkValidity()) {
          var label = form.querySelector('label[for="' + f.id + '"]');
          var name = label ? label.textContent.replace(/\*/g, '').trim() : 'Ce champ';
          if (f.validity.valueMissing) return { f: f, m: name + ' : champ obligatoire.' };
          if (f.validity.typeMismatch) return { f: f, m: name + ' : format invalide.' };
          if (f.validity.tooShort) return { f: f, m: name + ' : trop court (10 caractères minimum).' };
          return { f: f, m: name + ' : valeur invalide.' };
        }
      }
      return null;
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var bad = invalidMessage();
      if (bad) { setStatus('err', bad.m); bad.f.focus(); return; }
      var payload = opts.payload(form);
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Envoi…'; }
      setStatus('info', 'Envoi en cours…');
      fetchJSON(opts.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload)
      }, 12000).then(function (r) {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = submitLabel; }
        if (r.ok) {
          opts.onSuccess(r.data || {}, setStatus);
          form.reset();
          return;
        }
        if (r.status === 429) { setStatus('err', 'Trop de demandes depuis votre adresse. Réessayez dans quelques minutes.'); return; }
        var serverMsg = r.data && (r.data.error || r.data.message);
        if (r.status === 400 || r.status === 422) { setStatus('err', 'Formulaire refusé : ' + (serverMsg || 'vérifiez les champs saisis.')); return; }
        setStatus('err', 'Le service est momentanément indisponible (code ' + r.status + '). ' + opts.fallbackText);
      }).catch(function () {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = submitLabel; }
        setStatus('err', 'Impossible de joindre le serveur. ' + opts.fallbackText);
      });
    });
  }

  function val(form, name) {
    var f = form.elements[name];
    return f ? String(f.value || '').trim() : '';
  }

  bindForm({
    formId: 'lead-form', statusId: 'lead-status', url: ROUTES.leads,
    fallbackText: 'Vous pouvez nous écrire à support@c-pay.global.',
    payload: function (form) {
      return {
        name: val(form, 'name'),
        email: val(form, 'email'),
        phone: val(form, 'phone') || null,
        company: val(form, 'company') || null,
        country: val(form, 'country') || null,
        message: val(form, 'message'),
        consent: !!form.elements.consent.checked,
        source: 'landing'
      };
    },
    onSuccess: function (data, setStatus) {
      var id = data.leadId || data.id || data.reference;
      setStatus('ok', 'Merci, votre demande a bien été transmise' + (id ? ' (référence ' + id + ')' : '') + '. Nous revenons vers vous par e-mail.');
    }
  });

  bindForm({
    formId: 'claim-form', statusId: 'claim-status', url: ROUTES.claims,
    fallbackText: 'Vous pouvez envoyer votre réclamation à support@c-pay.global en indiquant la référence de la transaction.',
    payload: function (form) {
      // Contrat backend (docs/ASSISTANT-API.md) : category ∈ payment|settlement|account|fraud|other,
      // transactionRef, merchantRef ; le montant/la devise sont repris dans la description.
      var amt = val(form, 'amount'), cur = val(form, 'currency'), type = val(form, 'type');
      var CATEGORY = { not_received: 'payment', double_charge: 'payment', refund: 'payment', settlement: 'settlement', other: 'other' };
      var TYPE_LABEL = {
        not_received: 'Paiement débité mais non reçu', double_charge: 'Double prélèvement',
        refund: 'Demande de remboursement', settlement: 'Règlement non reçu', other: 'Autre'
      };
      var desc = '[' + (TYPE_LABEL[type] || 'Autre') + (amt ? ' – ' + amt + ' ' + (cur || '') : '') + '] ' + val(form, 'description');
      return {
        name: val(form, 'name'),
        email: val(form, 'email'),
        phone: val(form, 'phone') || null,
        transactionRef: val(form, 'transactionReference') || null,
        category: CATEGORY[type] || 'other',
        description: desc.trim(),
        consent: !!form.elements.consent.checked,
        source: 'landing'
      };
    },
    onSuccess: function (data, setStatus) {
      var ref = data.reference || data.claimReference || data.claimId || data.id;
      var strong = null;
      if (ref) { strong = el('strong', null, ' ' + ref); }
      setStatus('ok', 'Réclamation enregistrée.' + (ref ? ' Votre numéro de dossier :' : ' Conservez l’e-mail de confirmation.'), strong);
    }
  });

  /* ── Onglets de code (page développeurs) ────────────────
     Les onglets portant data-lang sont synchronisés : choisir « PHP » dans un
     bloc bascule tous les blocs qui proposent PHP. */
  (function tabs() {
    var lists = document.querySelectorAll('[role="tablist"]');
    if (!lists.length) return;
    var groups = [];

    function activate(group, tab) {
      for (var j = 0; j < group.tabs.length; j++) {
        var t = group.tabs[j];
        var sel = t === tab;
        t.setAttribute('aria-selected', sel ? 'true' : 'false');
        t.tabIndex = sel ? 0 : -1;
        var panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !sel;
      }
    }
    function syncLang(lang) {
      if (!lang) return;
      for (var g = 0; g < groups.length; g++) {
        for (var j = 0; j < groups[g].tabs.length; j++) {
          if (groups[g].tabs[j].getAttribute('data-lang') === lang) { activate(groups[g], groups[g].tabs[j]); break; }
        }
      }
    }

    for (var i = 0; i < lists.length; i++) {
      (function (list) {
        var group = { tabs: list.querySelectorAll('[role="tab"]') };
        groups.push(group);
        for (var j = 0; j < group.tabs.length; j++) {
          group.tabs[j].addEventListener('click', function () {
            activate(group, this);
            syncLang(this.getAttribute('data-lang'));
          });
          group.tabs[j].addEventListener('keydown', function (e) {
            var idx = Array.prototype.indexOf.call(group.tabs, this);
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault();
              var n = group.tabs[(idx + (e.key === 'ArrowRight' ? 1 : group.tabs.length - 1)) % group.tabs.length];
              activate(group, n); syncLang(n.getAttribute('data-lang')); n.focus();
            }
          });
        }
      })(lists[i]);
    }
  })();

  /* ── Boutons « Copier » sur les blocs de code ───────────── */
  (function copyButtons() {
    var pres = document.querySelectorAll('.devdoc pre');
    if (!pres.length) return;
    var canCopy = !!(navigator.clipboard && navigator.clipboard.writeText) || !!document.execCommand;
    if (!canCopy) return;

    function fallbackCopy(text) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.className = 'visually-hidden';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      return ok ? Promise.resolve() : Promise.reject(new Error('copy'));
    }
    function copy(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).catch(function () { return fallbackCopy(text); });
      }
      return fallbackCopy(text);
    }

    for (var i = 0; i < pres.length; i++) {
      (function (pre) {
        var wrap = el('div', 'codeblock');
        pre.parentNode.insertBefore(wrap, pre);
        wrap.appendChild(pre);
        var btn = el('button', 'copy-btn', 'Copier');
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Copier le code');
        wrap.appendChild(btn);
        var timer = null;
        btn.addEventListener('click', function () {
          var code = pre.querySelector('code');
          copy((code || pre).textContent).then(function () {
            btn.textContent = 'Copié !'; btn.classList.add('is-done');
          }, function () {
            btn.textContent = 'Échec';
          }).then(function () {
            if (timer) clearTimeout(timer);
            timer = setTimeout(function () { btn.textContent = 'Copier'; btn.classList.remove('is-done'); }, 1600);
          });
        });
      })(pres[i]);
    }
  })();

  /* ── Sommaire de la documentation (repli mobile, section active) ── */
  (function toc() {
    var toc = $('toc');
    var toggle = $('toc-toggle');
    if (!toc) return;
    if (toggle) {
      toggle.addEventListener('click', function () {
        var open = toc.classList.toggle('is-open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      toc.addEventListener('click', function (e) {
        if (e.target.tagName === 'A' && toc.classList.contains('is-open')) {
          toc.classList.remove('is-open');
          toggle.setAttribute('aria-expanded', 'false');
        }
      });
    }
    var links = toc.querySelectorAll('.toc-nav a[href^="#"]');
    if (!links.length) return;
    var items = [];
    for (var i = 0; i < links.length; i++) {
      var target = document.getElementById(links[i].getAttribute('href').slice(1));
      if (target) items.push({ link: links[i], target: target, parent: links[i].parentNode.parentNode.parentNode.querySelector(':scope > a') });
    }
    var headerH = ($('site-header') || {}).offsetHeight || 68;
    var current = null, ticking = false;
    function update() {
      ticking = false;
      var limit = headerH + 32;
      var active = items[0] || null;
      for (var k = 0; k < items.length; k++) {
        if (items[k].target.getBoundingClientRect().top <= limit) active = items[k];
      }
      if (window.innerHeight + window.pageYOffset >= document.documentElement.scrollHeight - 2) active = items[items.length - 1];
      if (!active || active === current) return;
      for (var m = 0; m < items.length; m++) items[m].link.classList.remove('is-active');
      active.link.classList.add('is-active');
      if (active.parent && active.parent.getAttribute('href') !== active.link.getAttribute('href')) active.parent.classList.add('is-active');
      current = active;
    }
    function onScroll() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    update();
  })();
})();
