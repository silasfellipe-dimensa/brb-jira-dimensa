// Itens do checklist que o Jira responde sozinho.
//
// A expedição é um ÉPICO: cada regra vale para as tasks filhas dele (todas as
// não canceladas/recusadas precisam cumprir). Se a chave for uma task, vale
// para ela mesma. Só campos fixos do Jira: não olha o TIPO das subtarefas.
//
// Fica de fora, de propósito: apontamentos de horas, subtarefa GCAD/"Modelagem
// de Dados", Branch (vazio em 100% das issues), Documentos de Configuração e
// Release Note (não achei campo no Jira), versão x data, componente x módulo.
//
// Os identificadores customfield_* são DESTA instância do Jira: se o
// administrador mudar um campo, a regra correspondente para de achar valor.
// Tudo que é específico daqui está nas constantes abaixo.

const CAMPOS = {
  solucao: 'customfield_12864',
  situacaoRequisito: 'customfield_12369',
  // existem dois campos chamados "Demais Documentações"; vale qualquer um preenchido
  demaisDocumentacoes: ['customfield_13096', 'customfield_12493'],
  dataInternaAcordada: 'customfield_12181',
  conclusaoTesteAceitacao: 'customfield_12456'
};

// tasks em qualquer um destes status não entram na conta do épico
const STATUS_IGNORADOS = ['cancelado', 'recusado'];
// tipos de task que não entram na conta do épico (ex.: 'avaliacao/estimativa'). Vazio até
// o time validar quais tipos carregam Solução, Situação etc.; nomes sem acento e minúsculos.
const TIPOS_IGNORADOS = [];
// "Teste de aceitação concluído" e o que vem depois dele no fluxo
const STATUS_TESTE_OK = ['teste de aceitacao concluido', 'implantacao', 'concluido'];

const CAMPOS_PEDIDOS = [
  'summary', 'issuetype', 'status', 'description', 'subtasks',
  CAMPOS.solucao, CAMPOS.situacaoRequisito, ...CAMPOS.demaisDocumentacoes,
  CAMPOS.dataInternaAcordada, CAMPOS.conclusaoTesteAceitacao
].join(',');

const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

const TIPOS_COM_CONTEUDO = ['media', 'mediaSingle', 'mediaGroup', 'inlineCard', 'blockCard', 'embedCard', 'mention', 'emoji'];

/** Texto do Jira vem como string (campo de linha) ou como documento ADF (campo
 * de texto longo). Parágrafo vazio não conta; imagem ou link, sim. */
function adfTemConteudo(no) {
  if (!no || typeof no !== 'object') return false;
  if (no.type === 'text') return String(no.text || '').trim() !== '';
  if (TIPOS_COM_CONTEUDO.includes(no.type)) return true;
  return (no.content || []).some(adfTemConteudo);
}
function temConteudo(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'number') return true;
  if (Array.isArray(v)) return v.some(temConteudo);
  if (typeof v === 'object') return v.type === 'doc' ? adfTemConteudo(v) : Object.keys(v).length > 0;
  return false;
}

const preenchido = (valor, falta) => (temConteudo(valor) ? { ok: true, motivo: '' } : { ok: false, motivo: falta });
const categoria = (s) => s && s.fields && s.fields.status && s.fields.status.statusCategory && s.fields.status.statusCategory.key;

/** `texto` é exatamente o texto do item em ITENS_PADRAO (é por ele que o item é achado). */
const REGRAS = [
  { texto: 'Descrição preenchida?', rotulo: 'Descrição', avaliar: (f) => preenchido(f.description, 'Descrição vazia') },
  { texto: 'Solução preenchida?', rotulo: 'Solução', avaliar: (f) => preenchido(f[CAMPOS.solucao], 'Solução vazia') },
  { texto: 'Situação / Requisito preenchido', rotulo: 'Situação/Requisito', avaliar: (f) => preenchido(f[CAMPOS.situacaoRequisito], 'Situação/Requisito vazio') },
  {
    texto: 'Demais Documentações preenchidas', rotulo: 'Demais Documentações',
    avaliar: (f) => (CAMPOS.demaisDocumentacoes.some((k) => temConteudo(f[k])) ? { ok: true, motivo: '' } : { ok: false, motivo: 'Demais Documentações vazia' })
  },
  { texto: 'Data interna acordada registrada? (boa prática)', rotulo: 'Data Interna Acordada', avaliar: (f) => preenchido(f[CAMPOS.dataInternaAcordada], 'Data Interna Acordada vazia') },
  {
    texto: 'Todas as subtarefas concluídas', rotulo: 'Subtarefas',
    avaliar: (f) => {
      const sub = f.subtasks || [];
      if (!sub.length) return { ok: false, motivo: 'sem subtarefas' };
      const abertas = sub.filter((s) => categoria(s) !== 'done');
      return abertas.length
        ? { ok: false, motivo: `${abertas.length} subtarefa(s) em aberto (${abertas.slice(0, 4).map((s) => s.key).join(', ')}${abertas.length > 4 ? '…' : ''})` }
        : { ok: true, motivo: '' };
    }
  },
  {
    texto: 'Status: Teste de aceitação concluído', rotulo: 'Teste de aceitação',
    avaliar: (f) => {
      if (temConteudo(f[CAMPOS.conclusaoTesteAceitacao])) return { ok: true, motivo: '' };
      const nome = f.status && f.status.name;
      if (STATUS_TESTE_OK.includes(norm(nome))) return { ok: true, motivo: '' };
      return { ok: false, motivo: `status "${nome || '?'}"` };
    }
  }
];

const TEXTOS_JIRA = REGRAS.map((r) => r.texto);

/** Uma task sozinha: { texto: { ok, motivo, detalhe } } */
function avaliarTask(fields) {
  const itens = {};
  for (const r of REGRAS) {
    const a = r.avaliar(fields || {});
    itens[r.texto] = { ok: a.ok, motivo: a.ok ? '' : `${a.motivo} no Jira`, detalhe: '' };
  }
  return itens;
}

/** Épico: o item só está ok se TODAS as tasks consideradas cumprem. `detalhe`
 * mostra task por task, para quem for conferir. */
function avaliarEpico(filhos) {
  const itens = {};
  for (const r of REGRAS) {
    const por = filhos.map((f) => ({ chave: f.key, ...r.avaliar(f.fields || {}) }));
    const falham = por.filter((p) => !p.ok);
    itens[r.texto] = {
      ok: falham.length === 0,
      motivo: falham.length ? `${r.rotulo}: falta em ${falham.map((p) => p.chave).join(', ')}` : '',
      detalhe: por.map((p) => `${p.chave} ${p.ok ? '✓' : '✗'}`).join(' · ')
    };
  }
  return itens;
}

/** Lê do Jira e avalia. `chamar` é a chamada ao Jira (injetada para testar sem rede).
 * Devolve { status: 'ok' | 'sem-filhos' | 'nao-encontrada', tipo, filhos, itens }.
 * Qualquer outro erro (rede, 401, 5xx) sobe: quem chamou decide ("indisponível"). */
async function lerDoJira(chave, chamar) {
  let issue;
  try {
    issue = await chamar(`/rest/api/3/issue/${chave}?fields=${CAMPOS_PEDIDOS}`);
  } catch (erro) {
    if (/respondeu 40[04]\b/.test(String(erro.message))) return { status: 'nao-encontrada' };
    throw erro;
  }
  const nivel = issue.fields && issue.fields.issuetype ? issue.fields.issuetype.hierarchyLevel : 0;
  if (nivel >= 1) {
    const jql = encodeURIComponent(`parent = ${chave} AND issuetype not in subTaskIssueTypes()`);
    const r = await chamar(`/rest/api/3/search/jql?jql=${jql}&maxResults=100&fields=${CAMPOS_PEDIDOS}`);
    const filhos = (r.issues || []).filter((i) => !STATUS_IGNORADOS.includes(norm(i.fields && i.fields.status && i.fields.status.name))
      && !TIPOS_IGNORADOS.includes(norm(i.fields && i.fields.issuetype && i.fields.issuetype.name)));
    if (!filhos.length) return { status: 'sem-filhos', tipo: 'epico', filhos: 0 };
    return { status: 'ok', tipo: 'epico', filhos: filhos.length, itens: avaliarEpico(filhos) };
  }
  return { status: 'ok', tipo: 'task', filhos: 0, itens: avaliarTask(issue.fields) };
}

/** Cache curto: a tela abre várias vezes por minuto e o Jira não precisa ser
 * consultado a cada vez. O botão "Atualizar do Jira" ignora o cache. */
function criarCache(ttlMs = 120000, agora = () => Date.now()) {
  const m = new Map();
  return {
    obter(k) { const e = m.get(k); return e && agora() - e.em < ttlMs ? e.v : null; },
    obterVelho(k) { const e = m.get(k); return e ? e.v : null; },
    guardar(k, v) { m.set(k, { v, em: agora() }); },
    limpar() { m.clear(); }
  };
}

async function verificar(chave, chamar, { cache, forcar } = {}) {
  if (cache && !forcar) { const c = cache.obter(chave); if (c) return c; }
  try {
    const v = { ...(await lerDoJira(chave, chamar)), lidoEm: new Date().toISOString() };
    if (cache) cache.guardar(chave, v);
    return v;
  } catch (erro) {
    // Jira fora do ar: melhor o último que a gente leu do que nada
    const velho = cache && cache.obterVelho(chave);
    if (velho) return { ...velho, desatualizado: true };
    return { status: 'indisponivel', erro: String(erro.message || erro).slice(0, 200) };
  }
}

/** Várias chaves de uma vez (poucas por vez, para não bombardear o Jira), com um
 * teto de tempo: o que não deu tempo vira "indisponível" em vez de travar a tela. */
async function verificarVarias(chaves, chamar, { cache, forcar, limite = 5, tetoMs = 12000 } = {}) {
  const unicas = [...new Set(chaves)];
  const saida = {};
  const trabalho = (async () => {
    for (let i = 0; i < unicas.length; i += limite) {
      await Promise.all(unicas.slice(i, i + limite).map(async (k) => { saida[k] = await verificar(k, chamar, { cache, forcar }); }));
    }
  })();
  let timer;
  await Promise.race([trabalho, new Promise((r) => { timer = setTimeout(r, tetoMs); })]);
  clearTimeout(timer);
  for (const k of unicas) if (!saida[k]) saida[k] = { status: 'indisponivel', erro: 'tempo esgotado' };
  return saida;
}

module.exports = {
  CAMPOS, CAMPOS_PEDIDOS, REGRAS, TEXTOS_JIRA, STATUS_IGNORADOS, TIPOS_IGNORADOS, STATUS_TESTE_OK,
  temConteudo, avaliarTask, avaliarEpico, lerDoJira, criarCache, verificar, verificarVarias
};
