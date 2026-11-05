// Pesquisa por número do chamado (ACS ou TTB) ou por um termo: acha a task no
// Jira e o que a nossa base (Demandas, Expedições) sabe do mesmo número.
//
// Por que existe: o cliente fala pelo número dele, não pela task. O ACS de
// demanda (11 dígitos) nunca está no Jira - só em Demandas/Expedições. O TTB de
// sustentação (10 dígitos) o time põe no título da task: "TTB - 2026100412 - ...".
//
// Regras puras aqui (testadas sem rede); a chamada ao Jira é injetada.

const { chaveJira } = require('./expedicoes');
const { urlJira } = require('./demandas');

const PROJETO = 'JDCBBRB';
const MIN = 3;
const MAX = 80;
const MAX_JIRA = 40;
const MAX_VINCULADAS = 10;
const CAMPOS = 'summary,status,assignee,issuetype,project,parent,created,updated,resolutiondate';

const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/** O que a pessoa digitou -> termo limpo e o tipo. Só letras, números, _ . - e
 * espaço entram: o termo vai dentro de uma busca do Jira (JQL), e aspas, barras
 * e operadores da busca não têm uso aqui. */
function normalizarTermo(q) {
  const bruto = String(q === undefined || q === null ? '' : q);
  const termo = bruto.replace(/[^\p{L}\p{N}_.\- ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (termo.length < MIN) return { ok: false, erro: `Digite pelo menos ${MIN} caracteres (o número do chamado, a task ou um termo).` };
  if (termo.length > MAX) return { ok: false, erro: `Use no máximo ${MAX} caracteres.` };
  // "TTB 2026110141", "TTB-2026110141", "ACS 20260917002" -> o número. Antes da
  // chave do Jira: "TTB-2026110141" tem a cara de uma, mas é o chamado.
  const comPrefixo = /^(?:ttb|acs)[\s\-]*(\d{6,})$/i.exec(termo);
  if (!comPrefixo && /^[A-Za-z][A-Za-z0-9]+-\d+$/.test(termo)) return { ok: true, termo: termo.toUpperCase(), tipo: 'jira', chave: termo.toUpperCase() };
  const numero = comPrefixo ? comPrefixo[1] : (/^\d+$/.test(termo) ? termo : '');
  if (numero) {
    const tipo = numero.length === 11 ? 'acs' : numero.length === 10 ? 'ttb' : 'numero';
    return { ok: true, termo: numero, tipo, numero };
  }
  return { ok: true, termo, tipo: 'texto' };
}

/** Busca do Jira. O número grudado no prefixo ("TTB-2026070342") é uma palavra só
 * para o Jira: buscar só o número não acha, então vão as duas formas. */
function montarJql(n) {
  let filtro;
  if (n.tipo === 'jira') filtro = `text ~ "${n.chave}"`;
  else if (n.numero) filtro = [n.numero, `TTB-${n.numero}`, `ACS-${n.numero}`].map((v) => `text ~ "${v}"`).join(' OR ');
  else filtro = `text ~ "${n.termo}"`;
  return `(${filtro}) ORDER BY updated DESC`;
}

/** Issue do Jira -> o que a tela mostra. */
function deIssue(i, origem) {
  const f = (i && i.fields) || {};
  const pai = f.parent ? { chave: f.parent.key, resumo: (f.parent.fields && f.parent.fields.summary) || '', url: urlJira(f.parent.key) } : null;
  return {
    chave: i.key,
    url: urlJira(i.key),
    resumo: String(f.summary || '').trim(),
    tipo: (f.issuetype && f.issuetype.name) || '',
    subtarefa: !!(f.issuetype && f.issuetype.subtask),
    status: (f.status && f.status.name) || '',
    categoria: (f.status && f.status.statusCategory && f.status.statusCategory.key) || '',
    responsavel: (f.assignee && f.assignee.displayName) || '',
    projeto: (f.project && f.project.key) || String(i.key || '').split('-')[0],
    pai,
    criado: f.created || null,
    atualizado: f.updated || null,
    resolvido: f.resolutiondate || null,
    origem
  };
}

/** O que Demandas e Expedições sabem do termo. ACS por igualdade (número inteiro),
 * task pela chave, texto pelo nome. */
function naBase(n, demandas, expedicoes) {
  const bate = (x) => {
    const acs = String(x.demandaAcs || '').trim();
    const k = chaveJira(x.artefatoJira);
    if (n.tipo === 'jira') return k === n.chave;
    if (n.numero) return acs.replace(/\D/g, '') === n.numero;
    const t = norm(n.termo);
    return norm(x.nome).includes(t) || norm(acs) === t;
  };
  return {
    demandas: (demandas || []).filter(bate).map((d) => ({
      id: d.id, mes: d.mes || '', acs: d.demandaAcs || '', jira: chaveJira(d.artefatoJira), nome: d.nome || '',
      previsaoExpedicao: d.previsaoExpedicao || null
    })),
    expedicoes: (expedicoes || []).filter(bate).map((e) => ({
      id: e.id, acs: e.demandaAcs || '', jira: chaveJira(e.artefatoJira), nome: e.nome || '', dataExpedicao: e.dataExpedicao || null
    }))
  };
}

/** Separa o nosso projeto dos outros times; o que veio da nossa base vem primeiro.
 * Chega aqui já sem subtarefa (ver subirSubtarefas); task de épico continua
 * sendo a task - o épico é amplo demais para representar o assunto. */
function organizar(issues) {
  const vistos = new Set();
  const unicas = [];
  for (const i of issues) { if (!vistos.has(i.chave)) { vistos.add(i.chave); unicas.push(i); } }
  const peso = (i) => (i.origem === 'base' ? 0 : 1);
  const ordenar = (a, b) => peso(a) - peso(b) || String(b.atualizado || '').localeCompare(String(a.atualizado || ''));
  return {
    projeto: unicas.filter((i) => i.projeto === PROJETO).sort(ordenar),
    outros: unicas.filter((i) => i.projeto !== PROJETO).sort(ordenar)
  };
}

const CHAVE_OK = /^[A-Z][A-Z0-9]+-\d+$/;

/** Subtarefa não é resultado: é um pedaço do trabalho (Codificação, Teste...).
 * Ela vira a task-pai, com a nota de onde o termo apareceu - descartar perderia
 * a task quando o termo só está num comentário da subtarefa. Pai que já está na
 * lista só ganha a nota; os outros vêm numa busca só. Se o pai não vier (Jira
 * lento, sem acesso), a subtarefa fica como está.
 * Junta repetidas: origem 'base' prevalece, termos (pesquisa ampla) somam. */
async function subirSubtarefas(itens, chamar) {
  const presentes = new Set(itens.map((i) => i.chave));
  const faltam = [...new Set(itens.filter((i) => i.subtarefa && i.pai && !presentes.has(i.pai.chave)).map((i) => i.pai.chave))].filter((k) => CHAVE_OK.test(k));
  const pais = {};
  if (faltam.length) {
    try {
      const r = await comRetentativa(() => chamar(`/rest/api/3/search/jql?jql=${encodeURIComponent(`key in (${faltam.join(',')})`)}&maxResults=${faltam.length}&fields=${CAMPOS}`));
      for (const raw of (r && r.issues) || []) pais[raw.key] = raw;
    } catch (erro) {
      console.error('[pesquisa] pais das subtarefas não vieram:', erro.message);
    }
  }
  const porChave = new Map();
  const novo = (i) => Object.assign({}, i, { via: [], termos: i.termos ? i.termos.slice() : undefined });
  for (const i of itens) {
    const sobe = i.subtarefa && i.pai && (presentes.has(i.pai.chave) || pais[i.pai.chave]);
    const chave = sobe ? i.pai.chave : i.chave;
    let alvo = porChave.get(chave);
    if (!alvo) {
      const original = sobe ? itens.find((x) => x.chave === chave) : i;
      alvo = original ? novo(original) : Object.assign(deIssue(pais[chave], i.origem), { via: [], termos: i.termos ? [] : undefined });
      porChave.set(chave, alvo);
    }
    if (sobe && !alvo.via.some((v) => v.chave === i.chave)) alvo.via.push({ chave: i.chave, url: i.url, resumo: i.resumo });
    if (i.origem === 'base') alvo.origem = 'base';
    if (alvo.termos && i.termos) for (const t of i.termos) if (!alvo.termos.includes(t)) alvo.termos.push(t);
    if (String(i.atualizado || '') > String(alvo.atualizado || '')) alvo.atualizado = i.atualizado;
  }
  return [...porChave.values()];
}

/** Quem trabalhou: o responsável da task e o de cada filha (subtarefas de
 * Codificação, Teste, Code Review...; num épico, as tasks). Só do nosso projeto.
 * Devolve { chavePai: [{ chave, resumo, tipo, status, categoria, responsavel }] }. */
function agruparFilhos(issues) {
  const porPai = {};
  for (const i of issues || []) {
    const f = i.fields || {};
    const pai = f.parent && f.parent.key;
    if (!pai) continue;
    (porPai[pai] = porPai[pai] || []).push({
      chave: i.key, url: urlJira(i.key), resumo: String(f.summary || '').trim(), tipo: (f.issuetype && f.issuetype.name) || '',
      status: (f.status && f.status.name) || '', categoria: (f.status && f.status.statusCategory && f.status.statusCategory.key) || '',
      responsavel: (f.assignee && f.assignee.displayName) || ''
    });
  }
  return porPai;
}

/** Pessoas distintas, na ordem: responsável da task, depois as das filhas. */
function envolvidos(issue, filhos) {
  const nomes = [issue.responsavel, ...(filhos || []).map((f) => f.responsavel)].filter(Boolean);
  return [...new Set(nomes)];
}

/** Uma issue pela chave; null se não existe ou a conta não enxerga. */
async function lerIssue(chave, chamar) {
  try {
    return await chamar(`/rest/api/3/issue/${encodeURIComponent(chave)}?fields=${CAMPOS}`);
  } catch (erro) {
    if (/respondeu 40[034]\b/.test(String(erro.message))) return null;
    throw erro;
  }
}

/** Lentidão pontual do Jira (timeout, 5xx, 429): vale uma segunda tentativa.
 * Já aconteceu de a mesma busca estourar 10 s e, em seguida, voltar em 1 s. */
const passageiro = (erro) => /não respondeu em|respondeu (5\d\d|429)\b/.test(String(erro && erro.message));

async function comRetentativa(fn) {
  try { return await fn(); } catch (erro) {
    if (!passageiro(erro)) throw erro;
    console.error('[pesquisa] Jira lento, tentando de novo:', String(erro.message).slice(0, 80));
    return fn();
  }
}

// A função na Vercel tem 30 s: depois disso, as filhas (opcionais) ficam de fora.
const LIMITE_FILHAS_MS = 15000;

/** Pesquisa completa. Jira fora do ar não derruba: a base responde sozinha e a
 * tela avisa que o Jira não foi consultado. */
async function pesquisar(n, { chamar, demandas, expedicoes, agora = Date.now }) {
  const inicio = agora();
  const base = naBase(n, demandas, expedicoes);
  const vinculadas = [...new Set([...base.demandas, ...base.expedicoes].map((x) => x.jira).filter(Boolean))].slice(0, MAX_VINCULADAS);
  if (n.tipo === 'jira' && !vinculadas.includes(n.chave)) vinculadas.unshift(n.chave);
  const jira = { status: 'ok', jql: montarJql(n), maisResultados: false };
  let achadas = [];
  try {
    const [busca, diretas] = await Promise.all([
      comRetentativa(() => chamar(`/rest/api/3/search/jql?jql=${encodeURIComponent(jira.jql)}&maxResults=${MAX_JIRA}&fields=${CAMPOS}`)),
      Promise.all(vinculadas.map((k) => comRetentativa(() => lerIssue(k, chamar))))
    ]);
    jira.maisResultados = !!(busca && busca.nextPageToken);
    achadas = [
      ...diretas.filter(Boolean).map((i) => deIssue(i, 'base')),
      ...((busca && busca.issues) || []).map((i) => deIssue(i, 'jira'))
    ];
    jira.naoEncontradas = vinculadas.filter((k, idx) => !diretas[idx]);
    achadas = await subirSubtarefas(achadas, chamar);
    // Filhas das tasks do nosso projeto (uma busca só). Sem elas a tela segue,
    // só com o responsável de cada task.
    const nossas = [...new Set(achadas.filter((i) => i.projeto === PROJETO).map((i) => i.chave))];
    if (nossas.length && agora() - inicio < LIMITE_FILHAS_MS) {
      try {
        const jqlFilhos = `parent in (${nossas.join(',')}) ORDER BY created ASC`;
        const r = await chamar(`/rest/api/3/search/jql?jql=${encodeURIComponent(jqlFilhos)}&maxResults=100&fields=summary,status,assignee,issuetype,parent`);
        const porPai = agruparFilhos(r && r.issues);
        for (const i of achadas) { i.filhos = porPai[i.chave] || []; i.envolvidos = envolvidos(i, i.filhos); }
      } catch (erro) {
        console.error('[pesquisa] filhas não vieram:', erro.message);
      }
    }
    for (const i of achadas) if (!i.envolvidos) { i.filhos = i.filhos || []; i.envolvidos = envolvidos(i, i.filhos); }
  } catch (erro) {
    jira.status = 'indisponivel';
    jira.erro = String(erro.message || erro).slice(0, 200);
  }
  return { termo: n.termo, tipo: n.tipo, jira, ...organizar(achadas), base };
}

// ---------------------------------------------------------------------------
// Pesquisa ampla: a pessoa cola a mensagem do cliente e a tela acha tasks do
// mesmo assunto. O número do chamado só existe no sistema do cliente; o que liga
// o chamado às tasks antigas são os nomes técnicos (tabela, procedure, versão).
// Regras simples, sem IA: o texto não sai do servidor.

const MAX_TEXTO = 4000;
const MAX_TERMOS = 8;
const MAX_NUMEROS = 2;
const POR_TERMO = 25;
const MAX_LISTA = 20;
const MAX_FILHAS_AMPLA = 10;

// Siglas que aparecem em quase toda mensagem e não dizem o assunto.
const PARADAS = new Set(['BRB', 'TTB', 'ACS', 'SQL', 'PROD', 'HML', 'HMG', 'DEV', 'URGENTE', 'FAVOR', 'OBS', 'ATT', 'CPF', 'CNPJ',
  'JIRA', 'TEAMS', 'ERRO', 'TESTE', 'PRD', 'BOM', 'DIA', 'OLA', 'PFV', 'POR', 'PARA', 'COM', 'QUE', 'NAO', 'SIM', 'DOS', 'DAS',
  'ROTINA', 'SISTEMA', 'CLIENTE', 'CHAMADO', 'PROBLEMA', 'AJUDA', 'HOJE', 'AINDA', 'ESTA', 'TEM', 'UMA', 'NOS', 'MAS', 'PELO', 'PELA']);

/** Termo vindo de fora (a pessoa removeu ou digitou) -> mesmo filtro da busca exata. */
function limparTermo(t) {
  const s = String(t || '').replace(/[^\p{L}\p{N}_.\-]+/gu, '').trim().toUpperCase();
  return s.length >= MIN && s.length <= MAX ? s : '';
}

/** Mensagem do cliente -> { numeros (chamados), termos (assunto) }, na ordem de
 * quanto cada tipo costuma acertar: identificador com "_", chave de task, código
 * com letra e dígito, versão, sigla. */
function extrairTermos(texto) {
  const t = String(texto || '').slice(0, MAX_TEXTO);
  // Limite de palavra que entende acento: com \b, "VERIFICAÇÃO" viraria "VERIFICA".
  const palavra = (corpo, extraFim = '') => new RegExp(`(?<![\\p{L}\\p{N}_])${corpo}(?![\\p{L}\\p{N}_${extraFim}])`, 'gu');
  const numeros = [...new Set(t.match(palavra('\\d{10,11}')) || [])].slice(0, MAX_NUMEROS);
  const regras = [
    palavra('[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+'),
    palavra('(?!(?:TTB|ACS)-)[A-Z][A-Z0-9]+-\\d+'),
    palavra('(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\\d)[A-Z0-9]{4,}', '\\-'),
    palavra('(?<![\\d.])\\d{1,3}\\.\\d{1,3}(?:\\.\\d{1,3})?(?![.,]\\d)'), // "1.500,00" é valor, não versão
    palavra('[A-Z]{3,10}', '\\-')
  ];
  const termos = [];
  for (const r of regras) {
    for (const m of t.match(r) || []) {
      const s = limparTermo(m);
      if (!s || PARADAS.has(s) || termos.includes(s) || /^\d+$/.test(s)) continue;
      termos.push(s);
    }
  }
  return { numeros, termos: termos.slice(0, MAX_TERMOS) };
}

/** Pessoas que mais aparecem nas tasks do assunto: quem pode ajudar. */
function pessoasFrequentes(issues) {
  const conta = new Map();
  for (const i of issues) for (const nome of i.envolvidos || []) conta.set(nome, (conta.get(nome) || 0) + 1);
  return [...conta].map(([nome, tasks]) => ({ nome, tasks })).sort((a, b) => b.tasks - a.tasks || a.nome.localeCompare(b.nome)).slice(0, 8);
}

// ---- Relevância (pesquisa ampla) --------------------------------------------
// Imita o que uma pessoa faz ao ler os resultados, sem IA:
//   - termo raro diz mais do assunto do que termo comum (T402COGC_HST em 4 tasks
//     pesa mais que PCRA2 em 25+);
//   - termo no título vale o dobro: a task É sobre aquilo, não só cita;
//   - cancelada/recusada vale a metade.
// Caso real que motivou: a mensagem do BDCF 89.01; a task certa (JDCBCRED5-1050,
// "89.01" no título) era de outro time e ficava atrás de todo o JDCBBRB.
const RARO = 10;
const MAX_PROVAVEIS = 5;
const CANCELADOS = /^(cancelad[oa]|recusad[oa])$/i;

/** Termos pesquisados -> { termo: { peso, raro } }. Peso cai com quantas tasks o
 * termo achou (log), "25+" conta como 50. */
function pesoTermos(resumoTermos) {
  const pesos = {};
  for (const t of resumoTermos || []) {
    if (t.falhou) continue;
    const n = t.maisDe ? 50 : Math.max(t.tasks || 0, 1);
    pesos[t.termo] = { peso: 1 / Math.log2(1 + n), raro: n <= RARO };
  }
  return pesos;
}

/** Pontos de uma task e o porquê (para a tela mostrar). */
function pontuar(i, pesos) {
  const titulo = String(i.resumo || '').toLowerCase();
  const motivos = [];
  let pontos = 0;
  for (const t of i.termos || []) {
    const p = pesos[t];
    if (!p) continue;
    const noTitulo = titulo.includes(t.toLowerCase());
    pontos += p.peso * (noTitulo ? 2 : 1);
    motivos.push({ termo: t, titulo: noTitulo, raro: p.raro });
  }
  const cancelada = CANCELADOS.test(String(i.status || '').trim());
  if (cancelada) pontos /= 2;
  motivos.sort((a, b) => (b.titulo - a.titulo) || (b.raro - a.raro));
  return { pontos: Math.round(pontos * 1000) / 1000, motivos, cancelada };
}

/** Nível em relação à melhor da pesquisa: o número solto não diz nada à pessoa. */
function nivelDe(pontos, melhor) {
  const r = melhor > 0 ? pontos / melhor : 0;
  return r >= 0.7 ? 'alta' : r >= 0.4 ? 'media' : 'baixa';
}

/** Pesquisa ampla. Cada termo é uma busca no Jira (em paralelo): assim se sabe
 * quais termos cada task cita. A ordem é por relevância (ver pontuar), e as
 * melhores de qualquer projeto sobem para "mais prováveis". Os números da
 * mensagem passam pela busca exata, que aparece antes como "este chamado". */
async function pesquisarAmplo({ termos, numeros }, { chamar, demandas, expedicoes, agora = Date.now }) {
  const inicio = agora();
  const exatasP = Promise.all(numeros.map((num) => pesquisar(normalizarTermo(num), { chamar, demandas, expedicoes, agora })));
  const buscas = await Promise.allSettled(termos.map((termo) => comRetentativa(() =>
    chamar(`/rest/api/3/search/jql?jql=${encodeURIComponent(`text ~ "${termo}" ORDER BY updated DESC`)}&maxResults=${POR_TERMO}&fields=${CAMPOS}`))));
  const exatas = await exatasP;

  const jaNoChamado = new Set(exatas.flatMap((r) => [...r.projeto, ...r.outros].flatMap((i) => [i.chave, ...(i.filhos || []).map((f) => f.chave)])));
  const porChave = new Map();
  const resumoTermos = termos.map((termo, idx) => {
    const b = buscas[idx];
    if (b.status !== 'fulfilled') return { termo, falhou: true, tasks: 0 };
    const issues = (b.value && b.value.issues) || [];
    for (const raw of issues) {
      if (jaNoChamado.has(raw.key)) continue;
      const i = porChave.get(raw.key) || Object.assign(deIssue(raw, 'jira'), { termos: [] });
      i.termos.push(termo);
      porChave.set(raw.key, i);
    }
    return { termo, falhou: false, tasks: issues.length, maisDe: !!(b.value && b.value.nextPageToken) };
  });

  // Subtarefa vira a task-pai; a do próprio chamado já aparece em "este chamado".
  const soltas = (await subirSubtarefas([...porChave.values()], chamar)).filter((i) => !jaNoChamado.has(i.chave));
  const pesos = pesoTermos(resumoTermos);
  for (const i of soltas) Object.assign(i, pontuar(i, pesos));
  const ordenar = (a, b) => b.pontos - a.pontos || String(b.atualizado || '').localeCompare(String(a.atualizado || ''));
  soltas.sort(ordenar);
  const melhor = soltas.length ? soltas[0].pontos : 0;
  for (const i of soltas) i.nivel = nivelDe(i.pontos, melhor);

  // As melhores de qualquer projeto vão para o topo; o resto fica por projeto,
  // sem repetir. Relevância baixa não entra em "mais prováveis" (só a 1ª, sempre).
  const provaveis = soltas.filter((i, idx) => idx === 0 || i.nivel !== 'baixa').slice(0, MAX_PROVAVEIS);
  const noTopo = new Set(provaveis.map((i) => i.chave));
  const resto = soltas.filter((i) => !noTopo.has(i.chave));
  const nossoTodo = resto.filter((i) => i.projeto === PROJETO);
  const outrosTodo = resto.filter((i) => i.projeto !== PROJETO);
  const nosso = nossoTodo.slice(0, MAX_LISTA);
  const outros = outrosTodo.slice(0, MAX_LISTA);

  // Quem trabalhou: filhas das tasks do nosso projeto que aparecem primeiro.
  const comFilhas = [...provaveis, ...nosso].filter((i) => i.projeto === PROJETO).slice(0, MAX_FILHAS_AMPLA);
  if (comFilhas.length && agora() - inicio < LIMITE_FILHAS_MS) {
    try {
      const r = await chamar(`/rest/api/3/search/jql?jql=${encodeURIComponent(`parent in (${comFilhas.map((i) => i.chave).join(',')}) ORDER BY created ASC`)}&maxResults=100&fields=summary,status,assignee,issuetype,parent`);
      const porPai = agruparFilhos(r && r.issues);
      for (const i of comFilhas) i.filhos = porPai[i.chave] || [];
    } catch (erro) {
      console.error('[pesquisa ampla] filhas não vieram:', erro.message);
    }
  }
  for (const i of [...provaveis, ...nosso, ...outros]) { i.filhos = i.filhos || []; i.envolvidos = envolvidos(i, i.filhos); }

  // Nomes em Demandas/Expedições que citam algum termo.
  const base = { demandas: [], expedicoes: [] };
  for (const termo of termos) {
    const b = naBase({ tipo: 'texto', termo }, demandas, expedicoes);
    for (const d of b.demandas) if (!base.demandas.some((x) => x.id === d.id)) base.demandas.push(d);
    for (const e of b.expedicoes) if (!base.expedicoes.some((x) => x.id === e.id)) base.expedicoes.push(e);
  }

  const falhas = resumoTermos.filter((t) => t.falhou).length;
  const status = !termos.length ? 'ok' : falhas === termos.length ? 'indisponivel' : falhas ? 'parcial' : 'ok';
  const erroJira = buscas.find((b) => b.status === 'rejected');
  return {
    termos: resumoTermos,
    exatas,
    provaveis, nosso, outros,
    totalNosso: nossoTodo.length, totalOutros: outrosTodo.length,
    pessoas: pessoasFrequentes([...provaveis, ...nosso]),
    base,
    jira: { status, erro: erroJira ? String(erroJira.reason && erroJira.reason.message).slice(0, 200) : undefined }
  };
}

module.exports = {
  PROJETO, MIN, MAX, MAX_JIRA, MAX_TEXTO, MAX_TERMOS,
  normalizarTermo, montarJql, deIssue, naBase, organizar, agruparFilhos, envolvidos, pesquisar,
  limparTermo, extrairTermos, pessoasFrequentes, pesquisarAmplo,
  pesoTermos, pontuar, nivelDe
};
