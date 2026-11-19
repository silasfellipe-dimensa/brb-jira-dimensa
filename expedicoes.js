// Regras puras da tela "Expedições" (checklist do time) - sem banco, sem rede.
// Ficam aqui, e não no supabase.js, para serem testadas isoladamente.

const { interpretarData, interpretarNumero, idDemanda, urlJira } = require('./demandas');
const { TEXTOS_JIRA, TEXTOS_ASSISTIDOS, CAMPO_DO_ITEM, GRAVAVEIS_DO_ITEM } = require('./checklistJira');

const LIMITE = { jira: 40, nome: 300, acs: 40, item: 200, justificativa: 500, observacao: 1000 };
const MIN_JUSTIFICATIVA = 10;
const BLOCOS = ['comitar', 'expedir'];
const ESTADOS = ['pendente', 'concluido', 'nao_aplicavel'];
const FUSO = 'America/Sao_Paulo';

/** Itens que toda expedição ganha ao ser criada: a união das duas listas do
 * time (checklist rápido + pré-expedição), sem repetir. Descrição, Documentos de
 * Configuração e Solução são itens do "antes de comitar" (não campos de texto);
 * "Solução" saiu do "antes de expedir" para não ficar duplicada. São COPIADOS para cada
 * expedição: mudar a lista aqui vale só para as novas, as antigas ficam como
 * foram conferidas. */
const ITENS_PADRAO = [
  { bloco: 'comitar', texto: 'A issue tem a versão correta para a data de entrega?' },
  { bloco: 'comitar', texto: 'O componente corresponde ao módulo da versão?' },
  { bloco: 'comitar', texto: 'Há pelo menos 1 issue por módulo alterado?' },
  { bloco: 'comitar', texto: 'Se houver banco, subtarefa GCAD com os requisitos ok?' },
  { bloco: 'comitar', texto: 'Data interna acordada registrada? (boa prática)' },
  { bloco: 'comitar', texto: 'Branch: VERSÃO FIX → master | VERSÃO RELEASE → Developer?' },
  { bloco: 'comitar', texto: 'Descrição preenchida?' },
  { bloco: 'comitar', texto: 'Documentos de Configuração preenchidos?' },
  { bloco: 'comitar', texto: 'Solução preenchida?' },
  { bloco: 'expedir', texto: 'Status: Teste de aceitação concluído' },
  { bloco: 'expedir', texto: 'Todas as subtarefas concluídas' },
  { bloco: 'expedir', texto: 'Apontamentos de horas realizados' },
  { bloco: 'expedir', texto: 'Requisito preenchido, em linguagem de usuário' },
  { bloco: 'expedir', texto: 'Demais Documentações preenchidas' },
  { bloco: 'expedir', texto: 'Solução com mais de 60 caracteres, objetivo e sem detalhes técnicos' },
  { bloco: 'expedir', texto: 'A versão ficou verde no painel até 14h?' }
];

/* Mudanças combinadas com o time em 2026-10-21. Os itens já estão gravados em
 * cada expedição com o texto antigo; em vez de reescrever o banco, a leitura
 * troca o nome (o histórico de quem marcou continua o mesmo) e esconde o item
 * que saiu ("Release Note em linguagem de usuário" virou o Requisito). */
const ITENS_RENOMEADOS = {
  'Situação / Requisito preenchido': 'Requisito preenchido, em linguagem de usuário',
  'Release Note com mais de 60 caracteres, objetivo e sem detalhes técnicos': 'Solução com mais de 60 caracteres, objetivo e sem detalhes técnicos'
};
const ITENS_RETIRADOS = ['Release Note em linguagem de usuário'];

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
  // PF da expedição (opcional; vazio apaga)
  if (tem(corpo, 'pontosFuncao')) {
    const n = interpretarNumero(corpo.pontosFuncao);
    if (!n.ok) return { ok: false, erro: `PF: ${n.erro}` };
    registro.pontos_funcao = n.valor;
  }
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

/** Observação do item: texto livre e opcional, em qualquer estado. Vazio apaga
 * (guarda null). Não tem relação com o motivo do N/A, que é obrigatório. */
function normalizarObservacao(corpo) {
  if (!corpo || typeof corpo !== 'object' || !tem(corpo, 'observacao')) return { ok: false, erro: 'Corpo inválido.' };
  if (corpo.observacao !== null && typeof corpo.observacao !== 'string') return { ok: false, erro: 'Observação inválida.' };
  const t = texto(corpo.observacao);
  if (t.length > LIMITE.observacao) return { ok: false, erro: `Observação longa demais (máximo ${LIMITE.observacao} caracteres).` };
  return { ok: true, observacao: t === '' ? null : t };
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

/** PF de Demandas para pré-preencher: só o número (demanda "em análise" ou sem total não tem PF). */
function pfDe(d) {
  return d && !d.emAnalise && typeof d.pontosTotal === 'number' ? d.pontosTotal : null;
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
      dataExpedicao: (d && d.previsaoExpedicao) || null, pf: pfDe(d), responsavel: q.responsavel, origem: 'quadro'
    });
    porJira.delete(k);
  }
  for (const [k, d] of porJira) {
    opcoes.push({ jira: k, nome: d.nome || '', acs: d.demandaAcs || '', dataExpedicao: d.previsaoExpedicao || null, pf: pfDe(d), responsavel: '', origem: 'demandas' });
  }
  for (const d of semJira) {
    opcoes.push({ jira: '', nome: d.nome || '', acs: d.demandaAcs, dataExpedicao: d.previsaoExpedicao || null, pf: pfDe(d), responsavel: '', origem: 'demandas' });
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

/* ---- Sincronia da data de expedição com a tela de Demandas ----
 * A data de expedição existe nas duas telas (Demandas: "Previsão de Expedição",
 * uma por linha/mês; Expedições: uma por expedição). Mudou numa, muda na outra.
 *
 * Regras (decididas com o usuário; cada uma evita um estrago real):
 * - A ligação é pela chave do Jira; sem Jira dos dois lados, pelo número ACS.
 * - Em Demandas só vale a linha do MÊS MAIS RECENTE da demanda: mexer em mês
 *   fechado reescreveria o histórico de cobrança. Editar um mês antigo não
 *   propaga nada.
 * - Apagar a data nunca propaga (um apagão acidental não limpa a outra tela).
 * - Com mais de uma expedição ativa para a mesma demanda não há "a" data certa:
 *   não sincroniza e avisa.
 * - A sincronia nunca derruba a gravação principal: quem chama trata falha. */
const NOMES_MES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto',
  'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
function rotuloMes(mes) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(mes || ''));
  return m && NOMES_MES[Number(m[2]) - 1] ? `${NOMES_MES[Number(m[2]) - 1]} de ${m[1]}` : '';
}

const acsDe = (x) => texto(x && x.demandaAcs);
const temChave = (x) => !!(chaveJira(x && x.artefatoJira) || acsDe(x));

/** Mesma demanda? Jira dos dois lados decide; senão, o ACS (nunca vazio). */
function mesmaDemanda(a, b) {
  const ka = chaveJira(a.artefatoJira);
  const kb = chaveJira(b.artefatoJira);
  if (ka && kb) return ka === kb;
  const aa = acsDe(a);
  return !!aa && aa === acsDe(b);
}

/** Linha de Demandas do mês mais recente (desempate pelo id) para essa demanda. */
function linhaMaisRecente(demandas, ref) {
  let melhor = null;
  for (const d of demandas) {
    if (!mesmaDemanda(d, ref)) continue;
    const dm = d.mes || '';
    const bm = melhor ? (melhor.mes || '') : '';
    if (!melhor || dm > bm || (dm === bm && d.id > melhor.id)) melhor = d;
  }
  return melhor;
}

/** Expedição gravada com data -> o que fazer em Demandas.
 * `expedicoesAtivas` já inclui a própria expedição (gravada). */
function planoParaDemandas(expedicao, expedicoesAtivas, demandas) {
  if (!expedicao.dataExpedicao) return { acao: 'nenhuma', motivo: 'sem-data' };
  if (!temChave(expedicao)) return { acao: 'nenhuma', motivo: 'sem-chave' };
  const mesmas = expedicoesAtivas.filter((e) => e.id === expedicao.id || mesmaDemanda(e, expedicao));
  if (mesmas.length > 1) return { acao: 'avisar', motivo: 'varias-expedicoes' };
  const alvo = linhaMaisRecente(demandas, expedicao);
  if (!alvo) return { acao: 'avisar', motivo: 'sem-demanda' };
  if (alvo.previsaoExpedicao === expedicao.dataExpedicao) return { acao: 'nenhuma', motivo: 'igual', mes: alvo.mes };
  return { acao: 'atualizar', demandaId: alvo.id, mes: alvo.mes, data: expedicao.dataExpedicao };
}

/** Demanda gravada com previsão -> o que fazer em Expedições. */
function planoParaExpedicao(demanda, demandas, expedicoesAtivas) {
  if (!demanda.previsaoExpedicao) return { acao: 'nenhuma', motivo: 'sem-data' };
  if (!temChave(demanda)) return { acao: 'nenhuma', motivo: 'sem-chave' };
  const recente = linhaMaisRecente(demandas, demanda);
  if (!recente || recente.id !== demanda.id) return { acao: 'nenhuma', motivo: 'mes-anterior' };
  const exps = expedicoesAtivas.filter((e) => mesmaDemanda(e, demanda));
  if (!exps.length) return { acao: 'nenhuma', motivo: 'sem-expedicao' };
  if (exps.length > 1) return { acao: 'avisar', motivo: 'varias-expedicoes' };
  if (exps[0].dataExpedicao === demanda.previsaoExpedicao) return { acao: 'nenhuma', motivo: 'igual' };
  return { acao: 'atualizar', expedicaoId: exps[0].id, data: demanda.previsaoExpedicao };
}

/** Recado para a tela de quem mexeu. `destino` é onde a data foi (ou não) parar;
 * `gravou` diz se a segunda gravação deu certo. Sem recado = null. */
function recadoSincronia(destino, plano, gravou) {
  const onde = destino === 'demandas' ? 'Demandas' : 'Expedições';
  if (plano.acao === 'atualizar') {
    if (!gravou) return { destino, status: 'erro', texto: `A data foi salva aqui, mas não consegui atualizá-la em ${onde}.` };
    const mes = destino === 'demandas' && plano.mes ? ` (${rotuloMes(plano.mes)})` : '';
    return { destino, status: 'atualizada', texto: `Data de expedição atualizada também em ${onde}${mes}.` };
  }
  if (plano.acao === 'avisar') {
    if (plano.motivo === 'varias-expedicoes') {
      return { destino, status: 'aviso', texto: `Há mais de uma expedição ativa para esta demanda; a data não foi enviada para ${onde}.` };
    }
    if (plano.motivo === 'sem-demanda') {
      return { destino, status: 'aviso', texto: 'Não encontrei esta demanda em Demandas (confira o Jira ou o ACS); a data ficou só aqui.' };
    }
  }
  return null;
}

/* ---- Banco -> API ---- */

function deLinhaItem(i) {
  const texto = i.padrao && ITENS_RENOMEADOS[i.texto] ? ITENS_RENOMEADOS[i.texto] : i.texto;
  return {
    id: i.id, bloco: i.bloco, texto, padrao: !!i.padrao, estado: i.estado,
    justificativa: i.justificativa || '', atualizadoPor: i.atualizado_por || '', atualizadoEm: i.atualizado_em || null,
    observacao: i.observacao || '', observacaoPor: i.observacao_por || '', observacaoEm: i.observacao_em || null
  };
}

function deLinhaExpedicao(l, itens) {
  return {
    id: l.id, artefatoJira: l.artefato_jira || '', artefatoUrl: urlJira(l.artefato_jira), nome: l.nome || '', demandaAcs: l.demanda_acs || '',
    dataExpedicao: l.data_expedicao || null, responsavelGuardado: l.responsavel || '',
    pontosFuncao: l.pontos_funcao === null || l.pontos_funcao === undefined ? null : Number(l.pontos_funcao),
    atualizadoPor: l.atualizado_por || '', atualizadoEm: l.atualizado_em || null,
    itens: (itens || []).filter((i) => !(i.padrao && ITENS_RETIRADOS.includes(i.texto))).map(deLinhaItem)
  };
}

/** Itens que o Jira responde (ver checklistJira.js). `verificacao` é o que o
 * Jira disse sobre a chave da expedição (ou null se ela não tem chave).
 * - cumpre no Jira: o item fica marcado e TRAVADO (ninguém desmarca);
 * - não cumpre: o item fica PENDENTE e não aceita marcação à mão (combinado em
 *   2026-10-21: senão o checklist ficava "completo" com o Jira dizendo o
 *   contrário). Sobra o "Não aplicável" com motivo, para o caso que não se aplica;
 * - assistido (Solução com mais de 60 caracteres): cumprindo, quem marca é o
 *   time, depois de ler o texto; não cumprindo, igual ao anterior;
 * - chave que o Jira não achou, épico sem tasks ou Jira fora do ar: tudo manual. */
function aplicarVerificacao(itens, verificacao) {
  if (!verificacao || verificacao.status === 'nao-encontrada' || verificacao.status === 'indisponivel') return itens;
  const conferido = verificacao.status === 'ok';
  return itens.map((i) => {
    if (i.removido || !i.padrao || !TEXTOS_JIRA.includes(i.texto)) return i;
    const r = verificacao.itens && verificacao.itens[i.texto];
    const ok = !!(r && r.ok);
    const jira = { ok, motivo: r ? r.motivo : 'o épico não tem tasks no Jira', detalhe: (r && r.detalhe) || '' };
    const assistido = TEXTOS_ASSISTIDOS.includes(i.texto);
    if (!conferido) return { ...i, automatico: true, bloqueado: false, soJira: false, jira };
    if (ok && assistido) return { ...i, automatico: true, assistido: true, bloqueado: false, soJira: false, jira };
    if (ok) return { ...i, estado: 'concluido', automatico: true, bloqueado: true, soJira: false, jira };
    return { ...i, estado: i.estado === 'nao_aplicavel' ? 'nao_aplicavel' : 'pendente', automatico: true, assistido, bloqueado: false, soJira: true, jira };
  });
}

/** Por que o Jira não deixa gravar esta mudança no item ('' = pode). */
function recusaPeloJira(item, verificacao, novoEstado) {
  if (!item || !item.padrao || !TEXTOS_JIRA.includes(item.texto)) return '';
  if (!verificacao || verificacao.status !== 'ok') return '';
  const r = verificacao.itens && verificacao.itens[item.texto];
  const ok = !!(r && r.ok);
  if (ok && !TEXTOS_ASSISTIDOS.includes(item.texto)) return 'Este item já está confirmado no Jira e não pode ser alterado aqui.';
  if (!ok && novoEstado === 'concluido') {
    return `Este item é conferido pelo Jira e ainda não cumpre lá (${(r && r.motivo) || 'sem informação'}). Ajuste no Jira e clique em Atualizar, ou marque "Não aplicável" com o motivo.`;
  }
  return '';
}

/** Dica de cada item padrão: qual campo do Jira ele representa. Vai sempre,
 * mesmo sem chave ou com o Jira fora do ar - é para o time saber onde olhar.
 * Item padrão que o Jira não confere (Branch, GCAD, horas...) leva campoJira ''.
 * camposGravaveis: os campos que o botão "Editar" grava no Jira (vazio = sem botão). */
function comCampoJira(itens) {
  return itens.map((i) => (i.padrao
    ? { ...i, campoJira: CAMPO_DO_ITEM[i.texto] || '', camposGravaveis: GRAVAVEIS_DO_ITEM[i.texto] || [] }
    : i));
}

/** Expedição pronta para a tela: responsável de hoje, progresso e urgência. */
function decorar(expedicao, snapshot, hoje, verificacao) {
  const itens = comCampoJira(aplicarVerificacao(expedicao.itens, verificacao || null));
  const prog = progresso(itens);
  return {
    ...expedicao,
    itens,
    jira: verificacao
      ? {
        status: verificacao.status, tipo: verificacao.tipo || '', filhos: verificacao.filhos || 0, lidoEm: verificacao.lidoEm || null,
        desatualizado: !!verificacao.desatualizado, subtarefasAbertas: verificacao.subtarefasAbertas || 0,
        // selo do cartão: o status da issue para o teste de aceitação
        statusTeste: verificacao.statusTeste || null
      }
      : { status: 'sem-chave' },
    responsavel: responsavelAtual(expedicao, snapshot),
    progresso: prog,
    observacoes: itens.filter((i) => !i.removido && i.observacao).length,
    ...classificar(expedicao.dataExpedicao, prog.pendentes, hoje)
  };
}

/** Motivo da exclusão (pedido de 2026-11-19). Expedição em branco (sem Jira,
 * nome e ACS) sai sem motivo: é rascunho. As outras precisam de pelo menos
 * MIN_MOTIVO_EXCLUSAO caracteres ("Duplicada" já passa; "Outro" pede texto,
 * isso a tela cuida). */
const MIN_MOTIVO_EXCLUSAO = 5;
const MAX_MOTIVO_EXCLUSAO = 500;
const expedicaoEmBranco = (e) => !String(e.artefatoJira || '').trim() && !String(e.nome || '').trim() && !String(e.demandaAcs || '').trim();
function normalizarMotivoExclusao(expedicao, motivo) {
  const m = String(motivo === null || motivo === undefined ? '' : motivo).replace(/\s+/g, ' ').trim();
  if (expedicaoEmBranco(expedicao)) return { ok: true, motivo: m.slice(0, MAX_MOTIVO_EXCLUSAO) };
  if (m.length < MIN_MOTIVO_EXCLUSAO) return { ok: false, erro: 'Explique por que está excluindo esta expedição.' };
  if (m.length > MAX_MOTIVO_EXCLUSAO) return { ok: false, erro: `O motivo passa de ${MAX_MOTIVO_EXCLUSAO} caracteres.` };
  return { ok: true, motivo: m };
}

module.exports = {
  expedicaoEmBranco, normalizarMotivoExclusao, MIN_MOTIVO_EXCLUSAO, MAX_MOTIVO_EXCLUSAO,
  decorar, aplicarVerificacao, recusaPeloJira, mesmaDemanda, linhaMaisRecente, planoParaDemandas, planoParaExpedicao, recadoSincronia, rotuloMes,
  ITENS_PADRAO, ITENS_RENOMEADOS, ITENS_RETIRADOS, BLOCOS, ESTADOS, MIN_JUSTIFICATIVA, normalizarObservacao, chaveJira, normalizarExpedicao, normalizarItemNovo,
  normalizarEstadoItem, progresso, hojeBrasilia, classificar, itensDoQuadro, montarOpcoes,
  responsavelAtual, deLinhaItem, deLinhaExpedicao, idExpedicao: idDemanda
};
