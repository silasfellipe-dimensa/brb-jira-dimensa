// Gravação no Jira a partir da tela de Expedições (pedido de 2026-11-18).
//
// Começa por UM campo: a Solução. Regras combinadas com o usuário:
// - só @dimensa.com.br e @evertecinc.com.br gravam (TOTVS e BRB nunca). A
//   lista é fixa AQUI de propósito: não segue EDITOR_DOMAINS, para que mudar
//   quem edita as telas não abra, sem querer, a gravação no Jira;
// - a issue tem que ficar EXATAMENTE como se a pessoa tivesse editado no
//   próprio Jira: só a alteração do campo, sem comentário, etiqueta ou marca.
//   A gravação usa o token configurado (JIRA_EMAIL), então o histórico da issue
//   mostra essa conta; quem gravou de verdade fica só no nosso banco;
// - texto puro. No Jira a Solução é um parágrafo só, com cada quebra de linha
//   virando um "hardBreak" (conferido nas 21 Soluções do projeto em
//   2026-11-18). Gravamos nesse mesmo formato. Solução que já tem qualquer
//   outra coisa (negrito, lista, link, imagem, vários parágrafos) NÃO é
//   editada aqui: salvar por cima apagaria a formatação;
// - antes de gravar, confere se ninguém mudou a Solução no Jira depois que a
//   tela leu (versão = hash do texto lido). Se mudou, recusa em vez de apagar.

const crypto = require('crypto');
const { CAMPOS, STATUS_IGNORADOS } = require('./checklistJira');

const DOMINIOS_GRAVAM_JIRA = ['dimensa.com.br', 'evertecinc.com.br'];
// Só issues deste projeto: o token enxerga a empresa inteira no Jira.
const PROJETO = 'JDCBBRB';
const CAMPO_SOLUCAO = CAMPOS.solucao;
const MAX_TEXTO = 4000;

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

/** ADF do Jira -> texto. `simples` = só um parágrafo com texto sem marca e
 * quebras de linha (o formato que a gente sabe regravar idêntico). Vazio
 * também é simples. Qualquer outra coisa: simples false, e o texto serve só
 * para mostrar. */
function adfParaTexto(doc) {
  if (doc === null || doc === undefined || doc === '') return { texto: '', simples: true };
  if (typeof doc === 'string') return { texto: doc, simples: true };
  const blocos = (doc && doc.content) || [];
  const partes = [];
  let simples = doc.type === 'doc' && blocos.length <= 1;
  blocos.forEach((b, n) => {
    if (n > 0) partes.push('\n');
    if (!b || b.type !== 'paragraph') simples = false;
    const andar = (no) => {
      if (!no || typeof no !== 'object') return;
      if (no.type === 'text') {
        if (no.marks && no.marks.length) simples = false;
        partes.push(String(no.text || ''));
      } else if (no.type === 'hardBreak') partes.push('\n');
      else {
        if (no !== b) simples = false;
        (no.content || []).forEach(andar);
      }
    };
    andar(b);
  });
  return { texto: partes.join(''), simples };
}

/** Texto -> ADF no mesmo formato que o Jira usa nesta Solução: um parágrafo,
 * quebra de linha = hardBreak. Texto vazio apaga o campo (null). */
function textoParaAdf(texto) {
  const t = normalizarTexto(texto);
  if (!t) return null;
  const content = [];
  t.split('\n').forEach((linha, n) => {
    if (n > 0) content.push({ type: 'hardBreak' });
    if (linha !== '') content.push({ type: 'text', text: linha });
  });
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content }] };
}

/** "Versão" do que a tela leu: muda se qualquer coisa mudar no campo. */
function versaoDe(valorCampo) {
  return crypto.createHash('sha256').update(JSON.stringify(valorCampo === undefined ? null : valorCampo)).digest('hex').slice(0, 32);
}

function tarefaDe(issue) {
  const f = issue.fields || {};
  const lido = adfParaTexto(f[CAMPO_SOLUCAO]);
  return {
    chave: issue.key,
    resumo: String(f.summary || ''),
    status: (f.status && f.status.name) || '',
    texto: lido.texto,
    editavel: lido.simples,
    motivo: lido.simples ? '' : 'Esta Solução tem formatação (negrito, lista, link, imagem ou mais de um parágrafo). Edite no Jira para não perder a formatação.',
    versao: versaoDe(f[CAMPO_SOLUCAO])
  };
}

const CAMPOS_LIDOS = ['summary', 'status', 'issuetype', 'project', CAMPO_SOLUCAO].join(',');

/** As tasks cuja Solução a expedição usa: a própria task ou, num épico, as
 * filhas (sem subtarefas, sem canceladas/recusadas) - as mesmas que o checklist
 * confere. Devolve { status: 'ok' | 'nao-encontrada' | 'fora-do-projeto', tarefas }. */
async function lerSolucoes(chaveExpedicao, chamar) {
  const chave = chaveDoProjeto(chaveExpedicao);
  if (!chave) return { status: 'fora-do-projeto', tarefas: [] };
  let issue;
  try {
    issue = await chamar(`/rest/api/3/issue/${chave}?fields=${CAMPOS_LIDOS}`);
  } catch (erro) {
    if (/respondeu 40[04]\b/.test(String(erro.message))) return { status: 'nao-encontrada', tarefas: [] };
    throw erro;
  }
  const nivel = issue.fields && issue.fields.issuetype ? issue.fields.issuetype.hierarchyLevel : 0;
  if (nivel >= 1) {
    const jql = encodeURIComponent(`parent = ${chave} AND issuetype not in subTaskIssueTypes() ORDER BY key ASC`);
    const r = await chamar(`/rest/api/3/search/jql?jql=${jql}&maxResults=100&fields=${CAMPOS_LIDOS}`);
    const filhos = (r.issues || []).filter((i) => !STATUS_IGNORADOS.includes(norm(i.fields && i.fields.status && i.fields.status.name)))
      .filter((i) => chaveDoProjeto(i.key));
    return { status: 'ok', tipo: 'epico', tarefas: filhos.map(tarefaDe) };
  }
  return { status: 'ok', tipo: 'task', tarefas: [tarefaDe(issue)] };
}

/** Valida o pedido da tela antes de qualquer chamada ao Jira. */
function validarPedido(chaveTask, corpo) {
  const chave = chaveDoProjeto(chaveTask);
  if (!chave) return { ok: false, erro: `Só issues do projeto ${PROJETO} podem ser editadas daqui.` };
  if (!corpo || typeof corpo !== 'object') return { ok: false, erro: 'Corpo inválido.' };
  if (typeof corpo.texto !== 'string') return { ok: false, erro: 'Texto da Solução inválido.' };
  if (typeof corpo.versao !== 'string' || !/^[0-9a-f]{32}$/.test(corpo.versao)) return { ok: false, erro: 'Abra a Solução de novo antes de salvar.' };
  const texto = normalizarTexto(corpo.texto);
  if (texto.length > MAX_TEXTO) return { ok: false, erro: `A Solução passa de ${MAX_TEXTO} caracteres.` };
  return { ok: true, chave, texto, versao: corpo.versao };
}

/** Grava a Solução de UMA task. Relê o campo antes: formatado ou mudado
 * desde a leitura da tela = recusa (conflito). Mesmo texto = não grava nada
 * (nem linha no histórico do Jira).
 * Devolve { ok, semMudanca?, anterior, novo } ou { ok: false, conflito|formatada|naoEncontrada|foraDoProjeto, erro, atual? }. */
async function gravarSolucao(pedido, chamar) {
  let issue;
  try {
    issue = await chamar(`/rest/api/3/issue/${pedido.chave}?fields=${CAMPOS_LIDOS}`);
  } catch (erro) {
    if (/respondeu 40[04]\b/.test(String(erro.message))) return { ok: false, naoEncontrada: true, erro: 'A issue não foi encontrada no Jira.' };
    throw erro;
  }
  const f = issue.fields || {};
  if ((f.project && f.project.key) !== PROJETO) return { ok: false, foraDoProjeto: true, erro: `Só issues do projeto ${PROJETO} podem ser editadas daqui.` };
  if (f.issuetype && f.issuetype.subtask) return { ok: false, foraDoProjeto: true, erro: 'Subtarefa não tem Solução: edite a task principal.' };
  const atual = tarefaDe(issue);
  if (!atual.editavel) return { ok: false, formatada: true, erro: atual.motivo, atual };
  if (atual.versao !== pedido.versao) {
    return { ok: false, conflito: true, erro: 'A Solução mudou no Jira depois que você abriu. Confira o texto atual e salve de novo.', atual };
  }
  if (normalizarTexto(atual.texto) === pedido.texto) return { ok: true, semMudanca: true, anterior: atual.texto, novo: pedido.texto };
  await chamar(`/rest/api/3/issue/${pedido.chave}`, { metodo: 'PUT', corpo: { fields: { [CAMPO_SOLUCAO]: textoParaAdf(pedido.texto) } } });
  return { ok: true, anterior: atual.texto, novo: pedido.texto };
}

module.exports = {
  DOMINIOS_GRAVAM_JIRA, PROJETO, CAMPO_SOLUCAO, MAX_TEXTO,
  podeGravarJira, chaveDoProjeto, normalizarTexto, adfParaTexto, textoParaAdf, versaoDe,
  lerSolucoes, validarPedido, gravarSolucao
};
