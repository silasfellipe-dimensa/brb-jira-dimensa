/* Caixas de diálogo do sistema (confirmar / avisar), no lugar dos pop-ups
 * genéricos do navegador. Sem dependência: um arquivo, usado por todas as
 * telas que precisam perguntar algo.
 *
 *   Dialogo.confirmar({ titulo, destaque, mensagem, rotuloConfirmar, rotuloCancelar, tom })
 *       -> Promise<boolean>   (true = confirmou; Esc, clique fora e Cancelar = false)
 *   Dialogo.avisar({ titulo, mensagem, rotulo, tom })
 *       -> Promise<void>
 *   Dialogo.texto({ titulo, destaque, mensagem, campo: { valor, maxlength, placeholder, rotulo }, nota,
 *                   rotuloConfirmar, rotuloCancelar })
 *       -> Promise<string|null>   (texto digitado; null = cancelou. Ctrl+Enter salva)
 *   tamanho: 'grande' (opcional) - caixa larga e campo alto, para texto longo.
 *   campo.tipo (opcional): 'texto' (padrão, caixa de texto), 'data' (calendário;
 *        devolve 'AAAA-MM-DD' ou '' para apagar) ou 'lista' (marcar várias
 *        opções; campo.opcoes = [{ valor, rotulo, detalhe }], campo.marcados =
 *        [valor]; devolve a lista de valores marcados; com muitas opções
 *        aparece um filtro) ou 'escolha' (uma opção entre campo.opcoes =
 *        [{ valor, rotulo }] + texto complementar; devolve { escolha, texto }).
 *   validar(valor) (opcional): devolve '' se está ok, ou a mensagem de erro -
 *        a caixa continua aberta e mostra a mensagem.
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
    'dialog.dlgx.perigo{--dx-tom:var(--dx-warn)}dialog.dlgx.aviso{--dx-tom:var(--dx-accent)}dialog.dlgx.info,dialog.dlgx.nota{--dx-tom:var(--dx-accent)}',
    '.dlgx-texto{min-width:0;flex:1}',
    '.dlgx-titulo{margin:2px 0 0;font-size:1.05rem;font-weight:700;line-height:1.3;letter-spacing:-.005em}',
    '.dlgx-destaque{margin:12px 0 0;padding:9px 12px;border-radius:10px;border-left:4px solid var(--dx-tom);',
    'background:var(--dx-soft);font-size:.86rem;font-weight:600;line-height:1.4;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}',
    '.dlgx-msg{margin:12px 0 0;font-size:.84rem;line-height:1.5;color:var(--dx-dim);overflow-wrap:anywhere}',
    '.dlgx-msg+.dlgx-msg{margin-top:8px}',
    '.dlgx-campo{display:block;margin-top:14px}.dlgx-campo>span{display:block;font-size:.7rem;font-weight:700;text-transform:uppercase;',
    'letter-spacing:.03em;color:var(--dx-faint);margin-bottom:5px}',
    '.dlgx-campo textarea{display:block;width:100%;min-height:120px;resize:vertical;font:inherit;font-size:.86rem;line-height:1.5;',
    'color:var(--dx-ink);background:var(--bg,var(--dx-bg));border:1px solid var(--dx-line);border-radius:10px;padding:10px 12px}',
    '.dlgx-campo textarea:focus{outline:none;border-color:var(--dx-tom);box-shadow:0 0 0 3px color-mix(in srgb,var(--dx-tom) 25%,transparent)}',
    '.dlgx-campo textarea::placeholder{color:var(--dx-faint);opacity:.8}',
    '.dlgx-contador{display:flex;justify-content:space-between;gap:10px;margin-top:6px;font-size:.72rem;color:var(--dx-faint)}',
    '.dlgx-contador .cheio{color:var(--dx-warn);font-weight:700}',
    '.dlgx-rodape{display:flex;gap:10px;justify-content:flex-end;padding:18px 24px 22px}',
    '.dlgx-btn{font:inherit;font-size:.84rem;font-weight:600;cursor:pointer;border-radius:10px;padding:9px 18px;min-width:96px;',
    'border:1px solid var(--dx-line);background:transparent;color:var(--dx-dim);transition:background .12s,border-color .12s,box-shadow .12s}',
    '.dlgx-btn:hover{border-color:var(--dx-faint);color:var(--dx-ink)}',
    '.dlgx-btn:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--dx-tom) 35%,transparent)}',
    '.dlgx-btn.principal{background:var(--dx-tom);border-color:var(--dx-tom);color:#fff}',
    '.dlgx-btn.principal:hover{filter:brightness(1.07);color:#fff}',
    '@media (prefers-color-scheme:dark){.dlgx-btn.principal{color:#1E212C}.dlgx-btn.principal:hover{color:#1E212C}}',
    // tamanho 'grande': texto longo de ler e escrever (ex.: Solução do Jira)
    'dialog.dlgx.grande{width:min(760px,calc(100vw - 32px))}',
    'dialog.dlgx.grande .dlgx-campo textarea{min-height:min(340px,50vh);font-size:.92rem;line-height:1.6}',
    // campo de data e lista de escolha
    '.dlgx-campo input{display:block;font:inherit;font-size:.9rem;color:var(--dx-ink);background:var(--bg,var(--dx-bg));',
    'border:1px solid var(--dx-line);border-radius:10px;padding:8px 12px;color-scheme:light dark}',
    '.dlgx-campo input[type=date]{width:auto;min-width:200px}.dlgx-campo input.dlgx-filtro{width:100%;margin-bottom:8px}',
    '.dlgx-campo input:focus{outline:none;border-color:var(--dx-tom);box-shadow:0 0 0 3px color-mix(in srgb,var(--dx-tom) 25%,transparent)}',
    '.dlgx-lista{max-height:min(320px,45vh);overflow:auto;border:1px solid var(--dx-line);border-radius:10px;padding:4px}',
    '.dlgx-op{display:flex;gap:10px;align-items:flex-start;padding:7px 9px;border-radius:8px;cursor:pointer;font-size:.86rem;line-height:1.35}',
    '.dlgx-op:hover{background:var(--dx-soft)}.dlgx-op input{margin-top:2px;accent-color:var(--dx-tom)}',
    '.dlgx-op small{display:block;color:var(--dx-faint);font-size:.74rem}.dlgx-op[hidden]{display:none}',
    '.dlgx-vazia{padding:10px;font-size:.8rem;color:var(--dx-faint)}',
    '.dlgx-escolhas{display:flex;flex-direction:column;gap:2px;margin-bottom:10px}',
    '.dlgx-escolhas .dlgx-op input{accent-color:var(--dx-tom)}',
    '.dlgx-erro{margin:8px 0 0;font-size:.8rem;font-weight:600;color:var(--dx-warn)}.dlgx-erro:empty{display:none}',
    '.dlgx-limpar{font:inherit;font-size:.78rem;background:none;border:0;color:var(--dx-tom);cursor:pointer;padding:6px 0 0;text-decoration:underline}',
    '@media (max-width:480px){.dlgx-rodape{flex-direction:column-reverse}.dlgx-btn{width:100%}}',
    '@keyframes dlgx-entra{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}',
    '@keyframes dlgx-fundo{from{opacity:0}to{opacity:1}}',
    '@media (prefers-reduced-motion:reduce){dialog.dlgx,dialog.dlgx::backdrop{animation:none}}'
  ].join('');

  var ICONES = {
    perigo: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/>',
    aviso: '<path d="M12 3l10 18H2L12 3zM12 10v5M12 18h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
    nota: '<path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>'
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
      var comCampo = !!opcoes.campo;
      var tom = ['perigo', 'aviso', 'info', 'nota'].indexOf(opcoes.tom) >= 0 ? opcoes.tom : (comCampo ? 'nota' : (comCancelar ? 'aviso' : 'info'));
      var vazio = comCampo ? null : false; // o que a promessa devolve ao cancelar
      var id = 'dlgx-' + (++contador);
      var anterior = document.activeElement;

      var caixa = el('dialog', 'dlgx ' + tom + (opcoes.tamanho === 'grande' ? ' grande' : ''));
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
      var area = null;
      var lerValor = function () { return area.value; };
      var tipoCampo = comCampo ? (opcoes.campo.tipo || 'texto') : '';
      if (tipoCampo === 'data') {
        var rotuloData = el('label', 'dlgx-campo');
        if (opcoes.campo.rotulo) rotuloData.appendChild(el('span', '', opcoes.campo.rotulo));
        area = el('input');
        area.type = 'date';
        area.value = opcoes.campo.valor || '';
        area.setAttribute('aria-label', opcoes.campo.rotulo || opcoes.titulo || 'Data');
        rotuloData.appendChild(area);
        texto.appendChild(rotuloData);
        var limpar = el('button', 'dlgx-limpar', 'Deixar sem data');
        limpar.type = 'button';
        limpar.addEventListener('click', function () { area.value = ''; area.focus(); });
        texto.appendChild(limpar);
        if (opcoes.nota) texto.appendChild(el('p', 'dlgx-msg', opcoes.nota));
        area.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') { ev.preventDefault(); confirmar(); }
        });
      } else if (tipoCampo === 'lista') {
        var bloco = el('div', 'dlgx-campo');
        if (opcoes.campo.rotulo) bloco.appendChild(el('span', '', opcoes.campo.rotulo));
        var ops = opcoes.campo.opcoes || [];
        var marcados = (opcoes.campo.marcados || []).map(String);
        var filtro = null;
        if (ops.length > 8) {
          filtro = el('input', 'dlgx-filtro');
          filtro.type = 'search';
          filtro.placeholder = 'Filtrar…';
          filtro.setAttribute('aria-label', 'Filtrar opções');
          bloco.appendChild(filtro);
        }
        var lista = el('div', 'dlgx-lista');
        lista.setAttribute('role', 'group');
        lista.setAttribute('aria-label', opcoes.campo.rotulo || 'Opções');
        var caixas = [];
        ops.forEach(function (o) {
          var linha = el('label', 'dlgx-op');
          var cb = el('input');
          cb.type = 'checkbox';
          cb.value = String(o.valor);
          cb.checked = marcados.indexOf(String(o.valor)) >= 0;
          var t = el('span', '', o.rotulo);
          if (o.detalhe) t.appendChild(el('small', '', o.detalhe));
          linha.appendChild(cb);
          linha.appendChild(t);
          linha.setAttribute('data-busca', (String(o.rotulo) + ' ' + String(o.detalhe || '')).toLowerCase());
          lista.appendChild(linha);
          caixas.push(cb);
        });
        var nenhuma = el('div', 'dlgx-vazia', 'Nenhuma opção com esse filtro.');
        nenhuma.hidden = true;
        lista.appendChild(nenhuma);
        if (!ops.length) { nenhuma.textContent = 'Nenhuma opção disponível.'; nenhuma.hidden = false; }
        if (filtro) {
          filtro.addEventListener('input', function () {
            var q = filtro.value.trim().toLowerCase();
            var visiveis = 0;
            Array.prototype.forEach.call(lista.querySelectorAll('.dlgx-op'), function (l) {
              l.hidden = q !== '' && l.getAttribute('data-busca').indexOf(q) < 0;
              if (!l.hidden) visiveis++;
            });
            nenhuma.hidden = visiveis > 0;
          });
          filtro.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') ev.preventDefault(); });
        }
        bloco.appendChild(lista);
        texto.appendChild(bloco);
        if (opcoes.nota) texto.appendChild(el('p', 'dlgx-msg', opcoes.nota));
        area = filtro || caixas[0] || null;
        lerValor = function () { return caixas.filter(function (c) { return c.checked; }).map(function (c) { return c.value; }); };
      } else if (tipoCampo === 'escolha') {
        var grupo = el('div', 'dlgx-campo');
        if (opcoes.campo.rotulo) grupo.appendChild(el('span', '', opcoes.campo.rotulo));
        var escolhas = el('div', 'dlgx-escolhas');
        escolhas.setAttribute('role', 'radiogroup');
        escolhas.setAttribute('aria-label', opcoes.campo.rotulo || 'Opções');
        var radios = [];
        (opcoes.campo.opcoes || []).forEach(function (o) {
          var linha = el('label', 'dlgx-op');
          var rb = el('input');
          rb.type = 'radio';
          rb.name = id + '-escolha';
          rb.value = String(o.valor);
          rb.checked = String(o.valor) === String(opcoes.campo.escolhido || '');
          linha.appendChild(rb);
          linha.appendChild(el('span', '', o.rotulo));
          escolhas.appendChild(linha);
          radios.push(rb);
        });
        grupo.appendChild(escolhas);
        area = el('textarea');
        area.value = opcoes.campo.valor || '';
        area.style.minHeight = '80px';
        if (opcoes.campo.maxlength) area.maxLength = opcoes.campo.maxlength;
        if (opcoes.campo.placeholder) area.placeholder = opcoes.campo.placeholder;
        area.setAttribute('aria-label', opcoes.campo.rotuloTexto || 'Detalhe');
        grupo.appendChild(area);
        texto.appendChild(grupo);
        if (opcoes.nota) texto.appendChild(el('p', 'dlgx-msg', opcoes.nota));
        lerValor = function () {
          var marcado = radios.filter(function (r) { return r.checked; })[0];
          return { escolha: marcado ? marcado.value : '', texto: area.value };
        };
        area.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); confirmar(); }
        });
        if (radios.length) area = radios.filter(function (r) { return r.checked; })[0] || radios[0];
      } else if (comCampo) {
        var rotuloCampo = el('label', 'dlgx-campo');
        if (opcoes.campo.rotulo) rotuloCampo.appendChild(el('span', '', opcoes.campo.rotulo));
        area = el('textarea');
        area.value = opcoes.campo.valor || '';
        if (opcoes.campo.maxlength) area.maxLength = opcoes.campo.maxlength;
        if (opcoes.campo.placeholder) area.placeholder = opcoes.campo.placeholder;
        area.setAttribute('aria-label', opcoes.campo.rotulo || opcoes.titulo || 'Texto');
        rotuloCampo.appendChild(area);
        var contador = el('div', 'dlgx-contador');
        var nota = el('span', '', opcoes.nota || '');
        var qtd = el('span', 'dlgx-qtd');
        contador.appendChild(nota);
        contador.appendChild(qtd);
        var atualizarQtd = function () {
          var max = opcoes.campo.maxlength;
          qtd.textContent = max ? area.value.length + '/' + max : String(area.value.length);
          qtd.className = 'dlgx-qtd' + (max && area.value.length >= max ? ' cheio' : '');
        };
        area.addEventListener('input', atualizarQtd);
        atualizarQtd();
        texto.appendChild(rotuloCampo);
        texto.appendChild(contador);
        area.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); confirmar(); }
        });
      }
      // erro da validação: a caixa fica aberta e diz o que falta
      var erroEl = el('p', 'dlgx-erro');
      erroEl.setAttribute('role', 'alert');
      texto.appendChild(erroEl);
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
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); fechar(vazio); }
      }

      function confirmar() {
        var valor = comCampo ? lerValor() : true;
        var problema = typeof opcoes.validar === 'function' ? opcoes.validar(valor) : '';
        if (problema) { erroEl.textContent = problema; return; }
        fechar(valor);
      }
      ok.addEventListener('click', confirmar);
      if (cancelar) cancelar.addEventListener('click', function () { fechar(vazio); });
      // clique no fundo (fora da caixa) cancela; o <dialog> não tem padding, então só o fundo chega aqui
      caixa.addEventListener('click', function (ev) { if (ev.target === caixa) fechar(vazio); });
      caixa.addEventListener('cancel', function (ev) { ev.preventDefault(); fechar(vazio); });
      document.addEventListener('keydown', teclas, true);

      document.body.appendChild(caixa);
      if (typeof caixa.showModal === 'function') caixa.showModal();
      else caixa.setAttribute('open', '');
      // Excluir: o foco começa em "Cancelar" - Enter sem querer nunca apaga.
      if (area) {
        area.focus();
        if (tipoCampo === 'texto') area.setSelectionRange(area.value.length, area.value.length);
      }
      else (tom === 'perigo' && cancelar ? cancelar : ok).focus();
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
    texto: function (opcoes) { return enfileirar(function () { return abrir(opcoes || {}, true); }); },
    avisar: function (opcoes) { return enfileirar(function () { return abrir(opcoes || {}, false).then(function () {}); }); }
  };
})();
