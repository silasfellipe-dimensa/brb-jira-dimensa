/* Caixas de diálogo do sistema (confirmar / avisar), no lugar dos pop-ups
 * genéricos do navegador. Sem dependência: um arquivo, usado por todas as
 * telas que precisam perguntar algo.
 *
 *   Dialogo.confirmar({ titulo, destaque, mensagem, rotuloConfirmar, rotuloCancelar, tom })
 *       -> Promise<boolean>   (true = confirmou; Esc, clique fora e Cancelar = false)
 *   Dialogo.avisar({ titulo, mensagem, rotulo, tom })
 *       -> Promise<void>
 *
 *   tom: 'perigo' (excluir; o foco já começa em Cancelar, para Enter nunca
 *        apagar sem querer), 'aviso' ou 'info'.
 *   destaque: o nome do que está sendo afetado (ex.: número e nome da demanda),
 *        mostrado numa caixa à parte. Todo texto entra por textContent, então
 *        o que o usuário digitou nunca é interpretado como HTML.
 *
 * Usa <dialog> nativo (showModal): fica acima de qualquer outra caixa aberta,
 * trava o foco e fecha com Esc. As cores vêm das variáveis da própria tela
 * (--bg-panel / --painel, --accent / --acento ...), com valores de reserva,
 * então a caixa acompanha o tema claro/escuro de cada sistema. */
(function () {
  if (window.Dialogo) return;

  var CSS = [
    'dialog.dlgx{--dx-bg:var(--bg-panel,var(--painel,#fff));--dx-ink:var(--ink,#1E212C);--dx-dim:var(--ink-dim,#4B5A68);',
    '--dx-faint:var(--ink-faint,#7C8894);--dx-line:var(--line,var(--linha,#E5E6E7));--dx-soft:var(--line-soft,var(--linha-suave,#EFEFEF));',
    '--dx-accent:var(--accent,var(--acento,#FF6C0C));--dx-warn:var(--warn,var(--alerta,#A8452E));',
    'border:1px solid var(--dx-line);border-radius:16px;padding:0;margin:auto;width:min(440px,calc(100vw - 32px));',
    'background:var(--dx-bg);color:var(--dx-ink);font-family:Lato,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
    'box-shadow:0 24px 60px rgba(0,0,0,.38),0 2px 6px rgba(0,0,0,.2);overflow:hidden;animation:dlgx-entra .16s ease-out}',
    'dialog.dlgx::backdrop{background:rgba(15,17,24,.58);backdrop-filter:blur(3px);animation:dlgx-fundo .16s ease-out}',
    '.dlgx-corpo{padding:24px 24px 8px;display:flex;gap:16px;align-items:flex-start}',
    '.dlgx-icone{flex:0 0 auto;width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;',
    'background:color-mix(in srgb,var(--dx-tom) 15%,transparent);color:var(--dx-tom)}',
    '.dlgx-icone svg{width:22px;height:22px}',
    'dialog.dlgx.perigo{--dx-tom:var(--dx-warn)}dialog.dlgx.aviso{--dx-tom:var(--dx-accent)}dialog.dlgx.info{--dx-tom:var(--dx-accent)}',
    '.dlgx-texto{min-width:0;flex:1}',
    '.dlgx-titulo{margin:2px 0 0;font-size:1.05rem;font-weight:700;line-height:1.3;letter-spacing:-.005em}',
    '.dlgx-destaque{margin:12px 0 0;padding:9px 12px;border-radius:10px;border-left:4px solid var(--dx-tom);',
    'background:var(--dx-soft);font-size:.86rem;font-weight:600;line-height:1.4;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}',
    '.dlgx-msg{margin:12px 0 0;font-size:.84rem;line-height:1.5;color:var(--dx-dim);overflow-wrap:anywhere}',
    '.dlgx-msg+.dlgx-msg{margin-top:8px}',
    '.dlgx-rodape{display:flex;gap:10px;justify-content:flex-end;padding:18px 24px 22px}',
    '.dlgx-btn{font:inherit;font-size:.84rem;font-weight:600;cursor:pointer;border-radius:10px;padding:9px 18px;min-width:96px;',
    'border:1px solid var(--dx-line);background:transparent;color:var(--dx-dim);transition:background .12s,border-color .12s,box-shadow .12s}',
    '.dlgx-btn:hover{border-color:var(--dx-faint);color:var(--dx-ink)}',
    '.dlgx-btn:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--dx-tom) 35%,transparent)}',
    '.dlgx-btn.principal{background:var(--dx-tom);border-color:var(--dx-tom);color:#fff}',
    '.dlgx-btn.principal:hover{filter:brightness(1.07);color:#fff}',
    '@media (prefers-color-scheme:dark){.dlgx-btn.principal{color:#1E212C}.dlgx-btn.principal:hover{color:#1E212C}}',
    '@media (max-width:480px){.dlgx-rodape{flex-direction:column-reverse}.dlgx-btn{width:100%}}',
    '@keyframes dlgx-entra{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}',
    '@keyframes dlgx-fundo{from{opacity:0}to{opacity:1}}',
    '@media (prefers-reduced-motion:reduce){dialog.dlgx,dialog.dlgx::backdrop{animation:none}}'
  ].join('');

  var ICONES = {
    perigo: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/>',
    aviso: '<path d="M12 3l10 18H2L12 3zM12 10v5M12 18h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>'
  };

  var fila = Promise.resolve();
  var contador = 0;

  function injetarCss() {
    if (document.getElementById('dlgx-css')) return;
    var st = document.createElement('style');
    st.id = 'dlgx-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function el(tag, classe, texto) {
    var e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto !== undefined && texto !== null) e.textContent = texto;
    return e;
  }

  function abrir(opcoes, comCancelar) {
    return new Promise(function (resolve) {
      injetarCss();
      var tom = ['perigo', 'aviso', 'info'].indexOf(opcoes.tom) >= 0 ? opcoes.tom : (comCancelar ? 'aviso' : 'info');
      var id = 'dlgx-' + (++contador);
      var anterior = document.activeElement;

      var caixa = el('dialog', 'dlgx ' + tom);
      caixa.setAttribute('role', comCancelar ? 'alertdialog' : 'dialog');
      caixa.setAttribute('aria-labelledby', id + '-t');

      var corpo = el('div', 'dlgx-corpo');
      var icone = el('div', 'dlgx-icone');
      icone.setAttribute('aria-hidden', 'true');
      icone.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONES[tom] + '</svg>';
      var texto = el('div', 'dlgx-texto');
      var titulo = el('h2', 'dlgx-titulo', opcoes.titulo || (comCancelar ? 'Confirmar?' : 'Aviso'));
      titulo.id = id + '-t';
      texto.appendChild(titulo);
      if (opcoes.destaque) texto.appendChild(el('div', 'dlgx-destaque', opcoes.destaque));
      var paragrafos = String(opcoes.mensagem || '').split(/\n{2,}/).filter(Boolean);
      paragrafos.forEach(function (p, i) {
        var m = el('p', 'dlgx-msg', p);
        if (i === 0) { m.id = id + '-d'; caixa.setAttribute('aria-describedby', id + '-d'); }
        texto.appendChild(m);
      });
      corpo.appendChild(icone);
      corpo.appendChild(texto);

      var rodape = el('div', 'dlgx-rodape');
      var cancelar = null;
      if (comCancelar) {
        cancelar = el('button', 'dlgx-btn cancelar dlg-cancelar', opcoes.rotuloCancelar || 'Cancelar');
        cancelar.type = 'button';
        rodape.appendChild(cancelar);
      }
      var ok = el('button', 'dlgx-btn principal dlg-confirmar', opcoes.rotuloConfirmar || opcoes.rotulo || (comCancelar ? 'Confirmar' : 'Entendi'));
      ok.type = 'button';
      rodape.appendChild(ok);

      caixa.appendChild(corpo);
      caixa.appendChild(rodape);

      var fechado = false;
      function fechar(resultado) {
        if (fechado) return;
        fechado = true;
        document.removeEventListener('keydown', teclas, true);
        if (typeof caixa.close === 'function' && caixa.open) { try { caixa.close(); } catch (e) { /* já fechada */ } }
        if (caixa.parentNode) caixa.parentNode.removeChild(caixa);
        if (anterior && typeof anterior.focus === 'function' && document.body.contains(anterior)) anterior.focus();
        resolve(resultado);
      }
      function teclas(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); fechar(false); }
      }

      ok.addEventListener('click', function () { fechar(true); });
      if (cancelar) cancelar.addEventListener('click', function () { fechar(false); });
      // clique no fundo (fora da caixa) cancela; o <dialog> não tem padding, então só o fundo chega aqui
      caixa.addEventListener('click', function (ev) { if (ev.target === caixa) fechar(false); });
      caixa.addEventListener('cancel', function (ev) { ev.preventDefault(); fechar(false); });
      document.addEventListener('keydown', teclas, true);

      document.body.appendChild(caixa);
      if (typeof caixa.showModal === 'function') caixa.showModal();
      else caixa.setAttribute('open', '');
      // Excluir: o foco começa em "Cancelar" - Enter sem querer nunca apaga.
      (tom === 'perigo' && cancelar ? cancelar : ok).focus();
    });
  }

  // uma caixa por vez: pedidos seguidos esperam a anterior ser respondida
  function enfileirar(fn) {
    var p = fila.then(fn);
    fila = p.then(function () {}, function () {});
    return p;
  }

  window.Dialogo = {
    confirmar: function (opcoes) { return enfileirar(function () { return abrir(opcoes || {}, true); }); },
    avisar: function (opcoes) { return enfileirar(function () { return abrir(opcoes || {}, false).then(function () {}); }); }
  };
})();
