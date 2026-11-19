// Gravação no Jira a partir da tela de Expedições.
//
// 2026-11-18: começou pela Solução. 2026-11-19: todos os campos que o
// checklist confere e que são campo de verdade na issue (CAMPOS_GRAVAVEIS).
// Fica de fora o que não é campo: status (é transição de fluxo), subtarefas e
// a subtarefa "Documentação".
//
// Regras combinadas com o usuário:
// - só @dimensa.com.br e @evertecinc.com.br gravam (TOTVS e BRB nunca). A
//   lista é fixa AQUI de propósito: não segue EDITOR_DOMAINS, para que mudar
//   quem edita as telas não abra, sem querer, a gravação no Jira;
// - a issue tem que ficar EXATAMENTE como se a pessoa tivesse editado no
//   próprio Jira: só a alteração do campo, sem comentário, etiqueta ou marca.
//   A gravação usa o token configurado (JIRA_EMAIL), então o histórico da issue
//   mostra essa conta; quem gravou de verdade fica só no nosso banco;
// - texto puro ("copiar e colar"). Cada linha vira um parágrafo, que é o que o
//   editor do Jira faz hoje a cada Enter (conferido na Situação/Requisito da
//   JDCBBRB-363 e na Descrição da JDCBBRB-517, em 2026-11-19). Na leitura,
//   quebra de linha (hardBreak) também vira linha. Texto que já tem formatação
//   (negrito, lista, link, imagem, título) também se edita (pedido de
//   2026-11-19: tudo é texto simples): a tela mostra o texto limpo e avisa o
//   que some ao salvar. Abrir e não mudar nada não grava (a formatação fica);
// - data no formato do Jira (AAAA-MM-DD); versões e componentes só dos que
//   estão cadastrados no projeto;
// - antes de gravar, confere se ninguém mudou o campo no Jira depois que a
//   tela leu (versão = hash do valor lido). Se mudou, recusa em vez de apagar.

const crypto = require('crypto');
const { CAMPOS, STATUS_IGNORADOS } = require('./checklistJira');

const DOMINIOS_GRAVAM_JIRA = ['dimensa.com.br', 'evertecinc.com.br'];
// Só issues deste projeto: o token enxerga a empresa inteira no Jira.
const PROJETO = 'JDCBBRB';
const MAX_TEXTO = 8000;

/** Campos que a tela pode gravar. `id` é o da issue nesta instância do Jira.
 * Demais Documentações: existem dois campos com esse nome; o que está na tela
 * de edição do Jira é o 13096 (o 12493 é antigo e o Jira não deixa editar). */
const CAMPOS_GRAVAVEIS = {
  solucao: { id: CAMPOS.solucao, nome: 'Solução', tipo: 'texto' },
  descricao: { id: 'description', nome: 'Descrição', tipo: 'texto' },
  situacaoRequisito: { id: CAMPOS.situacaoRequisito, nome: 'Situação/Requisito', tipo: 'texto' },
  demaisDocumentacoes: { id: CAMPOS.demaisDocumentacoes[0], nome: 'Demais Documentações', tipo: 'texto' },
  dataPrevista: { id: CAMPOS.dataPrevistaEntrega, nome: 'Data prevista para entrega', tipo: 'data' },
  dataInterna: { id: CAMPOS.dataInternaAcordada, nome: 'Data Interna Acordada', tipo: 'data' },
  versoes: { id: 'fixVersions', nome: 'Versões corrigidas', tipo: 'versoes' },
  componentes: { id: 'components', nome: 'Componentes', tipo: 'componentes' }
};
const CAMPO_SOLUCAO = CAMPOS_GRAVAVEIS.solucao.id;

const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/** Domínio INTEIRO (nunca "termina com"), como em auth.js. */
function podeGravarJira(email) {
  const partes = String(email || '').trim().toLowerCase().split('@');
  return partes.length === 2 && partes[0] !== '' && DOMINIOS_GRAVAM_JIRA.includes(partes[1]);
}

/** Chave de issue do projeto (JDCBBRB-123) ou ''. */
function chaveDoProjeto(valor) {
  const m = /^([A-Z][A-Z0-9]+)-(\d+)$/.exec(String(valor || '').trim().toUpperCase());
  return m && m[1] === PROJETO ? `${m[1]}-${m[2]}` : '';
}

/** Texto como o Jira guardaria: \r\n vira \n, sem espaço/linha sobrando nas pontas. */
function normalizarTexto(t) {
  return String(t === null || t === undefined ? '' : t).replace(/\r\n?/g, '\n').trim();
}

/** ADF do Jira -> texto puro. `simples` = só parágrafos com texto sem marca e
 * quebras de linha (regravar não perde nada). Senão, o texto vem "limpo"
 * (lista vira "- item", título vira linha, link e menção viram texto) e
 * `perde` diz o que some ao salvar - combinado em 2026-11-19: todo campo é
 * texto simples, então formatado também se edita, com aviso. */
const PERDA_MARCA = { link: 'link', code: 'código' };
function adfParaTexto(doc) {
  if (doc === null || doc === undefined || doc === '') return { texto: '', simples: true, perde: [] };
  if (typeof doc === 'string') return { texto: doc, simples: true, perde: [] };
  const perde = new Set();
  if (!doc || doc.type !== 'doc') perde.add('outra formatação');
  const inline = (nos) => (nos || []).map((no) => {
    if (!no || typeof no !== 'object') return '';
    if (no.type === 'text') {
      for (const m of no.marks || []) perde.add(PERDA_MARCA[m && m.type] || 'negrito, itálico ou cor');
      return String(no.text || '');
    }
    if (no.type === 'hardBreak') return '\n';
    const a = no.attrs || {};
    if (no.type === 'mention') { perde.add('menção'); return String(a.text || ''); }
    if (no.type === 'emoji') return String(a.text || a.shortName || '');
    if (no.type === 'inlineCard') { perde.add('link'); return String(a.url || ''); }
    if (no.type === 'status') { perde.add('outra formatação'); return String(a.text || ''); }
    if (no.type === 'date') { perde.add('outra formatação'); return a.timestamp ? new Date(+a.timestamp).toISOString().slice(0, 10).split('-').reverse().join('/') : ''; }
    if (/^media/.test(no.type)) { perde.add('imagem ou anexo'); return ''; }
    perde.add('outra formatação');
    return inline(no.content);
  }).join('');
  // cada bloco vira uma ou mais linhas
  const linhas = (b, recuo = '') => {
    if (!b || typeof b !== 'object') return [];
    switch (b.type) {
      case 'paragraph': return [recuo + inline(b.content)];
      case 'heading': perde.add('título'); return [recuo + inline(b.content)];
      case 'bulletList':
      case 'orderedList': {
        perde.add('lista');
        const ini = (b.attrs && b.attrs.order) || 1;
        return (b.content || []).flatMap((item, n) => {
          const marca = b.type === 'bulletList' ? '- ' : `${ini + n}. `;
          const dentro = (item.content || []).flatMap((c) => linhas(c, recuo + '  '));
          if (!dentro.length) return [recuo + marca];
          return [recuo + marca + dentro[0].slice(recuo.length + 2), ...dentro.slice(1)];
        });
      }
      case 'codeBlock': perde.add('código'); return inline(b.content).split('\n').map((l) => recuo + l);
      case 'rule': perde.add('outra formatação'); return [];
      case 'table':
        perde.add('tabela');
        return (b.content || []).map((linha) => recuo + (linha.content || []).map((cel) => (cel.content || []).flatMap((c) => linhas(c)).join(' ')).join(' | '));
      case 'mediaSingle': case 'mediaGroup': case 'media': perde.add('imagem ou anexo'); return [];
      case 'blockquote': case 'panel': case 'expand': case 'nestedExpand':
        perde.add('citação, painel ou bloco');
        return (b.content || []).flatMap((c) => linhas(c, recuo));
      default: perde.add('outra formatação'); return (b.content || []).flatMap((c) => linhas(c, recuo));
    }
  };
  const texto = ((doc && doc.content) || []).flatMap((b) => linhas(b)).join('\n');
  return { texto, simples: perde.size === 0, perde: [...perde] };
}

/** Texto -> ADF como o editor do Jira grava: um parágrafo por linha (linha em
 * branco = parágrafo vazio). Texto vazio apaga o campo (null). */
function textoParaAdf(texto) {
  const t = normalizarTexto(texto);
  if (!t) return null;
  const content = t.split('\n').map((linha) => (linha === ''
    ? { type: 'paragraph', content: [] }
    : { type: 'paragraph', content: [{ type: 'text', text: linha }] }));
  return { type: 'doc', version: 1, content };
}

/** "Versão" do que a tela leu: muda se o valor mudar no Jira. */
function versaoDe(valor) {
  return crypto.createHash('sha256').update(JSON.stringify(valor === undefined ? null : valor)).digest('hex').slice(0, 32);
}

const DATA_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function dataValida(s) {
  const m = DATA_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && +m[1] >= 2000 && +m[1] <= 2100;
}
const dataBR = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');
const idsDe = (lista) => (Array.isArray(lista) ? lista : []).map((x) => String(x && x.id)).filter((x) => x && x !== 'undefined').sort();

/** O valor de um campo como a tela usa: { valor, texto (para ler/registrar),
 * editavel, motivo, versao }. A versão olha só o que importa de cada tipo
 * (lançar uma versão no Jira não pode virar "conflito" na lista de versões). */
function lerCampo(chaveCampo, bruto) {
  const c = CAMPOS_GRAVAVEIS[chaveCampo];
  if (c.tipo === 'texto') {
    // formatado também é editável (tudo é texto simples); `perde` vai para o aviso da tela
    const lido = adfParaTexto(bruto);
    return {
      valor: lido.texto, texto: lido.texto, editavel: true, motivo: '',
      formatado: !lido.simples, perde: lido.perde,
      versao: versaoDe(bruto === undefined ? null : bruto)
    };
  }
  if (c.tipo === 'data') {
    const v = bruto ? String(bruto).slice(0, 10) : '';
    return { valor: v, texto: dataBR(v), editavel: true, motivo: '', versao: versaoDe(v) };
  }
  const lista = Array.isArray(bruto) ? bruto : [];
  const ids = idsDe(lista);
  return {
    valor: ids,
    texto: lista.map((x) => x.name).filter(Boolean).join(', '),
    itens: lista.map((x) => ({ id: String(x.id), nome: x.name || '', data: x.releaseDate || '', lancada: !!x.released })),
    editavel: true, motivo: '', versao: versaoDe(ids)
  };
}

function validarCampos(lista) {
  const campos = [...new Set((Array.isArray(lista) ? lista : String(lista || '').split(',')).map((s) => String(s).trim()).filter(Boolean))];
  if (!campos.length || campos.some((k) => !Object.prototype.hasOwnProperty.call(CAMPOS_GRAVAVEIS, k))) return null;
  return campos;
}

const CAMPOS_BASE = ['summary', 'status', 'issuetype', 'project'];
const camposLidos = (campos) => [...CAMPOS_BASE, ...campos.map((k) => CAMPOS_GRAVAVEIS[k].id)].join(',');

function tarefaDe(issue, campos) {
  const f = issue.fields || {};
  const lidos = {};
  for (const k of campos) lidos[k] = lerCampo(k, f[CAMPOS_GRAVAVEIS[k].id]);
  return { chave: issue.key, resumo: String(f.summary || ''), status: (f.status && f.status.name) || '', campos: lidos };
}

/** Opções do projeto para versões e componentes. Versão: só as não
 * arquivadas (as já escolhidas na task entram sempre, para não sumirem). */
async function lerOpcoes(campos, chamar) {
  const opcoes = {};
  if (campos.includes('versoes')) {
    const vs = await chamar(`/rest/api/3/project/${PROJETO}/versions`);
    opcoes.versoes = (vs || []).map((v) => ({
      id: String(v.id), nome: v.name || '', data: v.releaseDate || '', lancada: !!v.released, arquivada: !!v.archived
    }));
  }
  if (campos.includes('componentes')) {
    const cs = await chamar(`/rest/api/3/project/${PROJETO}/components`);
    opcoes.componentes = (cs || []).map((c) => ({ id: String(c.id), nome: c.name || '' }));
  }
  return opcoes;
}

/** As tasks cujos campos a expedição usa: a própria task ou, num épico, as
 * filhas (sem subtarefas, sem canceladas/recusadas) - as mesmas que o checklist
 * confere. Devolve { status: 'ok' | 'nao-encontrada' | 'fora-do-projeto' | 'campo-invalido', tipo, tarefas, opcoes }. */
async function lerCampos(chaveExpedicao, listaCampos, chamar) {
  const chave = chaveDoProjeto(chaveExpedicao);
  if (!chave) return { status: 'fora-do-projeto', tarefas: [] };
  const campos = validarCampos(listaCampos);
  if (!campos) return { status: 'campo-invalido', tarefas: [] };
  const fields = camposLidos(campos);
  let issue;
  try {
    issue = await chamar(`/rest/api/3/issue/${chave}?fields=${fields}`);
  } catch (erro) {
    if (/respondeu 40[04]\b/.test(String(erro.message))) return { status: 'nao-encontrada', tarefas: [] };
    throw erro;
  }
  const nivel = issue.fields && issue.fields.issuetype ? issue.fields.issuetype.hierarchyLevel : 0;
  let tipo = 'task';
  let tarefas;
  if (nivel >= 1) {
    tipo = 'epico';
    const jql = encodeURIComponent(`parent = ${chave} AND issuetype not in subTaskIssueTypes() ORDER BY key ASC`);
    const r = await chamar(`/rest/api/3/search/jql?jql=${jql}&maxResults=100&fields=${fields}`);
    tarefas = (r.issues || []).filter((i) => !STATUS_IGNORADOS.includes(norm(i.fields && i.fields.status && i.fields.status.name)))
      .filter((i) => chaveDoProjeto(i.key)).map((i) => tarefaDe(i, campos));
  } else {
    tarefas = [tarefaDe(issue, campos)];
  }
  const definicoes = Object.fromEntries(campos.map((k) => [k, { nome: CAMPOS_GRAVAVEIS[k].nome, tipo: CAMPOS_GRAVAVEIS[k].tipo }]));
  return { status: 'ok', tipo, campos, definicoes, tarefas, opcoes: await lerOpcoes(campos, chamar) };
}

/** Valida o pedido da tela antes de qualquer chamada ao Jira.
 * corpo: { campo, valor, versao }. valor: texto (texto), 'AAAA-MM-DD' ou ''
 * (data), lista de ids (versões/componentes). */
function validarPedido(chaveTask, corpo) {
  const chave = chaveDoProjeto(chaveTask);
  if (!chave) return { ok: false, erro: `Só issues do projeto ${PROJETO} podem ser editadas daqui.` };
  if (!corpo || typeof corpo !== 'object') return { ok: false, erro: 'Corpo inválido.' };
  const campo = String(corpo.campo || '');
  const c = Object.prototype.hasOwnProperty.call(CAMPOS_GRAVAVEIS, campo) ? CAMPOS_GRAVAVEIS[campo] : null;
  if (!c) return { ok: false, erro: 'Este campo não pode ser gravado daqui.' };
  if (typeof corpo.versao !== 'string' || !/^[0-9a-f]{32}$/.test(corpo.versao)) return { ok: false, erro: 'Abra o campo de novo antes de salvar.' };
  let valor;
  if (c.tipo === 'texto') {
    if (typeof corpo.valor !== 'string') return { ok: false, erro: `${c.nome}: texto inválido.` };
    valor = normalizarTexto(corpo.valor);
    if (valor.length > MAX_TEXTO) return { ok: false, erro: `${c.nome} passa de ${MAX_TEXTO} caracteres.` };
  } else if (c.tipo === 'data') {
    valor = typeof corpo.valor === 'string' ? corpo.valor.trim() : null;
    if (valor === null || (valor !== '' && !dataValida(valor))) return { ok: false, erro: `${c.nome}: data inválida.` };
  } else {
    if (!Array.isArray(corpo.valor) || corpo.valor.length > 30 || corpo.valor.some((x) => !/^\d{1,12}$/.test(String(x)))) {
      return { ok: false, erro: `${c.nome}: escolha inválida.` };
    }
    valor = [...new Set(corpo.valor.map(String))].sort();
  }
  return { ok: true, chave, campo, valor, versao: corpo.versao };
}

/** O que vai no PUT para o valor pedido (já validado). */
function valorParaJira(campo, valor) {
  const c = CAMPOS_GRAVAVEIS[campo];
  if (c.tipo === 'texto') return textoParaAdf(valor);
  if (c.tipo === 'data') return valor || null;
  return valor.map((id) => ({ id }));
}

const mesmoValor = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Grava UM campo de UMA task. Relê o campo antes: formatado ou mudado desde a
 * leitura da tela = recusa (conflito). Mesmo valor = não grava nada (nem linha
 * no histórico do Jira). Versão/componente fora do cadastro do projeto = recusa.
 * Devolve { ok, semMudanca?, nome, anterior, novo } (textos para o registro) ou
 * { ok: false, conflito|formatada|naoEncontrada|foraDoProjeto|invalido, erro, atual? }. */
async function gravarCampo(pedido, chamar) {
  const c = CAMPOS_GRAVAVEIS[pedido.campo];
  let issue;
  try {
    issue = await chamar(`/rest/api/3/issue/${pedido.chave}?fields=${camposLidos([pedido.campo])}`);
  } catch (erro) {
    if (/respondeu 40[04]\b/.test(String(erro.message))) return { ok: false, naoEncontrada: true, erro: 'A issue não foi encontrada no Jira.' };
    throw erro;
  }
  const f = issue.fields || {};
  if ((f.project && f.project.key) !== PROJETO) return { ok: false, foraDoProjeto: true, erro: `Só issues do projeto ${PROJETO} podem ser editadas daqui.` };
  if (f.issuetype && f.issuetype.subtask) return { ok: false, foraDoProjeto: true, erro: `Subtarefa não tem ${c.nome}: edite a task principal.` };
  const atual = tarefaDe(issue, [pedido.campo]);
  const lido = atual.campos[pedido.campo];
  if (!lido.editavel) return { ok: false, formatada: true, erro: lido.motivo, atual };
  if (lido.versao !== pedido.versao) {
    return { ok: false, conflito: true, erro: `${c.nome} mudou no Jira depois que você abriu. Confira o valor atual e salve de novo.`, atual };
  }
  const valorAtual = c.tipo === 'texto' ? normalizarTexto(lido.valor) : lido.valor;
  let textoNovo = c.tipo === 'texto' ? pedido.valor : c.tipo === 'data' ? dataBR(pedido.valor) : '';
  if (mesmoValor(valorAtual, pedido.valor)) return { ok: true, semMudanca: true, nome: c.nome, anterior: lido.texto, novo: lido.texto };
  if (c.tipo === 'versoes' || c.tipo === 'componentes') {
    const opcoes = (await lerOpcoes([pedido.campo], chamar))[pedido.campo];
    const porId = new Map(opcoes.map((o) => [o.id, o]));
    const ja = new Set(lido.valor);
    // versão arquivada só fica se já estava na task (o Jira também não oferece arquivada)
    const ruim = pedido.valor.filter((id) => !porId.has(id) || (porId.get(id).arquivada && !ja.has(id)));
    if (ruim.length) return { ok: false, invalido: true, erro: `${c.nome}: escolha que não existe (mais) no projeto. Abra de novo e escolha outra vez.` };
    textoNovo = pedido.valor.map((id) => porId.get(id).nome).join(', ');
  }
  await chamar(`/rest/api/3/issue/${pedido.chave}`, { metodo: 'PUT', corpo: { fields: { [c.id]: valorParaJira(pedido.campo, pedido.valor) } } });
  return { ok: true, nome: c.nome, anterior: lido.texto, novo: textoNovo };
}

module.exports = {
  DOMINIOS_GRAVAM_JIRA, PROJETO, CAMPOS_GRAVAVEIS, CAMPO_SOLUCAO, MAX_TEXTO,
  podeGravarJira, chaveDoProjeto, normalizarTexto, adfParaTexto, textoParaAdf, versaoDe, dataValida,
  lerCampo, lerCampos, validarPedido, valorParaJira, gravarCampo
};
