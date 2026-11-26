// Regras puras da tela "Demandas" (solicitações em andamento no ACS do BRB) -
// sem banco, sem rede. Ficam aqui, e não no supabase.js nem no server.js, para
// serem testadas isoladamente.
//
// De onde vem o dado: o ACS só existe dentro da rede do BRB e pede login
// Windows, então o servidor (na nuvem) não consegue chamá-lo. Quem chama é o
// coletor (coletor/coletor-acs.ps1), numa máquina dentro da rede, que manda a
// lista para cá assinada (ver conferirAssinatura).

const crypto = require('crypto');

const FUSO_MS = -3 * 60 * 60 * 1000; // Brasília, sem horário de verão
const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;

const MAX_SOLICITACOES = 2000;
const LIMITE = { sistema: 20, statusCodigo: 4, status: 80, resumo: 500, gestor: 120, coordenacao: 20, erro: 500 };

// A coleta é diária, às 8h. Passou de 1 dia útil (24h, sem contar sábado e
// domingo) sem coleta boa, a tela avisa. A folga de 1h evita alarme falso
// quando a máquina do coletor liga um pouco depois das 8h.
const HORA_COLETA_DIARIA = 8;
const LIMITE_HORAS_UTEIS = 25;
// Coleta diária que falhou: nova tentativa só depois deste intervalo, para o
// coletor (que pergunta a cada poucos minutos) não martelar o ACS o dia todo.
const ESPERA_APOS_FALHA_MS = 30 * 60 * 1000;

// Assinatura do coletor: pedido com mais de 5 minutos de diferença do relógio
// do servidor é recusado (não dá para guardar um pedido e reenviar depois).
const JANELA_ASSINATURA_MS = 5 * 60 * 1000;
const SEGREDO_MINIMO = 32;

function texto(valor, max) {
  if (valor === null || valor === undefined) return '';
  return String(valor).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** "dd/mm/aaaa" (como o ACS manda) -> "aaaa-mm-dd". Vazio vira null, e
 * também "-", que é como o ACS escreve "sem data" (ex.: previsão ainda não
 * definida). Data que não existe (31/02) ou em outro formato devolve undefined. */
function interpretarDataBr(valor) {
  const t = texto(valor, 30);
  if (!t || /^-+$/.test(t)) return null;
  // Algumas rotas mandam a data com a hora ("29/10/2026 00:00:00"): vale o dia.
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?: \d{2}:\d{2}(?::\d{2})?)?$/.exec(t);
  if (!m) return undefined;
  const dia = Number(m[1]);
  const mes = Number(m[2]);
  const ano = Number(m[3]);
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  if (d.getUTCFullYear() !== ano || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return undefined;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** "dd/mm/aaaa hh:mm:ss" (data e hora de Brasília, como o ACS manda nas fases
 * e nas métricas) -> "aaaa-mm-ddThh:mm:ss-03:00". Vazio ou "-" vira null; o
 * resto que não for data e hora válidas devolve undefined. */
function interpretarDataHoraBr(valor) {
  const t = texto(valor, 30);
  if (!t || /^-+$/.test(t)) return null;
  const m = /^(\d{2}\/\d{2}\/\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (!m) return undefined;
  const dia = interpretarDataBr(m[1]);
  if (!dia) return undefined;
  const [h, min, s] = [m[2] || '00', m[3] || '00', m[4] || '00'];
  if (Number(h) > 23 || Number(min) > 59 || Number(s) > 59) return undefined;
  return `${dia}T${h}:${min}:${s}-03:00`;
}

// Nomes do ciclo de vida no ACS (rota /Fases/CicloDeVida). Cada linha do
// histórico de fases é um pedido de APROVAÇÃO daquela fase: "F5 aprovada" quer
// dizer que a construção terminou (e a demanda segue para teste/homologação).
const NOMES_FASE = {
  F1: 'Definição do Sistema',
  F2: 'Especificação de Requisitos',
  F3: 'Modelo Lógico',
  F4: 'Projeto Detalhado',
  F5: 'Construção',
  F6: 'Integração e Homologação',
  F7: 'Implantação'
};
// Situação da fase (DS_SITUACAO_FASE) e da contagem de PF (st_aprovacao).
const SITUACOES = { A: 'aprovada', E: 'aguardando aprovação', R: 'rejeitada' };
const SITUACOES_PF = { A: 'Aprovado', E: 'Aguardando aprovação', R: 'Rejeitado' };
const MAX_FASES = 30;
const MAX_METRICAS = 50;
const MAX_PF = 100000;

/** FASES que o coletor manda junto de cada solicitação (vêm de
 * /Solicitacoes/{n}/fases) -> [{ fase, situacao, inclusao, validacao, rejeicao }],
 * da mais antiga para a mais nova. Inválido devolve null (o detalhe é
 * descartado, a solicitação não). */
function normalizarFases(lista) {
  if (!Array.isArray(lista) || lista.length > MAX_FASES) return null;
  const fases = [];
  for (const f of lista) {
    if (!f || typeof f !== 'object') return null;
    const fase = texto(f.CD_FASE, 4).toUpperCase();
    if (!/^[A-Z0-9]{1,4}$/.test(fase)) return null;
    const item = { fase, situacao: texto(f.DS_SITUACAO_FASE, 2).toUpperCase() };
    for (const [origem, campo] of [['DT_INCLUSAO_FASE', 'inclusao'], ['DT_VALIDACAO_FASE', 'validacao'], ['DT_REJEICAO_FASE', 'rejeicao']]) {
      const d = interpretarDataHoraBr(f[origem]);
      if (d === undefined) return null;
      item[campo] = d;
    }
    fases.push(item);
  }
  // Ordena pela inclusão (sem data por último, mantendo a ordem do ACS).
  return fases.map((f, i) => ({ f, i }))
    .sort((a, b) => ((a.f.inclusao || '￿').localeCompare(b.f.inclusao || '￿')) || a.i - b.i)
    .map((x) => x.f);
}

/** METRICAS (de /Metricas/todos?sq_solicitacao=n): cada contagem de PF com a
 * situação da aprovação. Quem aprovou (nome) não é guardado. Repetidas (o ACS
 * devolve a mesma contagem várias vezes) viram uma só. */
function normalizarMetricas(lista) {
  if (!Array.isArray(lista) || lista.length > MAX_METRICAS * 4) return null;
  const vistas = new Set();
  const metricas = [];
  for (const m of lista) {
    if (!m || typeof m !== 'object') return null;
    const pf = Number(m.contagem);
    if (!Number.isFinite(pf) || pf < 0 || pf > MAX_PF) return null;
    const data = interpretarDataHoraBr(m.data_aprovacao);
    if (data === undefined) return null;
    const item = {
      pf: Math.round(pf * 100) / 100,
      tipo: texto(m.tipo_contagem, 4).toUpperCase(),
      situacao: texto(m.st_aprovacao, 2).toUpperCase(),
      data,
      documento: texto(m.nome_documento, 150)
    };
    const chave = JSON.stringify(item);
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    metricas.push(item);
  }
  return metricas.slice(0, MAX_METRICAS);
}

/** A fase em que a demanda está: a última do histórico (a mesma que o ACS
 * devolve em /Solicitacoes/{n}/UltimaFase). */
function faseAtual(fases) {
  if (!Array.isArray(fases) || !fases.length) return null;
  const f = fases[fases.length - 1];
  return {
    codigo: f.fase,
    nome: NOMES_FASE[f.fase] || '',
    situacao: f.situacao,
    situacaoTexto: SITUACOES[f.situacao] || '',
    desde: f.inclusao || null,
    validada: f.validacao || null
  };
}

/** O PF que vale para a demanda: a contagem decidida (aprovada ou rejeitada)
 * mais recente; sem nenhuma decidida, a que aguarda aprovação. Se, além da
 * decidida, há uma nova aguardando com outro valor, ela vem em `novaContagem`. */
function pfAtual(metricas) {
  if (!Array.isArray(metricas) || !metricas.length) return null;
  const decididas = metricas.filter((m) => m.data && (m.situacao === 'A' || m.situacao === 'R'))
    .sort((a, b) => b.data.localeCompare(a.data));
  const aguardando = metricas.filter((m) => m.situacao === 'E');
  const escolhida = decididas[0] || aguardando[aguardando.length - 1] || metricas[metricas.length - 1];
  const nova = decididas[0] ? aguardando.find((m) => m.pf !== escolhida.pf) : null;
  return {
    valor: escolhida.pf,
    situacao: escolhida.situacao,
    situacaoTexto: SITUACOES_PF[escolhida.situacao] || '',
    data: escolhida.data || null,
    novaContagem: nova ? nova.pf : null
  };
}

const CAMPOS_DATA = {
  DT_SOLICITACAO: 'data_solicitacao',
  DT_PREVISAO_INICIO: 'previsao_inicio',
  DT_PREVISAO_TERMINO: 'previsao_termino',
  DT_IMPLANTACAO: 'data_implantacao'
};

/** Uma solicitação do ACS -> linha da tabela acs_solicitacoes.
 * A matrícula do gestor (NR_GESTOR_NEGOCIO) não entra: a tela não usa. */
function normalizarSolicitacao(bruta) {
  if (!bruta || typeof bruta !== 'object' || Array.isArray(bruta)) return { ok: false, erro: 'não é um objeto' };
  const numero = Number(bruta.SQ_SOLICITACAO);
  if (!Number.isSafeInteger(numero) || numero <= 0) return { ok: false, erro: 'SQ_SOLICITACAO inválido' };
  const statusCodigo = texto(bruta.ST_SOLICITACAO, LIMITE.statusCodigo);
  const status = texto(bruta.DS_STATUS_SOLICITACAO, LIMITE.status);
  if (!statusCodigo || !status) return { ok: false, erro: `solicitação ${numero} sem status` };
  const linha = {
    numero,
    sistema: texto(bruta.SISSIGLA, LIMITE.sistema),
    status_codigo: statusCodigo,
    status,
    resumo: texto(bruta.DS_RESUMO, LIMITE.resumo),
    gestor: texto(bruta.NO_GESTOR_NEGOCIO, LIMITE.gestor)
  };
  for (const [origem, coluna] of Object.entries(CAMPOS_DATA)) {
    const data = interpretarDataBr(bruta[origem]);
    if (data === undefined) return { ok: false, erro: `solicitação ${numero}: ${origem} não é uma data dd/mm/aaaa` };
    linha[coluna] = data;
  }
  // Detalhe (fases, PF e coordenação): o coletor só manda quando conseguiu
  // buscar. Sem ele, ou com ele torto, a solicitação entra assim mesmo e o
  // banco mantém o detalhe da coleta anterior (ver gravarCargaAcs).
  if ('FASES' in bruta || 'METRICAS' in bruta) {
    const fases = normalizarFases(bruta.FASES);
    const metricas = normalizarMetricas(bruta.METRICAS);
    if (fases && metricas) {
      linha.fases = fases;
      linha.metricas = metricas;
      linha.coordenacao = texto(bruta.COORDENACAO, LIMITE.coordenacao);
    }
  }
  return { ok: true, linha };
}

/** Corpo que o coletor manda: { solicitacoes: [...] }.
 *
 * Tudo ou nada, de propósito: quem some da lista é marcado como "saiu de em
 * andamento", então aceitar uma lista pela metade (ou vazia, por um erro do
 * ACS) apagaria da tela demanda que continua aberta. */
function normalizarCarga(corpo) {
  const lista = corpo && corpo.solicitacoes;
  if (!Array.isArray(lista)) return { ok: false, erro: 'Faltou a lista de solicitações.' };
  if (!lista.length) return { ok: false, erro: 'O ACS devolveu uma lista vazia; a carga foi recusada para não apagar a tela.' };
  if (lista.length > MAX_SOLICITACOES) return { ok: false, erro: `Lista grande demais (${lista.length}; o máximo é ${MAX_SOLICITACOES}).` };
  const porNumero = new Map();
  for (let i = 0; i < lista.length; i++) {
    const n = normalizarSolicitacao(lista[i]);
    if (!n.ok) return { ok: false, erro: `Item ${i + 1} da lista: ${n.erro}.` };
    porNumero.set(n.linha.numero, n.linha); // número repetido: vale o último
  }
  return { ok: true, linhas: [...porNumero.values()] };
}

// ---- extras da carga: base da tela "Produção PF" ----
// Vêm junto da lista principal, mas são opcionais e independentes: um extra
// torto é descartado (com aviso no log) sem recusar a carga.

const MAX_IMPLANTADAS = 500;
const MAX_SUSTENTACOES = 5000;
const MAX_INDICADORES = 500;

/** Demandas já implantadas (rota /Solicitacoes/sistemas/{sigla}), com fases e
 * PF: o histórico dos meses anteriores. Itens tortos ficam de fora. */
function normalizarImplantadas(lista) {
  if (!Array.isArray(lista)) return { linhas: [], descartadas: 0 };
  const linhas = [];
  let descartadas = 0;
  for (const bruta of lista.slice(0, MAX_IMPLANTADAS)) {
    const n = normalizarSolicitacao(bruta);
    if (n.ok) linhas.push(n.linha); else descartadas++;
  }
  return { linhas, descartadas: descartadas + Math.max(0, lista.length - MAX_IMPLANTADAS) };
}

/** Chamados de sustentação (rota /Sustentacoes/{sigla}/{inicio}/{fim}). Só o
 * que a conta de PF precisa: descrição, solução e nomes NÃO entram. */
function normalizarSustentacoes(lista) {
  if (!Array.isArray(lista)) return { linhas: [], descartadas: 0 };
  const porNumero = new Map();
  let descartadas = 0;
  for (const c of lista.slice(0, MAX_SUSTENTACOES)) {
    const numero = Number(c && c.SQ_SUSTENTACAO);
    const abertura = interpretarDataHoraBr(c && c.DT_ABERTURA);
    const finalizacao = interpretarDataHoraBr(c && c.DT_FINALIZACAO);
    const quantidade = c && c.NR_QUANTIDADE !== null && c.NR_QUANTIDADE !== undefined ? Number(c.NR_QUANTIDADE) : null;
    const indicador = c && c.SQ_SUSTENTACAO_INDICADOR !== null && c.SQ_SUSTENTACAO_INDICADOR !== undefined ? Number(c.SQ_SUSTENTACAO_INDICADOR) : null;
    if (!Number.isSafeInteger(numero) || numero <= 0 || abertura === undefined || finalizacao === undefined ||
      (quantidade !== null && (!Number.isFinite(quantidade) || quantidade < 0 || quantidade > 1000)) ||
      (indicador !== null && !Number.isSafeInteger(indicador))) {
      descartadas++;
      continue;
    }
    porNumero.set(numero, {
      numero,
      sistema: texto(c.NO_SISTEMA, LIMITE.sistema),
      situacao: Number.isFinite(Number(c.TP_SITUACAO)) ? Number(c.TP_SITUACAO) : null,
      abertura,
      finalizacao,
      quantidade,
      indicador,
      contrato: Number.isSafeInteger(Number(c.SQ_CONTRATO)) ? Number(c.SQ_CONTRATO) : null
    });
  }
  return { linhas: [...porNumero.values()], descartadas: descartadas + Math.max(0, lista.length - MAX_SUSTENTACOES) };
}

/** Contrato (rota /Faturamentos/contratos/codigo/{cd}) e os indicadores de
 * sustentação dele (/SustentacaoIndicador): quanto cada fase paga do PF da
 * demanda e quanto vale cada tipo de chamado. Torto devolve null. */
function normalizarContrato(c) {
  if (!c || typeof c !== 'object') return null;
  const sq = Number(c.SQ_CONTRATO);
  const codigo = texto(c.CD_CONTRATO, 20);
  if (!Number.isSafeInteger(sq) || !codigo) return null;
  const pesos = {};
  for (let i = 1; i <= 7; i++) {
    const p = Number(c[`VL_F${i}`]);
    if (!Number.isFinite(p) || p < 0 || p > 1) return null;
    pesos[`F${i}`] = p;
  }
  const indicadores = [];
  for (const i of Array.isArray(c.INDICADORES) ? c.INDICADORES.slice(0, MAX_INDICADORES) : []) {
    const id = Number(i && i.SQ_SUSTENTACAO_INDICADOR);
    const pf = Number(i && i.NR_PF);
    if (!Number.isSafeInteger(id) || !Number.isFinite(pf) || pf < 0 || pf > 1000) continue;
    indicadores.push({ id, pf, atividade: texto(i.DS_ATIVIDADE, 200) });
  }
  return { sq, codigo, nome: texto(c.NO_CONTRATO, 120), pesos, indicadores };
}

/** Os extras do corpo da carga, já limpos. */
function normalizarExtras(corpo) {
  const c = corpo || {};
  return {
    implantadas: 'implantadas' in c ? normalizarImplantadas(c.implantadas) : null,
    sustentacoes: 'sustentacoes' in c ? normalizarSustentacoes(c.sustentacoes) : null,
    contrato: 'contrato' in c ? normalizarContrato(c.contrato) : null
  };
}

/** Motivo da falha informado pelo coletor ({ erro: "..." }), limpo e curto. */
function normalizarErroColetor(corpo) {
  if (!corpo || typeof corpo.erro !== 'string') return null;
  return texto(corpo.erro, LIMITE.erro) || 'Falha sem descrição.';
}

/** Linha do banco -> formato da API. */
function deLinhaAcs(l) {
  return {
    numero: l.numero,
    sistema: l.sistema || '',
    statusCodigo: l.status_codigo || '',
    status: l.status || '',
    resumo: l.resumo || '',
    gestor: l.gestor || '',
    dataSolicitacao: l.data_solicitacao || null,
    previsaoInicio: l.previsao_inicio || null,
    previsaoTermino: l.previsao_termino || null,
    dataImplantacao: l.data_implantacao || null,
    statusDesde: l.status_desde || null,
    // Na primeira vez que vemos a solicitação não sabemos desde quando ela
    // está naquele status: "desde" é só o dia em que começamos a olhar.
    statusDesdeAproximado: !!l.status_desde && l.status_desde === l.primeira_coleta,
    coordenacao: l.coordenacao || '',
    fase: faseAtual(l.fases),
    fases: Array.isArray(l.fases) ? l.fases.map((f) => ({ ...f, nome: NOMES_FASE[f.fase] || '' })) : [],
    pf: pfAtual(l.metricas),
    metricas: Array.isArray(l.metricas) ? l.metricas : [],
    // null = o coletor ainda não trouxe fases/PF desta demanda
    detalheEm: l.detalhe_em || null
  };
}

// ---- tempo: dia útil em Brasília ----

/** Partes da data/hora em Brasília de um instante. */
function emBrasilia(instante) {
  const d = new Date(new Date(instante).getTime() + FUSO_MS);
  return {
    dia: d.toISOString().slice(0, 10),
    hora: d.getUTCHours(),
    diaSemana: d.getUTCDay() // 0 = domingo, 6 = sábado
  };
}

const ehDiaUtil = (diaSemana) => diaSemana !== 0 && diaSemana !== 6;

/** Horas entre dois instantes sem contar sábado nem domingo (Brasília).
 * Feriado conta como dia útil - não há calendário de feriados aqui. */
function horasUteisEntre(inicio, fim) {
  let a = new Date(inicio).getTime() + FUSO_MS;
  const b = new Date(fim).getTime() + FUSO_MS;
  if (!(b > a)) return 0;
  // Teto para o laço não girar anos quando a última coleta é muito antiga.
  if (b - a > 400 * DIA_MS) return 400 * 24;
  let total = 0;
  while (a < b) {
    const fimDoDia = Math.floor(a / DIA_MS) * DIA_MS + DIA_MS;
    const ate = Math.min(fimDoDia, b);
    if (ehDiaUtil(new Date(a).getUTCDay())) total += ate - a;
    a = ate;
  }
  return total / HORA_MS;
}

/** Como está a coleta, para o aviso da tela.
 *   'nunca'    - ainda não houve coleta boa;
 *   'atrasada' - passou de 1 dia útil sem coleta boa;
 *   'em-dia'   - o resto. */
function situacaoColeta(ultimaOk, agora) {
  if (!ultimaOk) return { estado: 'nunca', horasUteis: null };
  const horasUteis = Math.round(horasUteisEntre(ultimaOk, agora) * 10) / 10;
  return { estado: horasUteis > LIMITE_HORAS_UTEIS ? 'atrasada' : 'em-dia', horasUteis };
}

/** O coletor pergunta "tenho que coletar agora?"; a regra mora aqui, no
 * servidor, para mudar sem mexer na máquina do coletor.
 *
 *   - alguém pediu pelo botão Atualizar -> sim;
 *   - dia útil, já passou das 8h e ainda não houve coleta boa hoje -> sim
 *     (se a máquina ligar às 9h30, coleta às 9h30), respeitando a espera
 *     depois de uma falha. */
function deveColetar({ agora, ultimaOk, ultimaFalha, pedidoPendente }) {
  if (pedidoPendente) return { coletar: true, motivo: 'pedido' };
  const hoje = emBrasilia(agora);
  if (!ehDiaUtil(hoje.diaSemana)) return { coletar: false, motivo: 'fim-de-semana' };
  if (hoje.hora < HORA_COLETA_DIARIA) return { coletar: false, motivo: 'antes-da-hora' };
  if (ultimaOk && emBrasilia(ultimaOk).dia === hoje.dia) return { coletar: false, motivo: 'ja-coletou-hoje' };
  if (ultimaFalha && new Date(agora).getTime() - new Date(ultimaFalha).getTime() < ESPERA_APOS_FALHA_MS) {
    return { coletar: false, motivo: 'aguardando-nova-tentativa' };
  }
  return { coletar: true, motivo: 'diaria' };
}

// ---- assinatura dos pedidos do coletor ----

/** HMAC-SHA256 de "timestamp\nMÉTODO\ncaminho\n" + corpo, em hexadecimal.
 *
 * Assinar (em vez de mandar o segredo num cabeçalho) faz o segredo nunca
 * trafegar: o proxy do banco inspeciona o HTTPS e veria um token fixo. Com a
 * assinatura ele só vê um valor que vale para aquele corpo, por 5 minutos. */
function assinar(segredo, { timestamp, metodo, caminho, corpo }) {
  const h = crypto.createHmac('sha256', String(segredo));
  h.update(`${timestamp}\n${String(metodo).toUpperCase()}\n${caminho}\n`, 'utf8');
  if (corpo && corpo.length) h.update(corpo);
  return h.digest('hex');
}

/** Falha fechada: sem segredo configurado (ou curto demais), ninguém passa. */
function conferirAssinatura({ segredo, timestamp, assinatura, metodo, caminho, corpo, agora }) {
  if (typeof segredo !== 'string' || segredo.length < SEGREDO_MINIMO) return false;
  if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp)) return false;
  if (typeof assinatura !== 'string' || !/^[0-9a-f]{64}$/i.test(assinatura)) return false;
  if (Math.abs(new Date(agora).getTime() - Number(timestamp) * 1000) > JANELA_ASSINATURA_MS) return false;
  const esperada = Buffer.from(assinar(segredo, { timestamp, metodo, caminho, corpo }), 'hex');
  const recebida = Buffer.from(assinatura, 'hex');
  return esperada.length === recebida.length && crypto.timingSafeEqual(esperada, recebida);
}

module.exports = {
  MAX_SOLICITACOES, LIMITE_HORAS_UTEIS, HORA_COLETA_DIARIA, ESPERA_APOS_FALHA_MS, JANELA_ASSINATURA_MS, SEGREDO_MINIMO,
  NOMES_FASE,
  interpretarDataBr, interpretarDataHoraBr, normalizarFases, normalizarMetricas, faseAtual, pfAtual,
  normalizarSolicitacao, normalizarCarga, normalizarErroColetor, deLinhaAcs,
  normalizarImplantadas, normalizarSustentacoes, normalizarContrato, normalizarExtras,
  emBrasilia, horasUteisEntre, situacaoColeta, deveColetar,
  assinar, conferirAssinatura
};
