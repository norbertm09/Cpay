/* C-Pay — widget assistant (chat). Vanilla JS, aucune dépendance.
 *
 * Contrat client (voir docs/ASSISTANT-API.md côté backend) :
 *   POST {base}/conversations                       → { conversationId }
 *   GET  {base}/conversations/{id}                  → { messages: [{ role, content }] }
 *   POST {base}/conversations/{id}/messages          body { message }
 *        Accept: text/event-stream → événements SSE `token`, `tool`, `done`, `error`
 *        ?stream=0 → JSON { reply, leadId?, claimId?, handoff? } (repli sans flux)
 *
 * La base API vient de <meta name="cpay-api">, le préfixe assistant de
 * <meta name="cpay-assistant-path"> (défaut /api/v1/public/assistant).
 * L'identifiant de conversation est conservé en sessionStorage.
 */
(function () {
  'use strict';
  if (typeof fetch !== 'function' || !window.sessionStorage) return;

  function meta(name, dflt) {
    var m = document.querySelector('meta[name="' + name + '"]');
    var v = m && m.getAttribute('content');
    return v ? v : dflt;
  }
  var API_BASE = meta('cpay-api', 'https://api.c-pay.global').replace(/\/+$/, '');
  var ASSISTANT_PATH = meta('cpay-assistant-path', '/api/v1/public/assistant').replace(/\/+$/, '');
  var BASE = API_BASE + ASSISTANT_PATH;
  var ROUTES = {
    create: function () { return BASE + '/conversations'; },
    history: function (id) { return BASE + '/conversations/' + encodeURIComponent(id); },
    message: function (id, stream) { return BASE + '/conversations/' + encodeURIComponent(id) + '/messages' + (stream ? '' : '?stream=0'); }
  };
  var STORAGE_KEY = 'cpay.assistant.conversationId';
  var SUGGESTIONS = ['Comment encaisser ?', 'Comment retirer mes recettes ?', 'Quels sont vos tarifs ?', 'Quels pays couvrez-vous ?', 'Je veux ouvrir un compte', 'Déposer une réclamation'];

  /* ── Utilitaires DOM ────────────────────────────────────── */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svg(path) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', path); s.appendChild(p);
    return s;
  }
  function getStored() { try { return sessionStorage.getItem(STORAGE_KEY); } catch (e) { return null; } }
  function setStored(v) { try { if (v) sessionStorage.setItem(STORAGE_KEY, v); else sessionStorage.removeItem(STORAGE_KEY); } catch (e) { /* stockage indisponible */ } }

  /* ── Construction du widget ─────────────────────────────── */
  var launcher = el('button', 'cpa-launcher');
  launcher.type = 'button';
  launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('aria-controls', 'cpa-panel');
  launcher.appendChild(svg('M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-4.5A8 8 0 1 1 21 12z'));
  launcher.appendChild(el('span', null, 'Assistant'));

  var panel = el('section', 'cpa-panel');
  panel.id = 'cpa-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'cpa-title');

  var head = el('div', 'cpa-head');
  var titleWrap = el('div');
  var title = el('h2', null, 'Assistant C-Pay'); title.id = 'cpa-title';
  titleWrap.appendChild(title);
  titleWrap.appendChild(el('small', null, 'Questions, ouverture de compte, réclamations'));
  head.appendChild(titleWrap);
  var closeBtn = el('button', 'cpa-close', '×');
  closeBtn.type = 'button'; closeBtn.setAttribute('aria-label', 'Fermer l’assistant');
  head.appendChild(closeBtn);

  var log = el('div', 'cpa-log');
  log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite'); log.setAttribute('aria-relevant', 'additions text');

  var suggest = el('div', 'cpa-suggest');
  SUGGESTIONS.forEach(function (s) {
    var b = el('button', null, s); b.type = 'button';
    b.addEventListener('click', function () { send(s); });
    suggest.appendChild(b);
  });

  var form = el('form', 'cpa-form');
  var label = el('label', 'visually-hidden', 'Votre message'); label.htmlFor = 'cpa-input';
  var input = el('textarea'); input.id = 'cpa-input'; input.rows = 1;
  input.placeholder = 'Écrivez votre message…'; input.setAttribute('maxlength', '2000');
  var sendBtn = el('button', 'cpa-send'); sendBtn.type = 'submit'; sendBtn.setAttribute('aria-label', 'Envoyer');
  sendBtn.appendChild(svg('M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z'));
  form.appendChild(label); form.appendChild(input); form.appendChild(sendBtn);

  var foot = el('div', 'cpa-foot', 'Assistant automatisé. Ne communiquez ni mot de passe ni code PIN. Entrée pour envoyer, Maj+Entrée pour un retour à la ligne.');

  panel.appendChild(head); panel.appendChild(log); panel.appendChild(suggest); panel.appendChild(form); panel.appendChild(foot);

  function mount() { document.body.appendChild(launcher); document.body.appendChild(panel); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  /* ── Affichage des messages ─────────────────────────────── */
  function scrollDown() { log.scrollTop = log.scrollHeight; }
  function addMsg(kind, text) {
    var m = el('div', 'cpa-msg cpa-msg--' + kind, text || '');
    log.appendChild(m); scrollDown(); return m;
  }
  function addSystem(text) { return addMsg('sys', text); }
  function addError(text, retryFn) {
    var m = addMsg('err', text);
    if (retryFn) {
      var b = el('button', null, 'Réessayer'); b.type = 'button';
      b.addEventListener('click', function () { m.parentNode && m.parentNode.removeChild(m); retryFn(); });
      m.appendChild(b);
    }
    return m;
  }
  function addConfirmation(data) {
    var parts = [];
    if (data.leadId) parts.push('Votre demande de contact a été créée (référence ' + data.leadId + ').');
    if (data.claimId || data.claimReference) parts.push('Votre réclamation a été enregistrée (dossier ' + (data.claimReference || data.claimId) + ').');
    if (data.handoff) {
      var h = data.handoff;
      var who = (typeof h === 'object' && (h.email || h.channel)) ? ' (' + (h.email || h.channel) + ')' : '';
      parts.push('Un conseiller prend le relais' + who + '. Vous serez recontacté par e-mail.');
    }
    if (parts.length) addMsg('ok', parts.join(' '));
  }
  var typingNode = null;
  function showTyping() { if (!typingNode) { typingNode = el('div', 'cpa-typing'); typingNode.setAttribute('aria-label', 'L’assistant écrit'); typingNode.appendChild(el('i')); typingNode.appendChild(el('i')); typingNode.appendChild(el('i')); log.appendChild(typingNode); scrollDown(); } }
  function hideTyping() { if (typingNode && typingNode.parentNode) typingNode.parentNode.removeChild(typingNode); typingNode = null; }
  var toolNode = null;
  function showTool(name) {
    var text = /claim|reclam/i.test(name || '') ? 'Enregistrement de votre réclamation…'
             : /lead|contact/i.test(name || '') ? 'Création de votre demande…'
             : 'Traitement en cours…';
    if (!toolNode) { toolNode = el('div', 'cpa-tool'); log.appendChild(toolNode); }
    toolNode.textContent = text; scrollDown();
  }
  function hideTool() { if (toolNode && toolNode.parentNode) toolNode.parentNode.removeChild(toolNode); toolNode = null; }
  function setBusy(b) { busy = b; sendBtn.disabled = b; input.readOnly = b; }

  /* ── Conversation ───────────────────────────────────────── */
  var conversationId = null;
  var busy = false;
  var ready = false;
  var initialising = null;

  function jsonHeaders() { return { 'Content-Type': 'application/json', 'Accept': 'application/json' }; }

  function createConversation() {
    return fetch(ROUTES.create(), { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ source: 'landing', page: location.pathname }) })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (d) {
        var id = d && (d.conversationId || d.id);
        if (!id) throw new Error('conversationId manquant');
        conversationId = id; setStored(id);
        return id;
      });
  }

  function loadHistory(id) {
    return fetch(ROUTES.history(id), { headers: { 'Accept': 'application/json' } }).then(function (r) {
      if (r.status === 404 || r.status === 410) { return null; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      if (d === null) return false;
      var msgs = Array.isArray(d) ? d : (d && (d.messages || d.items)) || [];
      msgs.forEach(function (m) {
        if (!m) return;
        var role = m.role || m.sender || 'assistant';
        var text = m.content || m.text || m.message || '';
        if (!text) return;
        addMsg(role === 'user' ? 'user' : 'bot', text);
      });
      return true;
    });
  }

  function init() {
    if (ready) return Promise.resolve();
    if (initialising) return initialising;
    var stored = getStored();
    initialising = (stored ? loadHistory(stored).then(function (ok) {
      if (ok) { conversationId = stored; return stored; }
      setStored(null);
      return createConversation();
    }) : createConversation()).then(function () {
      ready = true; initialising = null;
      if (!log.querySelector('.cpa-msg--bot') && !log.querySelector('.cpa-msg--user')) {
        addMsg('bot', 'Bonjour. Je peux répondre à vos questions sur C-Pay, vous aider à ouvrir un compte marchand ou enregistrer une réclamation. Comment puis-je vous aider ?');
      }
    }).catch(function () {
      initialising = null;
      addError('L’assistant est indisponible pour le moment. Vous pouvez nous écrire à support@c-pay.global.', function () { init(); });
    });
    return initialising;
  }

  /* ── Lecture SSE (fetch + ReadableStream) ───────────────── */
  function parseEventBlock(block) {
    var lines = block.split('\n');
    var event = 'message', data = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line || line.charAt(0) === ':') continue;
      var idx = line.indexOf(':');
      var field = idx === -1 ? line : line.slice(0, idx);
      var value = idx === -1 ? '' : line.slice(idx + 1);
      if (value.charAt(0) === ' ') value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (!data.length) return null;
    var raw = data.join('\n');
    var payload;
    try { payload = JSON.parse(raw); } catch (e) { payload = raw; }
    return { event: event, data: payload };
  }

  function readSSE(response, onEvent) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buffer = '';
    function flush(block) { var ev = parseEventBlock(block); if (ev) onEvent(ev); }
    function pump() {
      return reader.read().then(function (res) {
        if (res.done) { if (buffer.trim()) flush(buffer); return; }
        buffer += decoder.decode(res.value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        var idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          var block = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
          flush(block);
        }
        return pump();
      });
    }
    return pump();
  }

  function tokenText(d) {
    if (d == null) return '';
    if (typeof d === 'string') return d;
    return d.text || d.delta || d.content || d.token || '';
  }

  function sendStreaming(text, botNode) {
    var gotToken = false, finished = false, errored = null;
    return fetch(ROUTES.message(conversationId, true), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({ message: text })
    }).then(function (r) {
      if (r.status === 429) { var e = new Error('rate'); e.rate = true; throw e; }
      if (r.status === 404 || r.status === 410) { var g = new Error('gone'); g.gone = true; throw g; }
      var ct = (r.headers.get('content-type') || '').toLowerCase();
      if (!r.ok || !r.body || ct.indexOf('text/event-stream') === -1) { var n = new Error('nostream'); n.nostream = true; throw n; }
      return readSSE(r, function (ev) {
        if (ev.event === 'token' || ev.event === 'message' || ev.event === 'delta') {
          var t = tokenText(ev.data);
          if (!t) return;
          if (!gotToken) { hideTyping(); gotToken = true; botNode.hidden = false; }
          botNode.textContent += t; scrollDown();
        } else if (ev.event === 'tool') {
          showTool(ev.data && (ev.data.name || ev.data.tool));
          if (ev.data && (ev.data.status === 'end' || ev.data.status === 'done' || ev.data.done === true)) hideTool();
        } else if (ev.event === 'done') {
          finished = true; hideTool(); hideTyping();
          if (!gotToken && ev.data && typeof ev.data === 'object' && (ev.data.reply || ev.data.content)) botNode.textContent = ev.data.reply || ev.data.content;
          if (ev.data && typeof ev.data === 'object') addConfirmation(ev.data);
        } else if (ev.event === 'error') {
          errored = (ev.data && (ev.data.message || ev.data.error)) || 'Erreur de l’assistant.';
        }
      }).then(function () {
        hideTool();
        if (errored) { var er = new Error(errored); er.server = true; er.partial = gotToken; throw er; }
        if (!gotToken && !finished) { var s = new Error('empty'); s.nostream = true; throw s; }
      });
    });
  }

  function sendPlain(text, botNode) {
    return fetch(ROUTES.message(conversationId, false), {
      method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ message: text })
    }).then(function (r) {
      if (r.status === 429) { var e = new Error('rate'); e.rate = true; throw e; }
      if (r.status === 404 || r.status === 410) { var g = new Error('gone'); g.gone = true; throw g; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      hideTyping();
      var reply = d && (d.reply || d.message || d.content || d.text) || '';
      botNode.textContent = reply || 'Je n’ai pas de réponse pour le moment.';
      botNode.hidden = false; scrollDown();
      if (d && typeof d === 'object') addConfirmation(d);
    });
  }

  function send(text) {
    text = String(text || '').trim();
    if (!text || busy) return;
    if (suggest.parentNode) suggest.parentNode.removeChild(suggest);
    addMsg('user', text);
    input.value = ''; autosize();
    setBusy(true);
    init().then(function () {
      if (!ready) { setBusy(false); return; }
      showTyping();
      var botNode = addMsg('bot', '');
      botNode.hidden = true;
      function done() { hideTyping(); hideTool(); setBusy(false); if (!botNode.textContent) { if (botNode.parentNode) botNode.parentNode.removeChild(botNode); } else { botNode.hidden = false; } input.focus(); }
      function handleError(err) {
        if (err && err.gone) { setStored(null); ready = false; conversationId = null; done(); addError('La conversation a expiré. Une nouvelle conversation va être ouverte.', function () { init().then(function () { send(text); }); }); return; }
        if (err && err.rate) { done(); addError('Trop de messages en peu de temps. Patientez un instant avant de réessayer.'); return; }
        done();
        addError(err && err.server ? err.message : 'Je n’ai pas pu envoyer votre message.', function () { send(text); });
      }

      sendStreaming(text, botNode).then(done).catch(function (err) {
        if (err && (err.nostream || (!err.server && !err.rate && !err.gone && !botNode.textContent))) {
          // Le flux n'a pas démarré (proxy, navigateur, réseau) : repli JSON sans streaming.
          sendPlain(text, botNode).then(done).catch(handleError);
          return;
        }
        if (err && err.server && err.partial) { done(); addError('La réponse a été interrompue : ' + err.message, function () { send(text); }); return; }
        handleError(err);
      });
    });
  }

  /* ── Ouverture / fermeture / clavier ───────────────────── */
  function open() {
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    init().then(function () { input.focus(); });
    input.focus();
  }
  function close() {
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    launcher.focus();
  }
  launcher.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); close(); } });
  form.addEventListener('submit', function (e) { e.preventDefault(); send(input.value); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); }
  });
  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px'; }
  input.addEventListener('input', autosize);

  // Ouverture via un lien #assistant (ex. depuis la FAQ) ou un bouton data-open-assistant.
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-open-assistant]') : null;
    if (t) { e.preventDefault(); open(); }
  });
  if (location.hash === '#assistant') open();
})();
