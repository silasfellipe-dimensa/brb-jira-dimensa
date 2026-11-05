/* Buscar no Jira: botão flutuante + painel lateral, em todas as telas da equipe.
 * O menu.js carrega este arquivo só para quem edita (Dimensa/Evertec); o BRB e a
 * TOTVS nem baixam. A barreira de verdade é a do servidor (/api/pesquisa*).
 *
 * Um campo só, que escolhe a busca sozinho:
 *   - número, task ou termo curto (até 3 palavras) -> exata (/api/pesquisa);
 *   - texto colado (mais longo, ou com quebra de linha) -> ampla (/api/pesquisa/ampla).
 * Dá para trocar à mão. Não é um chat: a busca procura número e termos, não
 * interpreta frase - por isso nada de robô nem "pergunte".
 *
 * A tela /pesquisa é a "tela inteira": lá o botão não aparece. Tecla "/" abre,
 * Esc fecha. Nada vindo da API vira markup sem esc(); link só https. Das
 * últimas pesquisas fica no navegador só o termo curto da exata - a mensagem
 * do cliente nunca é guardada. */
(function () {
  if (window.Busca) return;
  window.Busca = {};
  if (window.location.pathname === '/pesquisa') return;

  var PROJETO = 'JDCBBRB';
  var CHAVE_RECENTES = 'busca-recentes';
  var CHAVE_TEXTO = 'pesquisa-ampla-texto';
  var MAX_LISTA = 6;

  var CSS = [
    '.bz-botao{position:fixed;right:22px;bottom:22px;z-index:70;display:inline-flex;align-items:center;gap:8px;',
    /* Cor invertida (claro no tema escuro, escuro no claro): todos os botões da
     * tela são laranja, e um botão laranja a mais se misturava. Lupa no laranja da marca. */
    'padding:11px 16px 11px 13px;border:1px solid var(--ink,#1E212C);border-radius:100px;background:var(--ink,#1E212C);color:var(--bg,#fff);',
    'font-family:inherit;font-size:.84rem;font-weight:700;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.22),0 2px 4px rgba(0,0,0,.12);transition:transform .15s ease}',
    '.bz-botao:hover{transform:translateY(-1px)}',
    '.bz-botao svg{width:18px;height:18px;stroke:var(--accent,#FF6C0C);fill:none;stroke-width:2.3;stroke-linecap:round;stroke-linejoin:round}',
    '.bz-botao kbd{font-family:inherit;font-size:.68rem;font-weight:700;padding:1px 6px;border-radius:4px;background:color-mix(in srgb,currentColor 16%,transparent)}',
    '.bz-aberto .bz-botao{display:none}',
    '.bz-painel{position:fixed;top:0;right:0;bottom:0;z-index:80;width:460px;max-width:100vw;display:flex;flex-direction:column;',
    'background:var(--bg-panel,#fff);color:var(--ink,#1E212C);border-left:1px solid var(--line,#E5E6E7);',
    'box-shadow:-12px 0 32px rgba(0,0,0,.18);transform:translateX(105%);transition:transform .2s ease;visibility:hidden}',
    '.bz-aberto .bz-painel{transform:none;visibility:visible}',
    '.bz-topo{display:flex;align-items:flex-start;gap:10px;padding:16px 16px 12px;border-bottom:1px solid var(--line,#E5E6E7)}',
    /* Ícone do topo e Pesquisar com a mesma cara do botão flutuante: cor invertida, lupa laranja. */
    '.bz-marca{width:34px;height:34px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--ink,#1E212C);color:var(--accent,#FF6C0C)}',
    '.bz-marca svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2.3;stroke-linecap:round;stroke-linejoin:round}',
    '.bz-titulo{flex:1;min-width:0}',
    '.bz-titulo b{display:block;font-size:.95rem}',
    '.bz-titulo span{display:block;margin-top:1px;font-size:.74rem;color:var(--ink-faint,#7C8894)}',
    '.bz-acao{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:30px;min-width:30px;padding:0 9px;border:1px solid var(--line,#E5E6E7);',
    'border-radius:8px;background:transparent;color:var(--ink-dim,#4B5A68);font-family:inherit;font-size:.74rem;text-decoration:none;cursor:pointer}',
    '.bz-acao:hover{border-color:var(--accent,#FF6C0C);color:var(--accent,#FF6C0C)}',
    '.bz-corpo{flex:1;overflow-y:auto;padding:14px 16px 20px}',
    '.bz-form{display:flex;flex-direction:column;gap:8px}',
    '.bz-campo{width:100%;min-height:44px;max-height:220px;resize:none;font-family:inherit;font-size:.9rem;line-height:1.45;color:var(--ink,#1E212C);',
    'background:var(--bg,#F5F5F5);border:1px solid var(--line,#E5E6E7);border-radius:10px;padding:11px 12px;box-sizing:border-box}',
    '.bz-campo:focus{outline:none;border-color:var(--accent,#FF6C0C);box-shadow:0 0 0 2px var(--accent-soft,rgba(255,108,12,.18))}',
    '.bz-linha{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:.74rem;color:var(--ink-faint,#7C8894)}',
    '.bz-modo button{border:0;background:none;padding:0;font:inherit;color:var(--accent,#FF6C0C);text-decoration:underline;cursor:pointer}',
    '.bz-ir{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--ink,#1E212C);border-radius:100px;padding:8px 16px 8px 12px;background:var(--ink,#1E212C);color:var(--bg,#fff);font-family:inherit;font-size:.8rem;font-weight:700;cursor:pointer;transition:transform .15s ease}',
    '.bz-ir:hover{transform:translateY(-1px)}',
    '.bz-ir svg{stroke:var(--accent,#FF6C0C)!important}',
    '.bz-ir:disabled{opacity:.6;cursor:default}',
    '.bz-atalhos{margin-top:18px}',
    '.bz-atalhos h4,.bz-sec h4{margin:0 0 8px;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-faint,#7C8894)}',
    '.bz-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}',
    '.bz-chip{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid var(--line,#E5E6E7);border-radius:100px;background:var(--bg,#F5F5F5);',
    'color:var(--ink,#1E212C);font-family:inherit;font-size:.78rem;cursor:pointer;text-align:left}',
    '.bz-chip:hover{border-color:var(--accent,#FF6C0C)}',
    '.bz-chip small{color:var(--ink-faint,#7C8894)}',
    '.bz-dica{font-size:.74rem;line-height:1.5;color:var(--ink-faint,#7C8894)}',
    '.bz-dica code{font-size:.72rem;padding:0 4px;border-radius:4px;background:var(--line-soft,#EFEFEF);color:var(--ink-dim,#4B5A68)}',
    '.bz-res{margin-top:16px}',
    '.bz-aviso{margin-bottom:10px;padding:8px 10px;border-left:3px solid var(--warn,#B83A22);background:var(--line-soft,#EFEFEF);border-radius:0 6px 6px 0;font-size:.74rem;line-height:1.45}',
    '.bz-aviso.amplo{border-left-color:var(--info,#3C6FD8)}',
    '.bz-aviso button{margin-left:4px;border:1px solid var(--line,#E5E6E7);border-radius:6px;background:transparent;padding:1px 8px;font:inherit;color:inherit;cursor:pointer}',
    '.bz-vazio{padding:14px;border:1px dashed var(--line,#E5E6E7);border-radius:10px;font-size:.8rem;line-height:1.5;color:var(--ink-dim,#4B5A68)}',
    '.bz-vazio strong{color:var(--ink,#1E212C)}',
    '.bz-vazio code{font-size:.74rem;padding:1px 5px;border-radius:4px;background:var(--line-soft,#EFEFEF);color:var(--accent,#FF6C0C)}',
    '.bz-sec{margin-top:16px}',
    '.bz-sec h4 .n{font-weight:600}',
    '.bz-card{display:block;padding:10px 12px;margin-bottom:8px;border:1px solid var(--line,#E5E6E7);border-radius:10px;background:var(--bg,#F5F5F5)}',
    '.bz-card.base{border-left:3px solid var(--info,#3C6FD8)}',
    '.bz-card-topo{display:flex;align-items:center;gap:7px;flex-wrap:wrap}',
    '.bz-chave{font-size:.82rem;font-weight:700;color:var(--accent,#FF6C0C);text-decoration:none}',
    '.bz-chave:hover{text-decoration:underline}',
    '.bz-status{font-size:.62rem;font-weight:700;padding:2px 7px;border-radius:4px;text-transform:uppercase;letter-spacing:.02em;background:var(--line-soft,#EFEFEF);color:var(--ink-dim,#4B5A68)}',
    '.bz-status.indeterminate{background:var(--info-soft,#E2EAFB);color:var(--info,#3C6FD8)}',
    '.bz-status.done{background:var(--ok-soft,#D8F1EB);color:var(--ok,#0B9C7F)}',
    '.bz-status.cancelado{color:var(--ink-faint,#7C8894);text-decoration:line-through}',
    '.bz-proj{font-size:.66rem;color:var(--ink-faint,#7C8894)}',
    '.bz-resumo{margin:5px 0 0;font-size:.82rem;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
    '.bz-meta{margin-top:5px;font-size:.72rem;color:var(--ink-faint,#7C8894)}',
    '.bz-meta b{color:var(--ink-dim,#4B5A68);font-weight:600}',
    '.bz-cita{color:var(--info,#3C6FD8);font-weight:700}',
    '.bz-destaque h4{color:var(--accent,#FF6C0C)}',
    '.bz-destaque .bz-card{border-color:color-mix(in srgb,var(--accent,#FF6C0C) 35%,var(--line,#E5E6E7))}',
    '.bz-rel{margin-left:auto;display:inline-flex;align-items:center;gap:3px;font-size:.64rem;font-weight:700;color:var(--ink-dim,#4B5A68);white-space:nowrap}',
    '.bz-rel i{width:6px;height:6px;border-radius:50%;background:var(--line,#E5E6E7)}',
    '.bz-rel i:nth-child(3){margin-right:3px}',
    '.bz-rel i.on{background:var(--accent,#FF6C0C)}',
    '.bz-pessoas{display:flex;flex-wrap:wrap;gap:6px}',
    '.bz-pessoa{display:inline-flex;align-items:center;gap:5px;padding:2px 9px 2px 3px;border-radius:100px;background:var(--line-soft,#EFEFEF);font-size:.74rem}',
    '.bz-pessoa i{width:18px;height:18px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-style:normal;font-size:.6rem;font-weight:700;text-transform:uppercase;background:var(--line,#E5E6E7);color:var(--ink-dim,#4B5A68)}',
    '.bz-pessoa em{font-style:normal;color:var(--ink-faint,#7C8894)}',
    '.bz-termo{display:inline-flex;align-items:center;gap:5px;padding:2px 3px 2px 9px;border:1px solid var(--line,#E5E6E7);border-radius:100px;font-size:.72rem;font-weight:700}',
    '.bz-termo.falhou{border-color:var(--warn,#B83A22)}',
    '.bz-termo span{font-weight:400;color:var(--ink-faint,#7C8894)}',
    '.bz-termo button{border:0;background:none;padding:0 5px;font-size:.85rem;line-height:1;color:var(--ink-faint,#7C8894);cursor:pointer}',
    '.bz-termo button:hover{color:var(--warn,#B83A22)}',
    '.bz-mais{display:block;margin-top:4px;font-size:.76rem;color:var(--accent,#FF6C0C);text-decoration:none}',
    '.bz-mais:hover{text-decoration:underline}',
    '.bz-base{margin:0;padding:0;list-style:none;font-size:.76rem}',
    '.bz-base li{padding:5px 0;border-bottom:1px solid var(--line-soft,#EFEFEF)}',
    '.bz-base a{color:var(--accent,#FF6C0C);text-decoration:none;font-weight:600}',
    /* Celular: o botão vira só o ícone e o painel ocupa a tela. */
    '@media (max-width:760px){.bz-botao{right:14px;bottom:14px;padding:13px}.bz-botao .bz-rotulo,.bz-botao kbd{display:none}.bz-painel{width:100vw}}',
    '@media (max-width:1100px){.bz-botao kbd{display:none}}',
    '@media print{.bz-botao,.bz-painel{display:none!important}}'
  ].join('');

  var LUPA = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.3-4.3"></path></svg>';
  var CANCELADOS = /^(cancelad[oa]|recusad[oa])$/i;

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function href(url) { return /^https:\/\//.test(String(url || '')) ? esc(url) : '#'; }
  function data(iso) {
    var d = iso ? new Date(iso) : null;
    return d && !isNaN(d) ? d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '';
  }

  /** Número, task ou termo curto -> exata; texto colado -> ampla. */
  function modoPara(t) {
    t = String(t || '').trim();
    if (/\n/.test(t) || t.length > 80) return 'ampla';
    return t.split(/\s+/).length <= 3 ? 'exata' : 'ampla';
  }

  function lerRecentes() {
    try { var v = JSON.parse(localStorage.getItem(CHAVE_RECENTES) || '[]'); return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string'; }).slice(0, 5) : []; }
    catch (e) { return []; }
  }
  function guardarRecente(q) {
    try {
      var l = lerRecentes().filter(function (x) { return x.toLowerCase() !== q.toLowerCase(); });
      l.unshift(q);
      localStorage.setItem(CHAVE_RECENTES, JSON.stringify(l.slice(0, 5)));
    } catch (e) { /* sem armazenamento: só não lembra */ }
  }

  // ---- montagem -------------------------------------------------------------
  var raiz, painel, campo, btnIr, linhaModo, res, telaInteira;
  var modo = null; // null = automático
  var pedido = 0;
  var refazer = null;

  function montar() {
    var st = document.createElement('style');
    st.id = 'bz-css';
    st.textContent = CSS;
    document.head.appendChild(st);

    raiz = document.documentElement;
    var botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'bz-botao';
    botao.title = 'Atalho: tecla /';
    botao.setAttribute('aria-label', 'Buscar no Jira');
    botao.innerHTML = LUPA + '<span class="bz-rotulo">Buscar no Jira</span><kbd>/</kbd>';
    botao.addEventListener('click', abrir);

    painel = document.createElement('aside');
    painel.className = 'bz-painel';
    painel.setAttribute('role', 'dialog');
    painel.setAttribute('aria-label', 'Buscar no Jira');
    painel.innerHTML =
      '<div class="bz-topo"><span class="bz-marca">' + LUPA + '</span>' +
        '<div class="bz-titulo"><b>Buscar no Jira</b><span>Número do chamado, task, termo ou a mensagem do cliente</span></div>' +
        '<a class="bz-acao" id="bz-inteira" href="/pesquisa" title="Abrir a pesquisa na tela inteira">Tela inteira ↗</a>' +
        '<button type="button" class="bz-acao" id="bz-fechar" title="Fechar (Esc)" aria-label="Fechar">✕</button></div>' +
      '<div class="bz-corpo">' +
        '<form class="bz-form" id="bz-form">' +
          '<textarea class="bz-campo" id="bz-campo" rows="1" maxlength="4000" placeholder="Nº do chamado, task, termo — ou cole a mensagem do cliente" aria-label="Número do chamado, task, termo ou mensagem do cliente"></textarea>' +
          '<div class="bz-linha"><span class="bz-modo" id="bz-modo"></span><button type="submit" class="bz-ir" id="bz-ir">' + LUPA.replace('<svg', '<svg width="14" height="14" style="stroke:currentColor;fill:none;stroke-width:2.3"') + 'Pesquisar</button></div>' +
        '</form>' +
        '<div id="bz-res" aria-live="polite"></div>' +
      '</div>';

    document.body.appendChild(botao);
    document.body.appendChild(painel);

    // Em tela larga o conteúdo termina antes da borda da janela e o botão ficava
    // perdido no canto: ele se alinha à borda direita do menu do topo (a mesma
    // linha do "Sair" e do "Filtrar tarefas").
    function alinhar() {
      var nav = document.querySelector('nav[data-menu]');
      var dir = window.innerWidth <= 760 ? 14 : 22;
      if (nav && window.innerWidth > 760) {
        var r = nav.getBoundingClientRect();
        if (r.width) dir = Math.max(dir, Math.round(document.documentElement.clientWidth - r.right));
      }
      botao.style.right = dir + 'px';
    }
    alinhar();
    window.addEventListener('resize', alinhar);
    setTimeout(alinhar, 600); // o menu termina de montar depois de /api/eu
    campo = painel.querySelector('#bz-campo');
    btnIr = painel.querySelector('#bz-ir');
    linhaModo = painel.querySelector('#bz-modo');
    res = painel.querySelector('#bz-res');
    telaInteira = painel.querySelector('#bz-inteira');

    painel.querySelector('#bz-fechar').addEventListener('click', fechar);
    painel.querySelector('#bz-form').addEventListener('submit', function (ev) { ev.preventDefault(); pesquisar(); });
    campo.addEventListener('input', function () { crescer(); if (!campo.value.trim()) modo = null; atualizarModo(); });
    campo.addEventListener('keydown', function (ev) {
      // Enter pesquisa; Shift+Enter quebra linha (mensagem colada).
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); pesquisar(); }
    });
    painel.addEventListener('click', function (ev) {
      // A mensagem vai para a tela inteira pela aba (sessionStorage), não pela URL.
      var a = ev.target.closest && ev.target.closest('a[href="/pesquisa?modo=ampla"]');
      if (a && campo.value.trim()) {
        try { sessionStorage.setItem(CHAVE_TEXTO, campo.value); } catch (e) {}
      }
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && raiz.classList.contains('bz-aberto')) { fechar(); return; }
      if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      var a = document.activeElement;
      if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
      ev.preventDefault();
      abrir();
    });

    atualizarModo();
    mostrarInicio();
  }

  function abrir() {
    raiz.classList.add('bz-aberto');
    setTimeout(function () { campo.focus(); }, 60);
  }
  function fechar() {
    raiz.classList.remove('bz-aberto');
    var b = document.querySelector('.bz-botao');
    if (b) b.focus();
  }
  function crescer() {
    campo.style.height = 'auto';
    campo.style.height = Math.min(campo.scrollHeight + 2, 220) + 'px';
  }

  function modoAtual() { return modo || modoPara(campo.value); }

  function atualizarModo() {
    var t = campo.value.trim();
    var m = modoAtual();
    if (!t) { linhaModo.innerHTML = 'Enter pesquisa · Shift+Enter quebra linha'; }
    else {
      linhaModo.innerHTML = (m === 'exata' ? 'Busca <b>exata</b> pelo número' : 'Busca <b>ampla</b> pelo assunto') +
        ' · <button type="button" id="bz-trocar">usar ' + (m === 'exata' ? 'ampla' : 'exata') + '</button>';
      linhaModo.querySelector('#bz-trocar').addEventListener('click', function () {
        modo = m === 'exata' ? 'ampla' : 'exata';
        atualizarModo();
        campo.focus();
      });
    }
    var q = campo.value.trim();
    telaInteira.href = q && m === 'exata' ? '/pesquisa?q=' + encodeURIComponent(q) : (q ? '/pesquisa?modo=ampla' : '/pesquisa');
  }

  function mostrarInicio() {
    var recentes = lerRecentes();
    var h = '<div class="bz-atalhos"><h4>Atalhos</h4><div class="bz-chips">' +
      '<button type="button" class="bz-chip" data-acao="colar">📋 Colar mensagem do cliente</button>' +
      '<button type="button" class="bz-chip" data-acao="numero"># Buscar por número</button></div>';
    if (recentes.length) {
      h += '<h4>Últimas pesquisas</h4><div class="bz-chips">' + recentes.map(function (q) {
        return '<button type="button" class="bz-chip" data-recente="' + esc(q) + '">' + esc(q) + '</button>';
      }).join('') + '</div>';
    }
    h += '<p class="bz-dica"><b>Exata:</b> o número do chamado (TTB, 10 dígitos; ACS, 11), a task (<code>JDCBBRB-420</code>) ou um termo (<code>T402COGC_HST</code>).<br>' +
      '<b>Ampla:</b> cole a mensagem do cliente; a busca separa os nomes técnicos e acha tasks do mesmo assunto e quem mexeu nelas. Pode ter ruído.<br>' +
      'Só leitura. A mensagem não é guardada nem passa por IA.</p></div>';
    res.innerHTML = h;
    Array.prototype.forEach.call(res.querySelectorAll('[data-recente]'), function (b) {
      b.addEventListener('click', function () { campo.value = b.getAttribute('data-recente'); modo = null; crescer(); atualizarModo(); pesquisar(); });
    });
    var colar = res.querySelector('[data-acao="colar"]');
    colar.addEventListener('click', function () {
      // Lê a área de transferência quando o navegador deixa; senão, só foca.
      var ok = navigator.clipboard && navigator.clipboard.readText;
      if (!ok) { campo.focus(); return; }
      navigator.clipboard.readText().then(function (t) {
        if (t && t.trim()) { campo.value = t.slice(0, 4000); modo = null; crescer(); atualizarModo(); pesquisar(); }
        else campo.focus();
      }).catch(function () { campo.focus(); });
    });
    res.querySelector('[data-acao="numero"]').addEventListener('click', function () {
      modo = 'exata'; campo.value = ''; crescer(); atualizarModo();
      campo.placeholder = 'Ex.: 2026110141, JDCBBRB-420';
      campo.focus();
    });
  }

  // ---- pesquisa -------------------------------------------------------------
  function pesquisar(termos) {
    var t = campo.value.trim();
    if (!t) { mostrarInicio(); return; }
    var m = modoAtual();
    var meu = ++pedido;
    refazer = function () { pesquisar(termos); };
    btnIr.disabled = true;
    res.innerHTML = '<div class="bz-res"><div class="bz-vazio">' + (m === 'exata' ? 'Pesquisando no Jira…' : 'Pesquisando cada termo no Jira…') + '</div></div>';
    var req = m === 'exata'
      ? fetch('/api/pesquisa?q=' + encodeURIComponent(t), { cache: 'no-store' })
      : fetch('/api/pesquisa/ampla', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(termos ? { texto: t, termos: termos } : { texto: t }) });
    req.then(function (r) {
      if (r.status === 401) { window.location.href = '/login.html'; return null; }
      return r.json().then(function (j) { return { ok: r.ok, j: j }; });
    }).then(function (x) {
      if (!x || meu !== pedido) return;
      if (!x.ok) { res.innerHTML = '<div class="bz-res"><div class="bz-aviso">' + esc((x.j && x.j.erro) || 'Não foi possível pesquisar agora.') + '</div></div>'; return; }
      if (m === 'exata') { guardarRecente(t); renderExata(x.j); }
      else renderAmpla(x.j);
    }).catch(function () {
      if (meu === pedido) res.innerHTML = '<div class="bz-res"><div class="bz-aviso">Sem conexão com o servidor. <button type="button" id="bz-tentar">Tentar de novo</button></div></div>';
      ligarTentar();
    }).then(function () { if (meu === pedido) btnIr.disabled = false; });
  }

  function ligarTentar() {
    var b = res.querySelector('#bz-tentar');
    if (b) b.addEventListener('click', function () { if (refazer) refazer(); });
  }

  function statusHtml(s, cat) {
    var c = CANCELADOS.test(String(s || '').trim()) ? 'cancelado' : cat;
    return '<span class="bz-status ' + esc(c) + '">' + esc(s || '—') + '</span>';
  }
  // Pesquisa ampla: relevância em relação à melhor da pesquisa (três pontos).
  var NIVEIS = { alta: [3, 'alta'], media: [2, 'média'], baixa: [1, 'baixa'] };
  function relHtml(nivel) {
    var v = NIVEIS[nivel] || NIVEIS.baixa;
    return '<span class="bz-rel" title="Relevância ' + v[1] + ': termo raro e termo no título contam mais">' +
      [1, 2, 3].map(function (k) { return '<i' + (k <= v[0] ? ' class="on"' : '') + '></i>'; }).join('') + v[1] + '</span>';
  }

  function cardHtml(i) {
    var h = '<div class="bz-card' + (i.origem === 'base' ? ' base' : '') + '"><div class="bz-card-topo">' +
      '<a class="bz-chave" href="' + href(i.url) + '" target="_blank" rel="noopener noreferrer">' + esc(i.chave) + ' ↗</a>' +
      statusHtml(i.status, i.categoria) + (i.projeto !== PROJETO ? '<span class="bz-proj">' + esc(i.projeto) + '</span>' : '') +
      (i.origem === 'base' ? '<span class="bz-proj">da nossa base</span>' : '') + (i.nivel ? relHtml(i.nivel) : '') + '</div>' +
      '<p class="bz-resumo" title="' + esc(i.resumo) + '">' + esc(i.resumo) + '</p>';
    var meta = [];
    var quem = (i.envolvidos && i.envolvidos.length) ? i.envolvidos : (i.responsavel ? [i.responsavel] : []);
    meta.push(quem.length ? 'Quem: <b>' + quem.map(esc).join(', ') + '</b>' : 'Sem responsável');
    var quando = i.resolvido ? 'concluída ' + data(i.resolvido) : (i.atualizado ? 'atualizada ' + data(i.atualizado) : '');
    if (quando) meta.push(quando);
    if (i.motivos && i.motivos.length) {
      meta.push('por que: ' + i.motivos.map(function (m) {
        return '<span class="bz-cita">' + esc(m.termo) + '</span>' + (m.titulo ? ' no título' : (m.raro ? ' (raro)' : ''));
      }).join(', ') + (i.cancelada ? ' · cancelada' : ''));
    } else if (i.termos && i.termos.length) meta.push('cita <span class="bz-cita">' + i.termos.map(esc).join(', ') + '</span>');
    if (i.via && i.via.length) meta.push('na subtarefa ' + i.via.map(function (v) { return '<a class="bz-chave" style="font-size:inherit" href="' + href(v.url) + '" target="_blank" rel="noopener noreferrer" title="' + esc(v.resumo) + '">' + esc(v.chave) + '</a>'; }).join(', '));
    return h + '<div class="bz-meta">' + meta.join(' · ') + '</div></div>';
  }
  function listaHtml(titulo, lista, total) {
    if (!lista.length) return '';
    var mostra = lista.slice(0, MAX_LISTA);
    var n = Math.max(total || 0, lista.length);
    return '<div class="bz-sec"><h4>' + titulo + ' <span class="n">' + (n > mostra.length ? mostra.length + ' de ' + n : n) + '</span></h4>' +
      mostra.map(cardHtml).join('') + (n > mostra.length ? '<a class="bz-mais" href="' + esc(telaInteira.getAttribute('href')) + '">Ver todas na tela inteira →</a>' : '') + '</div>';
  }
  function baseHtml(b) {
    var linhas = b.demandas.map(function (d) { return '<li><a href="/demandas">Demandas</a> · ' + esc(d.acs) + ' · ' + esc(d.nome) + (d.jira ? ' · ' + esc(d.jira) : '') + '</li>'; })
      .concat(b.expedicoes.map(function (e) { return '<li><a href="/expedicoes">Expedições</a> · ' + esc(e.nome) + (e.jira ? ' · ' + esc(e.jira) : '') + '</li>'; }));
    return linhas.length ? '<div class="bz-sec"><h4>Na nossa base</h4><ul class="bz-base">' + linhas.join('') + '</ul></div>' : '';
  }
  function outrosHtml(lista, total) {
    if (!lista.length) return '';
    var n = Math.max(total || 0, lista.length);
    return '<div class="bz-sec"><a class="bz-mais" href="' + esc(telaInteira.getAttribute('href')) + '">+ ' + n + (n === 1 ? ' task de outro time ou projeto' : ' tasks de outros times e projetos') + ' — ver na tela inteira →</a></div>';
  }

  function renderExata(r) {
    var h = '<div class="bz-res">';
    var temBase = r.base.demandas.length || r.base.expedicoes.length;
    var nada = !r.projeto.length && !r.outros.length && !temBase;
    if (r.jira.status !== 'ok') {
      h += '<div class="bz-aviso">' + (nada ? 'Não consegui consultar o Jira agora, então ainda não sei se existe task com <strong>' + esc(r.termo) + '</strong>.' : 'O Jira não respondeu agora: abaixo, só o que está na nossa base.') +
        ' <button type="button" id="bz-tentar">Tentar de novo</button></div>';
    }
    if (nada && r.jira.status === 'ok') {
      var t = '<strong>' + esc(r.termo) + '</strong>';
      if (r.tipo === 'ttb' || r.tipo === 'numero') h += '<div class="bz-vazio">Nenhuma task tem o número ' + t + ': a task do chamado ainda não foi criada. Padrão do título: <code>TTB - ' + esc(r.termo) + ' - descrição</code>.<br>Tem a mensagem do cliente? Cole aqui para a busca ampla, pelo assunto.</div>';
      else if (r.tipo === 'acs') h += '<div class="bz-vazio">Nenhuma task cita o ACS ' + t + ', e ele não está em Demandas nem em Expedições.</div>';
      else if (r.tipo === 'jira') h += '<div class="bz-vazio">A task ' + t + ' não existe no Jira ou a conta do sistema não tem acesso a ela.</div>';
      else h += '<div class="bz-vazio">Nada encontrado para ' + t + '. O Jira busca palavras inteiras (<code>PCRA2_CARGA</code>, não <code>PCRA</code>).</div>';
    }
    h += listaHtml('No ' + PROJETO, r.projeto) + baseHtml(r.base) + outrosHtml(r.outros);
    res.innerHTML = h + '</div>';
    ligarTentar();
  }

  function renderAmpla(r) {
    var h = '<div class="bz-res"><div class="bz-aviso amplo"><b>Pesquisa ampla:</b> tasks que citam os mesmos nomes técnicos. São sugestões e podem ter ruído.</div>';
    if (r.jira.status === 'indisponivel') h += '<div class="bz-aviso">O Jira não respondeu agora. <button type="button" id="bz-tentar">Tentar de novo</button></div>';
    else if (r.jira.status === 'parcial') h += '<div class="bz-aviso">Alguns termos não foram consultados (marcados em vermelho). <button type="button" id="bz-tentar">Tentar de novo</button></div>';
    var termos = r.termos.map(function (t) { return t.termo; });
    if (r.termos.length) {
      h += '<div class="bz-sec"><h4>Termos pesquisados</h4><div class="bz-chips">' + r.termos.map(function (t) {
        return '<span class="bz-termo' + (t.falhou ? ' falhou' : '') + '">' + esc(t.termo) + ' <span>' + (t.falhou ? '—' : t.tasks + (t.maisDe ? '+' : '')) + '</span>' +
          (r.termos.length > 1 ? '<button type="button" data-tirar="' + esc(t.termo) + '" title="Tirar este termo e pesquisar de novo" aria-label="Tirar ' + esc(t.termo) + '">×</button>' : '') + '</span>';
      }).join('') + '</div></div>';
    }
    (r.exatas || []).forEach(function (e) {
      var todas = e.projeto.concat(e.outros);
      h += '<div class="bz-sec"><h4>Este chamado · ' + esc(e.termo) + '</h4>' + (todas.length ? todas.slice(0, 3).map(cardHtml).join('')
        : '<div class="bz-vazio">' + (e.jira.status !== 'ok' ? 'Não consegui consultar o Jira para este número.' : 'Ainda não há task com este número.') + '</div>') + '</div>';
    });
    var provaveis = r.provaveis || [];
    if (provaveis.length) {
      h += '<div class="bz-sec bz-destaque"><h4>Mais prováveis <span class="n">' + provaveis.length + '</span></h4>' +
        '<p class="bz-dica" style="margin:-4px 0 8px">De qualquer time. Termo raro e termo no título contam mais.</p>' + provaveis.map(cardHtml).join('') + '</div>';
    }
    if (r.pessoas.length) {
      h += '<div class="bz-sec"><h4>Quem mais aparece no assunto</h4><div class="bz-pessoas">' + r.pessoas.map(function (p) {
        return '<span class="bz-pessoa"><i>' + esc(String(p.nome).charAt(0)) + '</i>' + esc(p.nome) + ' <em>· ' + p.tasks + '</em></span>';
      }).join('') + '</div></div>';
    }
    if (r.nosso.length) h += listaHtml((provaveis.length ? 'Outras do ' : 'Mesmo assunto no ') + PROJETO, r.nosso, r.totalNosso);
    else if (r.jira.status !== 'indisponivel' && r.termos.length && !provaveis.length) h += '<div class="bz-sec"><h4>Mesmo assunto no ' + PROJETO + '</h4><div class="bz-vazio">Nenhuma task do ' + PROJETO + ' cita esses termos.</div></div>';
    h += baseHtml(r.base) + outrosHtml(r.outros, r.totalOutros);
    res.innerHTML = h + '</div>';
    ligarTentar();
    Array.prototype.forEach.call(res.querySelectorAll('[data-tirar]'), function (b) {
      b.addEventListener('click', function () {
        var tirar = b.getAttribute('data-tirar');
        pesquisar(termos.filter(function (t) { return t !== tirar; }));
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', montar);
  else montar();
})();
