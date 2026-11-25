/* Leitor do relatório do Zephyr Essential salvo como "Página da Web, arquivo
 * único" (.mhtml) - o relatório "Resultados de Test Execution (detalhamento)"
 * de um ciclo de teste.
 *
 * Por que arquivo e não API: o Zephyr Essential não libera token de API para
 * o nosso espaço, e o token do Jira não enxerga nada do Zephyr (os casos não
 * são issues; testado em 2026-11-25). O relatório salvo traz tudo: o ciclo, os
 * casos, o script de cada passo, o resultado e os prints embutidos.
 *
 * Roda no navegador (tela Evidências) e no Node (testes): só texto, sem DOM.
 * O relatório é HTML gerado pelo Angular do Zephyr, com classes fixas
 * (ktm-test-result-table, ktm-test-script-result-table, aui-lozenge,
 * CodeMirror-line). Se a SmartBear mudar esse HTML, lerRelatorio devolve
 * erro em vez de um relatório pela metade.
 *
 *   var r = LeitorZephyr.lerArquivo(textoDoMhtml);
 *   r.ok -> r.relatorio { ciclo, casos[], avisos[] } e r.imagens { ref: {tipo, base64} }
 */
(function (raiz, fabrica) {
  var api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.LeitorZephyr = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITE_CASOS = 300;
  var LIMITE_PASSOS = 100;
  var LIMITE_TEXTO = 20000;

  // ---- MHTML ----

  function decodificarUtf8(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    return Buffer.from(bytes).toString('utf8');
  }

  /** quoted-printable -> texto UTF-8 (o HTML do relatório vem assim). */
  function decodificarQP(s) {
    s = s.replace(/=\r?\n/g, '');
    var bytes = new Uint8Array(s.length);
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 61 && i + 2 < s.length && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) {
        bytes[n++] = parseInt(s.substr(i + 1, 2), 16);
        i += 2;
      } else {
        bytes[n++] = c & 0xff;
      }
    }
    return decodificarUtf8(bytes.subarray(0, n));
  }

  function cabecalho(bloco, nome) {
    var m = new RegExp('^' + nome + ':[ \\t]*(.*(?:\\r?\\n[ \\t]+.*)*)', 'mi').exec(bloco);
    return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : '';
  }

  /** Separa as partes do .mhtml. Cada parte: { tipo, local, codificacao, corpo }. */
  function lerPartes(texto) {
    var topo = texto.slice(0, 4000);
    var b = /boundary="?([^";\r\n]+)"?/i.exec(topo);
    if (!b) return null;
    var separador = '--' + b[1];
    var pedacos = texto.split(separador);
    var partes = [];
    for (var i = 1; i < pedacos.length; i++) {
      var p = pedacos[i];
      if (/^--/.test(p)) break; // fim do multipart
      var corte = p.search(/\r?\n\r?\n/);
      if (corte < 0) continue;
      var cab = p.slice(0, corte);
      var corpo = p.slice(corte).replace(/^\r?\n\r?\n/, '');
      partes.push({
        tipo: cabecalho(cab, 'Content-Type').split(';')[0].trim().toLowerCase(),
        local: cabecalho(cab, 'Content-Location'),
        codificacao: cabecalho(cab, 'Content-Transfer-Encoding').toLowerCase(),
        corpo: corpo
      });
    }
    return partes;
  }

  function textoDaParte(p) {
    if (p.codificacao === 'quoted-printable') return decodificarQP(p.corpo);
    if (p.codificacao === 'base64') return decodificarUtf8(base64ParaBytes(p.corpo.replace(/\s+/g, '')));
    return p.corpo;
  }

  function base64ParaBytes(b64) {
    if (typeof atob === 'function') {
      var bin = atob(b64);
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }

  // ---- HTML (só texto) ----

  var ENTIDADES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ordm: 'º', ordf: 'ª', deg: '°', hellip: '…',
    ndash: '–', mdash: '—', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', copy: '©', reg: '®'
  };
  // letras acentuadas do português: &aacute; &Atilde; &ccedil; ...
  var ACENTOS = { acute: '́', grave: '̀', circ: '̂', tilde: '̃', uml: '̈', cedil: '̧' };
  function decodificarEntidades(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (todo, e) {
      if (e[0] === '#') {
        var n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return isNaN(n) || n > 0x10ffff ? todo : String.fromCodePoint(n);
      }
      if (ENTIDADES[e] !== undefined) return ENTIDADES[e];
      var a = /^([a-zA-Z])(acute|grave|circ|tilde|uml|cedil)$/.exec(e);
      return a ? (a[1] + ACENTOS[a[2]]).normalize('NFC') : todo;
    });
  }

  /** Texto visível de um trecho de HTML. "-" sozinho (o "vazio" do Zephyr) vira ''. */
  function texto(html) {
    var t = decodificarEntidades(String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|pre)>/gi, '\n')
      .replace(/<[^>]+>/g, ''))
      .replace(/​/g, '')
      .replace(/[ \t ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return t === '-' ? '' : t.slice(0, LIMITE_TEXTO);
  }

  function linhas(html) {
    var out = [];
    var re = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, m;
    while ((m = re.exec(html))) out.push(m[1]);
    return out;
  }

  function celulas(trHtml) {
    var out = [];
    var re = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi, m;
    while ((m = re.exec(trHtml))) {
      out.push({ titulo: /ktm-title-cell/.test(m[1]), atributos: m[1], html: m[2] });
    }
    return out;
  }

  /** Linha "Rótulo | valor | Rótulo | valor" -> { rótulo: html }. */
  function paresDaLinha(trHtml, destino) {
    var cs = celulas(trHtml);
    for (var i = 0; i < cs.length; i++) {
      if (cs[i].titulo && cs[i + 1] && !cs[i + 1].titulo) {
        destino[texto(cs[i].html)] = cs[i + 1].html;
        i++;
      }
    }
    return destino;
  }

  function lozenge(html) {
    var m = /class="[^"]*aui-lozenge[^"]*"[^>]*>([^<]*)</i.exec(html || '');
    return m ? texto(m[1]) : '';
  }

  function chaves(html, padrao) {
    var achadas = (texto(html).match(padrao) || []);
    return achadas.filter(function (k, i) { return achadas.indexOf(k) === i; });
  }

  /** Script BDD (Gherkin) vem num CodeMirror: uma <pre class="CodeMirror-line"> por linha. */
  function linhasDoCodeMirror(html) {
    var out = [];
    // classe exata: "CodeMirror-line-like" é a régua de medida do editor ("xxxxxxxxxx"), não linha
    var re = /<pre\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/pre>/gi, m;
    while ((m = re.exec(html))) {
      if (m[1].split(/\s+/).indexOf('CodeMirror-line') >= 0) out.push(texto(m[2]));
    }
    while (out.length && !out[out.length - 1]) out.pop();
    return out;
  }

  function imagensDoHtml(html) {
    var out = [];
    var re = /<img\b([^>]*)>/gi, m;
    while ((m = re.exec(html || ''))) {
      var src = /\bsrc="([^"]*)"/i.exec(m[1]);
      out.push(src ? decodificarEntidades(src[1]) : '');
    }
    return out;
  }

  // ---- datas do Zephyr: "01/Sep/26 3:57 pm" ----

  var MESES = { jan: 1, feb: 2, fev: 2, mar: 3, apr: 4, abr: 4, may: 5, mai: 5, jun: 6, jul: 7, aug: 8, ago: 8, sep: 9, set: 9, oct: 10, out: 10, nov: 11, dec: 12, dez: 12 };
  /** -> "AAAA-MM-DDTHH:MM" (hora local do relatório, sem fuso) ou '' se não der. */
  function dataZephyr(s) {
    var m = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})\s*([ap]m)?)?/i.exec(String(s || '').trim());
    if (!m) return '';
    var mes = MESES[m[2].toLowerCase()];
    if (!mes) return '';
    var ano = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    var h = m[4] ? Number(m[4]) : 0;
    if (m[6]) { var pm = m[6].toLowerCase() === 'pm'; if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
    function d2(n) { return (n < 10 ? '0' : '') + n; }
    return ano + '-' + d2(mes) + '-' + d2(Number(m[1])) + (m[4] ? 'T' + d2(h) + ':' + m[5] : '');
  }

  // ---- status ----

  /** Nome do Zephyr (pt ou en) -> código nosso. Desconhecido vira 'outro', com o nome guardado. */
  function codigoStatus(nome) {
    var n = String(nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    if (/^(sucesso|pass|passou|aprovado)/.test(n)) return 'sucesso';
    if (/^(falha|fail|falhou|reprovado)/.test(n)) return 'falha';
    if (/^(bloqueado|blocked)/.test(n)) return 'bloqueado';
    if (/^(em andamento|em execucao|in progress)/.test(n)) return 'andamento';
    if (/^(nao executado|not executed|unexecuted)/.test(n)) return 'nao_executado';
    if (/^(concluido|done)/.test(n)) return 'concluido';
    return n ? 'outro' : '';
  }

  // ---- relatório ----

  function lerCiclo(html) {
    var ini = html.indexOf('Ciclo de Teste');
    var fim = html.indexOf('ktm-test-result-table');
    if (ini < 0 || fim < 0) return null;
    var pares = {};
    linhas(html.slice(ini, fim)).forEach(function (tr) { paresDaLinha(tr, pares); });
    var chave = (texto(pares['Chave'] || '').match(/[A-Z][A-Z0-9_]+-R\d+/) || [''])[0];
    if (!chave) return null;
    return {
      chave: chave,
      nome: texto(pares['Nome']),
      descricao: texto(pares['Descrição']),
      status: lozenge(pares['Status']) || texto(pares['Status']),
      inicioPlanejado: dataZephyr(texto(pares['Data planejada de início'])),
      fimPlanejado: dataZephyr(texto(pares['Data planejada de fim'])),
      versao: texto(pares['Versão de lançamento']),
      iteracao: /^no iteration$/i.test(texto(pares['Iteração'])) ? '' : texto(pares['Iteração'])
    };
  }

  /** Tabela "Script de Teste": cada passo começa na linha cuja 1ª célula é o número (rowspan). */
  function lerPassos(html, avisos, chaveCaso, imagensVistas) {
    var passos = [];
    var atual = null;
    linhas(html).forEach(function (tr) {
      var cs = celulas(tr);
      if (!cs.length) return;
      if (cs.length === 1 && /Script de Teste/i.test(texto(cs[0].html))) return;
      var numero = /rowspan/i.test(cs[0].atributos) && /^\d+$/.test(texto(cs[0].html)) ? Number(texto(cs[0].html)) : null;
      if (numero !== null || !atual) {
        if (passos.length >= LIMITE_PASSOS) { atual = { descartado: true, campos: [] }; return; }
        atual = { numero: numero || passos.length + 1, status: '', statusNome: '', script: [], campos: [], resultado: '', imagens: [], issues: [] };
        passos.push(atual);
        if (numero !== null) cs = cs.slice(1);
      }
      if (atual.descartado) return;
      for (var i = 0; i < cs.length; i++) {
        if (!cs[i].titulo || !cs[i + 1]) continue;
        var rotulo = texto(cs[i].html);
        var valor = cs[i + 1].html;
        i++;
        if (rotulo === 'Status') {
          atual.statusNome = lozenge(valor) || texto(valor);
          atual.status = codigoStatus(atual.statusNome);
        } else if (rotulo === 'Detalhes' && /CodeMirror-line/.test(valor)) {
          atual.script = linhasDoCodeMirror(valor);
        } else if (rotulo === 'Resultado') {
          atual.resultado = texto(valor.replace(/<img\b[^>]*>/gi, ''));
          imagensDoHtml(valor).forEach(function (url) {
            if (!url) { avisos.push(chaveCaso + ' (passo ' + atual.numero + '): há uma imagem sem arquivo no relatório. Confira no Zephyr se ela abre.'); return; }
            if (imagensVistas.indexOf(url) < 0) imagensVistas.push(url);
            atual.imagens.push({ url: url });
          });
        } else if (rotulo === 'Issues') {
          atual.issues = chaves(valor, /[A-Z][A-Z0-9_]+-\d+/g);
        } else {
          // passo a passo (Descrição / Dados de teste / Resultado esperado) ou campo novo
          var t = texto(valor);
          if (t) atual.campos.push({ rotulo: rotulo.slice(0, 80), texto: t });
        }
      }
    });
    return passos.filter(function (p) { return !p.descartado; });
  }

  function lerCaso(bloco, avisos, imagensVistas) {
    var fimCabecalho = bloco.indexOf('ktm-test-script-result-table');
    var cab = fimCabecalho >= 0 ? bloco.slice(0, fimCabecalho) : bloco;
    var pares = {};
    linhas(cab).forEach(function (tr) { paresDaLinha(tr, pares); });
    var chave = (texto(pares['Chave'] || '').match(/[A-Z][A-Z0-9_]+-T\d+/) || [''])[0];
    if (!chave) return null;
    var statusNome = lozenge(pares['Status']) || texto(pares['Status']);
    var caso = {
      chave: chave,
      nome: texto(pares['Nome']),
      status: codigoStatus(statusNome),
      statusNome: statusNome,
      objetivo: texto(pares['Objetivo']),
      precondicao: texto(pares['Precondição']),
      cobertura: chaves(pares['Cobertura (problemas)'], /[A-Z][A-Z0-9_]+-\d+/g),
      dataTermino: dataZephyr(texto(pares['Data de término'])),
      atribuidoA: texto(pares['Atribuído a']),
      executadoPor: texto(pares['Executado por']),
      ambiente: texto(pares['Ambiente']),
      tipo: texto(pares['Tipo']),
      issues: chaves(pares['Issues'], /[A-Z][A-Z0-9_]+-\d+/g),
      passos: fimCabecalho >= 0 ? lerPassos(bloco.slice(fimCabecalho), avisos, chave, imagensVistas) : []
    };
    if (!caso.passos.length) avisos.push(chave + ': nenhum passo encontrado no script de teste.');
    return caso;
  }

  /** HTML do relatório (já decodificado) -> { ok, relatorio } ou { ok:false, erro }. */
  function lerRelatorio(html) {
    html = String(html || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<svg\b[\s\S]*?<\/svg>/gi, '');
    if (html.indexOf('ktm-test-result-table') < 0) {
      return { ok: false, erro: 'Não encontrei casos de teste no arquivo. Ele precisa ser o relatório "Resultados de Test Execution (detalhamento)" de um ciclo, salvo como "Página da Web, arquivo único".' };
    }
    var ciclo = lerCiclo(html);
    if (!ciclo) return { ok: false, erro: 'Não encontrei os dados do ciclo de teste (chave R) no relatório. O layout do Zephyr pode ter mudado.' };
    var avisos = [];
    var imagensVistas = [];
    var blocos = html.split(/<table\b[^>]*class="ktm-test-result-table/).slice(1);
    var casos = [];
    for (var i = 0; i < blocos.length && casos.length < LIMITE_CASOS; i++) {
      var c = lerCaso(blocos[i], avisos, imagensVistas);
      if (c) casos.push(c);
    }
    if (!casos.length) return { ok: false, erro: 'O relatório não tem nenhum caso de teste que eu consiga ler.' };
    if (/ng-show="\$ctrl\.testResultsLimit &lt; [^"]*"[^>]*aria-hidden="false"/.test(html)) {
      avisos.push('O relatório ainda estava carregando casos quando foi salvo. Role até o fim do relatório no Zephyr e salve de novo.');
    }
    return { ok: true, relatorio: { ciclo: ciclo, casos: casos, avisos: avisos }, urlsImagens: imagensVistas };
  }

  /** Conteúdo do .mhtml -> { ok, relatorio, imagens } ou { ok:false, erro }.
   * Cada imagem do relatório ganha uma ref curta (img1, img2...) e sai em
   * imagens[ref] = { tipo, base64 }; no relatório, passo.imagens = [{ ref, url }]. */
  function lerArquivo(conteudo) {
    var partes = lerPartes(String(conteudo || ''));
    if (!partes || !partes.length) {
      return { ok: false, erro: 'O arquivo não é uma página salva como "arquivo único" (.mhtml). No Chrome: Ctrl+S → Tipo: "Página da Web, arquivo único".' };
    }
    var htmlRelatorio = null;
    for (var i = 0; i < partes.length; i++) {
      if (partes[i].tipo !== 'text/html') continue;
      // barato primeiro: só decodifica a parte que parece ser o relatório
      if (partes[i].corpo.indexOf('ktm-test-result-table') < 0 && partes[i].corpo.indexOf('ktm-test-result=') < 0 && partes[i].corpo.indexOf('testRunDetailedReport') < 0) continue;
      var h = textoDaParte(partes[i]);
      if (h.indexOf('ktm-test-result-table') >= 0) { htmlRelatorio = h; break; }
    }
    if (!htmlRelatorio) {
      return { ok: false, erro: 'Não encontrei o relatório do Zephyr dentro do arquivo. Abra o relatório "Resultados de Test Execution (detalhamento)" do ciclo, role até o fim e salve com Ctrl+S → "Página da Web, arquivo único".' };
    }
    var r = lerRelatorio(htmlRelatorio);
    if (!r.ok) return r;

    var porUrl = {};
    partes.forEach(function (p) {
      if (/^image\/(png|jpeg|gif|webp)$/.test(p.tipo) && p.codificacao === 'base64' && p.local) porUrl[p.local] = p;
    });
    var imagens = {};
    var refPorUrl = {};
    var n = 0;
    r.urlsImagens.forEach(function (url) {
      var p = porUrl[url];
      if (!p) return;
      var ref = 'img' + (++n);
      refPorUrl[url] = ref;
      imagens[ref] = { tipo: p.tipo, base64: p.corpo.replace(/\s+/g, '') };
    });
    r.relatorio.casos.forEach(function (c) {
      c.passos.forEach(function (passo) {
        passo.imagens = passo.imagens.map(function (im) {
          if (!refPorUrl[im.url]) {
            r.relatorio.avisos.push(c.chave + ' (passo ' + passo.numero + '): a imagem não veio no arquivo. Role o relatório até o fim antes de salvar, para todas as imagens carregarem.');
            return null;
          }
          return { ref: refPorUrl[im.url] };
        }).filter(Boolean);
      });
    });
    return { ok: true, relatorio: r.relatorio, imagens: imagens };
  }

  /** Resultado geral do ciclo a partir dos casos. */
  function resultadoGeral(casos) {
    var st = (casos || []).map(function (c) { return c.status; });
    if (!st.length) return 'sem_casos';
    if (st.indexOf('falha') >= 0) return 'reprovado';
    if (st.indexOf('bloqueado') >= 0) return 'bloqueado';
    if (st.some(function (s) { return s !== 'sucesso'; })) return 'incompleto';
    return 'aprovado';
  }

  /** ACS no começo do título da task do Jira: "20260630006 - Alterar...". */
  function acsDoTitulo(titulo) {
    var m = /^\s*(\d{11})(?!\d)/.exec(String(titulo || ''));
    return m ? m[1] : '';
  }

  return {
    lerArquivo: lerArquivo,
    lerRelatorio: lerRelatorio,
    lerPartes: lerPartes,
    decodificarQP: decodificarQP,
    dataZephyr: dataZephyr,
    codigoStatus: codigoStatus,
    resultadoGeral: resultadoGeral,
    acsDoTitulo: acsDoTitulo
  };
});
