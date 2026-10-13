// Regras puras da tela "Expedições" (checklist do time) - sem banco, sem rede.
// Ficam aqui, e não no supabase.js, para serem testadas isoladamente.

const { interpretarData, idDemanda, urlJira } = require('./demandas');

const LIMITE = { jira: 40, nome: 300, acs: 40, item: 200, justificativa: 500 };
const MIN_JUSTIFICATIVA = 10;
const BLOCOS = ['comitar', 'expedir'];
const ESTADOS = ['pendente', 'concluido', 'nao_aplicavel'];
const FUSO = 'America/Sao_Paulo';

/** Itens que toda expedição ganha ao ser criada: a união das duas listas do
 * time (checklist rápido + pré-expedição), sem repetir. São COPIADOS para cada
 * expedição: mudar a lista aqui vale só para as novas, as antigas ficam como
 * foram conferidas. */
const ITENS_PADRAO = [
  { bloco: 'comitar', texto: 'A issue tem a versão correta para a data de entrega?' },
  { bloco: 'comitar', texto: 'O componente corresponde ao módulo da versão?' },
  { bloco: 'comitar', texto: 'Há pelo menos 1 issue por módulo alterado?' },
  { bloco: 'comitar', texto: 'Se houver banco, subtarefa GCAD com os requisitos ok?' },
  { bloco: 'comitar', texto: 'Data interna acordada registrada? (boa prática)' },
  { bloco: 'comitar', texto: 'Branch: VERSÃO FIX → master | VERSÃO RELEASE → Developer?' },
  { bloco: 'expedir', texto: 'Status: Teste de aceitação concluído' },
  { bloco: 'expedir', texto: 'Todas as subtarefas concluídas' },
  { bloco: 'expedir', texto: 'Apontamentos de horas realizados' },
  { bloco: 'expedir', texto: 'Situação / Requisito preenchido' },
  { bloco: 'expedir', texto: 'Solução preenchida' },
  { bloco: 'expedir', texto: 'Demais Documentações preenchidas' },
  { bloco: 'expedir', texto: 'Release Note em linguagem de usuário' },
  { bloco: 'expedir', texto: 'Release Note com mais de 60 caracteres, objetivo e sem detalhes técnicos' },
  { bloco: 'expedir', texto: 'A versão ficou verde no painel até 14h?' }
];

const tem = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const texto = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** "JDCBBRB-401" ou "https://.../browse/jdcbbrb-401" -> "JDCBBRB-401". */
function chaveJira(valor) {
  const m = /([A-Za-z][A-Za-z0-9]+-\d+)/.exec(texto(valor));
  return m ? m[1].toUpperCase() : '';
}

/** Corpo de POST/PATCH da expedição -> colunas. Só entra o que está na lista.
 * No POST exige ao menos Jira, nome ou ACS (senão o card não identifica nada). */
function normalizarExpedicao(corpo, { criando } = {}) {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) return { ok: false, erro: 'Corpo inválido.' };
  const registro = {};
  const campos = [
    ['artefatoJira', 'artefato_jira', 'jira', 'Jira'],
    ['nome', 'nome', 'nome', 'Nome'],
    ['demandaAcs', 'demanda_acs', 'acs', 'ACS']
  ];
  for (const [chave, coluna, lim, rotulo] of campos) {
    if (!tem(corpo, chave)) continue;
    const t = chave === 'artefatoJira' ? (chaveJira(corpo[chave]) || texto(corpo[chave])) : texto(corpo[chave]);
    if (t.length > LIMITE[lim]) return { ok: false, erro: `${rotulo}: texto longo demais (máximo ${LIMITE[lim]} caracteres).` };
    registro[coluna] = t;
  }
  if (tem(corpo, 'dataExpedicao')) {
    const d = interpretarData(corpo.dataExpedicao);
    if (!d.ok) return { ok: false, erro: 'Data de expedição inválida.' };
    registro.data_expedicao = d.valor;
  }
  // O responsável não é digitado: vem do card no Jira (quem chama preenche).
  if (criando && !(registro.artefato_jira || registro.nome || registro.demanda_acs)) {
    return { ok: false, erro: 'Informe ao menos o Jira, o nome ou o número ACS.' };
  }
  if (!criando && !Object.keys(registro).length) return { ok: false, erro: 'Nada para alterar.' };
  return { ok: true, registro };
}

/** Novo item avulso, só daquela expedição. */
function normalizarItemNovo(corpo) {
  if (!corpo || typeof corpo !== 'object') return { ok: false, erro: 'Corpo inválido.' };
  if (!BLOCOS.includes(corpo.bloco)) return { ok: false, erro: 'Bloco inválido.' };
  const t = texto(corpo.texto);
  if (t.length < 3) return { ok: false, erro: 'Descreva o item (mínimo 3 caracteres).' };
  if (t.length > LIMITE.item) return { ok: false, erro: `Item longo demais (máximo ${LIMITE.item} caracteres).` };
  return { ok: true, bloco: corpo.bloco, texto: t };
}

/** Mudança de estado do item. "Não aplicável" exige o motivo; qualquer outro
 * estado limpa o motivo (voltar para pendente desfaz o N/A por completo). */
function normalizarEstadoItem(corpo) {
  if (!corpo || typeof corpo !== 'object' || !ESTADOS.includes(corpo.estado)) {
    return { ok: false, erro: 'Estado inválido.' };
  }
  if (corpo.estado !== 'nao_aplicavel') return { ok: true, estado: corpo.estado, justificativa: null };
  const j = texto(corpo.justificativa);
  if (j.length < MIN_JUSTIFICATIVA) {
    return { ok: false, erro: `Explique brevemente por que não se aplica (mínimo ${MIN_JUSTIFICATIVA} caracteres).` };
  }
  if (j.length > LIMITE.justificativa) return { ok: false, erro: `Motivo longo demais (máximo ${LIMITE.justificativa} caracteres).` };
  return { ok: true, estado: 'nao_aplicavel', justificativa: j };
}

/** Concluído e N/A (com motivo) contam como resolvidos; só pendente falta. */
function progresso(itens) {
  const ativos = itens.filter((i) => !i.removido);
  const concluidos = ativos.filter((i) => i.estado === 'concluido').length;
  const naoAplicaveis = ativos.filter((i) => i.estado === 'nao_aplicavel').length;
  return {
    total: ativos.length,
    concluidos,
    naoAplicaveis,
    pendentes: ativos.length - concluidos - naoAplicaveis
  };
}

/** Data de hoje no relógio de Brasília (o servidor roda em UTC: sem isso, a
 * partir das 21h "hoje" viraria amanhã). */
function hojeBrasilia(agora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
}

function diasAte(dataIso, hoje) {
  const [a, m, d] = dataIso.split('-').map(Number);
  const [ha, hm, hd] = hoje.split('-').map(Number);
  return Math.round((Date.UTC(a, m - 1, d) - Date.UTC(ha, hm - 1, hd)) / 86400000);
}

/** Onde a expedição cai na reunião e se pede atenção: vermelho quando a
 * expedição é hoje, amanhã ou já passou e ainda há item pendente. */
function classificar(dataExpedicao, pendentes, hoje) {
  if (!dataExpedicao) return { grupo: 'sem-data', alerta: false, dias: null };
  const dias = diasAte(dataExpedicao, hoje);
  const grupo = dias < 0 ? 'atrasadas' : dias === 0 ? 'hoje' : dias === 1 ? 'amanha' : 'proximas';
  return { grupo, alerta: pendentes > 0 && dias <= 1, dias };
}

/* ---- Quadro Kanban (snapshot) ---- */

/** Todo item do quadro que dá para escolher: o card (épico ou task avulsa) e
 * cada task dentro dele, com o responsável atual do Jira. */
function itensDoQuadro(snapshot) {
  const saida = new Map();
  if (!snapshot || !Array.isArray(snapshot.colunas)) return saida;
  const pessoas = snapshot.pessoas || {};
  const nomeDe = (id) => (id && pessoas[id] ? pessoas[id].nome : '');
  const guardar = (chave, titulo, pessoa, coluna) => {
    const k = chaveJira(chave);
    if (!k || saida.has(k)) return;
    saida.set(k, { jira: k, nome: titulo || '', responsavel: nomeDe(pessoa), coluna: coluna || '' });
  };
  for (const col of snapshot.colunas) {
    for (const card of col.cards || []) {
      const tarefas = card.tarefas || [];
      const principal = tarefas.find((t) => !t.subtarefa);
      guardar(card.epico || (principal && principal.chave), card.titulo, card.pessoa, col.nome);
      for (const t of tarefas) {
        if (t.subtarefa) continue;
        guardar(t.chave, t.titulo, t.pessoa || card.pessoa, col.nome);
      }
    }
  }
  return saida;
}

/** Lista do autocomplete: o que está no quadro, enriquecido com o que a tela de
 * Demandas já sabe daquela chave (ACS e previsão de expedição), mais as
 * demandas que ainda não estão no quadro. `demandas` vem do banco, em ordem de
 * id; a mais recente de cada chave vence. */
function montarOpcoes(snapshot, demandas) {
  const quadro = itensDoQuadro(snapshot);
  const porJira = new Map();
  const semJira = [];
  for (const d of demandas || []) {
    const k = chaveJira(d.artefatoJira);
    if (!k) { if (d.demandaAcs) semJira.push(d); continue; }
    const atual = porJira.get(k);
    if (!atual || (d.mes || '') >= (atual.mes || '')) porJira.set(k, d);
  }
  const opcoes = [];
  for (const [k, q] of quadro) {
    const d = porJira.get(k);
    opcoes.push({
      jira: k, nome: q.nome || (d && d.nome) || '', acs: (d && d.demandaAcs) || '',
      dataExpedicao: (d && d.previsaoExpedicao) || null, responsavel: q.responsavel, origem: 'quadro'
    });
    porJira.delete(k);
  }
  for (const [k, d] of porJira) {
    opcoes.push({ jira: k, nome: d.nome || '', acs: d.demandaAcs || '', dataExpedicao: d.previsaoExpedicao || null, responsavel: '', origem: 'demandas' });
  }
  for (const d of semJira) {
    opcoes.push({ jira: '', nome: d.nome || '', acs: d.demandaAcs, dataExpedicao: d.previsaoExpedicao || null, responsavel: '', origem: 'demandas' });
  }
  return opcoes;
}

/** Responsável de hoje: o do Jira (vale o que está no quadro agora); se o card
 * já saiu do quadro, o que foi guardado na criação; senão, vazio - e a tela
 * marca "sem responsável". */
function responsavelAtual(expedicao, snapshot) {
  const k = chaveJira(expedicao.artefatoJira);
  if (k) {
    const q = itensDoQuadro(snapshot).get(k);
    if (q && q.responsavel) return { nome: q.responsavel, origem: 'jira' };
  }
  if (expedicao.responsavelGuardado) return { nome: expedicao.responsavelGuardado, origem: 'guardado' };
  return { nome: '', origem: 'nenhum' };
}

/* ---- Banco -> API ---- */

function deLinhaItem(i) {
  return {
    id: i.id, bloco: i.bloco, texto: i.texto, padrao: !!i.padrao, estado: i.estado,
    justificativa: i.justificativa || '', atualizadoPor: i.atualizado_por || '', atualizadoEm: i.atualizado_em || null
  };
}

function deLinhaExpedicao(l, itens) {
  return {
    id: l.id, artefatoJira: l.artefato_jira || '', artefatoUrl: urlJira(l.artefato_jira), nome: l.nome || '', demandaAcs: l.demanda_acs || '',
    dataExpedicao: l.data_expedicao || null, responsavelGuardado: l.responsavel || '',
    atualizadoPor: l.atualizado_por || '', atualizadoEm: l.atualizado_em || null,
    itens: (itens || []).map(deLinhaItem)
  };
}

/** Expedição pronta para a tela: responsável de hoje, progresso e urgência. */
function decorar(expedicao, snapshot, hoje) {
  const prog = progresso(expedicao.itens);
  return {
    ...expedicao,
    responsavel: responsavelAtual(expedicao, snapshot),
    progresso: prog,
    ...classificar(expedicao.dataExpedicao, prog.pendentes, hoje)
  };
}

module.exports = {
  decorar,
  ITENS_PADRAO, BLOCOS, ESTADOS, MIN_JUSTIFICATIVA, chaveJira, normalizarExpedicao, normalizarItemNovo,
  normalizarEstadoItem, progresso, hojeBrasilia, classificar, itensDoQuadro, montarOpcoes,
  responsavelAtual, deLinhaItem, deLinhaExpedicao, idExpedicao: idDemanda
};
