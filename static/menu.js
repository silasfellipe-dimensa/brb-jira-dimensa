/* Menu do topo, igual em todas as telas do Kanban BRB. Um arquivo, carregado
 * por todas as telas - mudar aqui muda o sistema inteiro.
 *
 *   <nav class="menux" data-menu="demandas"></nav>
 *   <script src="/menu.js"></script>
 *
 * data-menu é a tela atual, que fica de fora do menu. Vazio (Admin,
 * Histórico de demandas) = mostra todos. Ordem igual à do Portal: Kanban BRB,
 * Demandas, Expedições, Evidências, Dashboard, Qualidade. Depois: Portal, quem está logado e
 * Sair. A pesquisa de chamado não é item do menu: é o botão flutuante "Achar
 * chamado" (static/busca.js), que este arquivo carrega só para a equipe.
 *
 * Quem vê o quê vem de /api/eu - as mesmas regras de sempre:
 *   - Expedições e o "Buscar no Jira" só para quem edita (Dimensa/Evertec);
 *   - Qualidade só quando o servidor manda o endereço (Dimensa/Evertec/BRB);
 *   - Portal só quando o servidor manda o endereço (o BRB não usa o Portal).
 * Esconder aqui é só o atalho: a barreira de verdade é a do servidor em cada
 * rota. Nada vindo da API vira markup: e-mail por textContent, endereço do
 * Portal só com http(s).
 *
 * window.Menu.eu é a Promise de /api/eu, para a tela reaproveitar em vez de
 * buscar de novo. */
(function () {
  if (window.Menu) return;

  var CSS = [
    '.menux{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end;align-self:flex-start;margin-top:2px}',
    '.menux-itens{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.menux-item{display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border-radius:8px;',
    /* Reserva para tela sem --accent-soft (o Admin): um véu do próprio acento,
     * que acompanha o tema - um #FFE8D9 fixo acendia no escuro. */
    'border:1px solid var(--accent,#FF6C0C);background:var(--accent-soft,color-mix(in srgb,var(--accent,#FF6C0C) 14%,transparent));',
    'color:var(--accent,#FF6C0C);',
    'font-family:inherit;font-size:.8rem;font-weight:600;text-decoration:none;white-space:nowrap;transition:opacity .15s ease}',
    '.menux-item:hover{opacity:.8}',
    '.menux-item svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
    '.menux-conta{display:flex;align-items:center;gap:10px;padding-left:12px;margin-left:2px;border-left:1px solid var(--line,#E5E6E7)}',
    '.menux-portal{display:inline-flex;align-items:center;gap:5px;color:var(--ink-faint,#7C8894);font-size:.8rem;text-decoration:none}',
    '.menux-portal:hover{color:var(--accent,#FF6C0C)}',
    '.menux-portal svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
    '.menux-quem{display:flex;align-items:center;gap:7px;font-size:.8rem;color:var(--ink-dim,#4B5A68)}',
    '.menux-avatar{width:26px;height:26px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;',
    'background:var(--line,#E5E6E7);color:var(--ink,#1E212C);font-size:.74rem;font-weight:700;text-transform:uppercase}',
    '.menux-sair{background:none;border:none;padding:0;cursor:pointer;font-family:inherit;font-size:.76rem;',
    'color:var(--ink-faint,#7C8894);text-decoration:underline}',
    '.menux-sair:hover{color:var(--warn,#A8452E)}',
    /* Notebook: o e-mail inteiro não cabe ao lado do menu - fica a inicial,
     * com o e-mail ao passar o mouse. */
    '@media (max-width:1280px){.menux-email{display:none}}',
    '@media print{.menux{display:none!important}}'
  ].join('');

  // Literais fechados, escolhidos por chave - nada da API vira ícone.
  var ICONES = {
    kanban: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="4.6" height="16" rx="1.2"></rect>' +
      '<rect x="9.7" y="4" width="4.6" height="11" rx="1.2"></rect><rect x="16.4" y="4" width="4.6" height="14" rx="1.2"></rect></svg>',
    demandas: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"></path></svg>',
    expedicoes: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"></path></svg>',
    evidencias: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"></path>' +
      '<path d="M14 3v6h6"></path><path d="M8.5 15l2.5 2.5 4.5-5"></path></svg>',
    dashboard: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V10M10 19V5M16 19v-6M22 19H2"></path></svg>',
    qualidade: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 2.8l6.2 2.4v5.6c0 3.9-2.6 7.3-6.2 8.4-3.6-1.1-6.2-4.5-6.2-8.4V5.2z"></path>' +
      '<path d="M6.2 10.9l2 2 3.5-3.9"></path><path d="M17.8 9h3.4M17.8 13h3.4M17.8 17h3.4"></path></svg>',
    portal: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"></path></svg>'
  };

  /* Mesma ordem do Portal. Cada item só aparece para quem tem acesso:
   *   Demandas e Expedições -> eu.editor (Dimensa/Evertec);
   *   Qualidade  -> eu.qualidadeUrl (o servidor só manda para quem o
   *                 Qualidade aceita; é outro sistema, com login próprio). */
  var ITENS = [
    { id: 'kanban', rotulo: 'Kanban BRB', href: '/', dica: 'Quadro do sprint, espelhado do Jira' },
    { id: 'demandas', rotulo: 'Demandas', href: '/demandas', dica: 'Demandas em andamento no ACS do BRB', soEquipe: true },
    { id: 'expedicoes', rotulo: 'Expedições', href: '/expedicoes', dica: 'Checklist do time antes de comitar e de expedir', soEquipe: true },
    // Todos veem (o BRB é o cliente da evidência); criar e editar é só da equipe.
    { id: 'evidencias', rotulo: 'Evidências', href: '/evidencias', dica: 'Evidências de teste dos ciclos do Zephyr, no layout Evertec' },
    { id: 'dashboard', rotulo: 'Dashboard', href: '/dashboard', dica: 'Métricas e andamento do sprint' },
    // /ir/qualidade leva o passe do login único (sso.js); sem ele, o servidor
    // manda para o endereço puro e o Qualidade pede login, como antes.
    { id: 'qualidade', rotulo: 'Qualidade', href: '/ir/qualidade', dica: 'Linha de base de escapes na homologação do cliente', externo: 'qualidadeUrl' }
  ];

  function hrefSeguro(url) {
    try {
      var u = new URL(String(url), window.location.origin);
      return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null;
    } catch (e) { return null; }
  }

  function el(tag, classe, texto) {
    var e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto != null) e.textContent = texto;
    return e;
  }

  /* A tela atual não entra: um botão para onde já se está não leva a lugar
   * nenhum. Telas que não são item do menu (Histórico de demandas, Admin)
   * usam data-menu="" e mostram todos - "Demandas" é o caminho de volta. */
  function itensHtml(atual, eu) {
    var h = '';
    ITENS.forEach(function (i) {
      if (i.id === atual) return;
      if (i.soEquipe && !(eu && eu.editor)) return;
      // Item de outro sistema: só aparece se o servidor mandou o endereço
      // (= a pessoa tem acesso); o link em si é sempre o nosso, fixo.
      if (i.externo && !(eu && eu[i.externo])) return;
      h += '<a class="menux-item" href="' + i.href + '" data-item="' + i.id + '" title="' + i.dica + '">' +
        ICONES[i.id] + i.rotulo + '</a>';
    });
    return h;
  }

  function contaEl(eu) {
    var conta = el('div', 'menux-conta');
    var portal = eu.hubUrl ? hrefSeguro(eu.hubUrl) : null;
    if (portal) {
      var a = el('a', 'menux-portal');
      a.href = portal;
      a.title = 'Voltar ao Portal';
      a.innerHTML = ICONES.portal;
      a.appendChild(document.createTextNode('Portal'));
      conta.appendChild(a);
    }
    if (eu.email) {
      var quem = el('span', 'menux-quem');
      quem.title = eu.email;
      quem.appendChild(el('span', 'menux-avatar', String(eu.email).charAt(0)));
      quem.appendChild(el('span', 'menux-email', eu.email));
      conta.appendChild(quem);
    }
    var sair = el('button', 'menux-sair', 'Sair');
    sair.type = 'button';
    sair.addEventListener('click', function () {
      fetch('/auth/logout', { method: 'POST' })
        .catch(function () {})
        .then(function () { window.location.href = '/login.html'; });
    });
    conta.appendChild(sair);
    return conta;
  }

  var eu = fetch('/api/eu', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; });

  function montar() {
    if (!document.getElementById('menux-css')) {
      var st = document.createElement('style');
      st.id = 'menux-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    var navs = document.querySelectorAll('nav[data-menu]');
    // Antes de /api/eu responder: só o que todo mundo vê, sem esperar a rede.
    navs.forEach(function (nav) {
      nav.classList.add('menux');
      if (!nav.getAttribute('aria-label')) nav.setAttribute('aria-label', 'Menu');
      var itens = el('div', 'menux-itens');
      itens.innerHTML = itensHtml(nav.getAttribute('data-menu'), null);
      nav.innerHTML = '';
      nav.appendChild(itens);
    });
    eu.then(function (dados) {
      if (!dados) return;
      carregarBusca(dados);
      navs.forEach(function (nav) {
        nav.querySelector('.menux-itens').innerHTML = itensHtml(nav.getAttribute('data-menu'), dados);
        var velha = nav.querySelector('.menux-conta');
        if (velha) velha.remove();
        nav.appendChild(contaEl(dados));
      });
    });
  }

  /* Botão flutuante Buscar no Jira: só para a equipe; o BRB e a TOTVS nem baixam. */
  function carregarBusca(dados) {
    if (!dados.editor || document.getElementById('bz-js')) return;
    var s = document.createElement('script');
    s.id = 'bz-js';
    s.src = '/busca.js';
    document.body.appendChild(s);
  }

  window.Menu = { eu: eu };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', montar);
  else montar();
})();
