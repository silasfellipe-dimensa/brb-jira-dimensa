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
const LIMITE = { sistema: 20, statusCodigo: 4, status: 80, resumo: 500, gestor: 120, erro: 500 };

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
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if (!m) return undefined;
  const dia = Number(m[1]);
  const mes = Number(m[2]);
  const ano = Number(m[3]);
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  if (d.getUTCFullYear() !== ano || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return undefined;
  return `${m[3]}-${m[2]}-${m[1]}`;
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
    statusDesdeAproximado: !!l.status_desde && l.status_desde === l.primeira_coleta
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
  interpretarDataBr, normalizarSolicitacao, normalizarCarga, normalizarErroColetor, deLinhaAcs,
  emBrasilia, horasUteisEntre, situacaoColeta, deveColetar,
  assinar, conferirAssinatura
};
