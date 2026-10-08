// Regras puras da tela "Demandas e Pontos de Função" - sem banco, sem rede.
// Ficam aqui, e não no supabase.js, para serem testadas isoladamente.

const { SITE } = require('./jira');

const LIMITE_TEXTO = { demandaAcs: 40, artefatoJira: 300, nome: 300, observacoes: 2000 };
const MAX_PONTOS = 99999.99;

const ROTULOS = {
  demandaAcs: 'Demanda/Sustentação ACS',
  artefatoJira: 'Artefato Jira',
  nome: 'Nome da Demanda/Sustentação',
  pontosTotal: 'Pontos de Função (total)',
  documentacao: 'Documentação',
  desenvolvimento: 'Desenvolvimento',
  teste: 'Teste',
  implantacao: 'Implantação',
  inicioAtendimento: 'Início do Atendimento',
  conclusaoPrevista: 'Conclusão prevista',
  previsaoExpedicao: 'Previsão de Expedição',
  observacoes: 'Observações'
};

const CAMPOS_TEXTO = {
  demandaAcs: 'demanda_acs', artefatoJira: 'artefato_jira', nome: 'nome', observacoes: 'observacoes'
};
const CAMPOS_FASE = {
  documentacao: 'pontos_documentacao', desenvolvimento: 'pontos_desenvolvimento',
  teste: 'pontos_teste', implantacao: 'pontos_implantacao'
};
const CAMPOS_DATA = {
  inicioAtendimento: 'inicio_atendimento', conclusaoPrevista: 'conclusao_prevista',
  previsaoExpedicao: 'previsao_expedicao'
};

const tem = (obj, chave) => Object.prototype.hasOwnProperty.call(obj, chave);

/** Número com vírgula ou ponto (10,4 / 10.4), até 2 casas. Vazio vira null.
 * A planilha de origem é digitada em pt-BR, então vírgula é o caso comum. */
function interpretarNumero(valor) {
  if (valor === null || valor === undefined) return { ok: true, valor: null };
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor) || valor < 0 || valor > MAX_PONTOS) {
      return { ok: false, erro: 'Valor fora do intervalo permitido.' };
    }
    return { ok: true, valor: Math.round(valor * 100) / 100 };
  }
  const texto = String(valor).trim();
  if (texto === '') return { ok: true, valor: null };
  if (!/^\d+([.,]\d{1,2})?$/.test(texto)) {
    return { ok: false, erro: 'Use um número com até 2 casas decimais, ex.: 10,4.' };
  }
  const numero = Number(texto.replace(',', '.'));
  if (numero > MAX_PONTOS) return { ok: false, erro: 'Valor fora do intervalo permitido.' };
  return { ok: true, valor: numero };
}

/** O total aceita o mesmo que a planilha aceita: um número, ou o texto
 * "em análise" quando a demanda ainda não foi dimensionada. */
function interpretarPontosTotal(valor) {
  if (typeof valor === 'string' && /^\s*em\s+an[aá]lise\s*$/i.test(valor)) {
    return { ok: true, valor: null, emAnalise: true };
  }
  const r = interpretarNumero(valor);
  return r.ok ? { ok: true, valor: r.valor, emAnalise: false } : r;
}

function interpretarData(valor) {
  if (valor === null || valor === undefined || valor === '') return { ok: true, valor: null };
  const texto = String(valor).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  const invalida = { ok: false, erro: 'Data inválida.' };
  if (!m) return invalida;
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (ano < 2000 || ano > 2100) return invalida;
  // Round-trip pela data: "2026-02-31" vira março, e aí a comparação falha.
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  if (d.getUTCFullYear() !== ano || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return invalida;
  return { ok: true, valor: texto };
}

function interpretarTexto(campo, valor) {
  const texto = valor === null || valor === undefined ? '' : String(valor).trim();
  if (texto.length > LIMITE_TEXTO[campo]) {
    return { ok: false, erro: `Texto longo demais (máximo ${LIMITE_TEXTO[campo]} caracteres).` };
  }
  return { ok: true, valor: texto };
}

/** Converte o corpo de um PATCH em colunas do banco. Só entra o que está na
 * lista - campo desconhecido é ignorado, nunca gravado (id, removido,
 * criado_por etc. não podem ser alterados por aqui). */
function normalizarCampos(corpo) {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) {
    return { ok: false, erro: 'Corpo inválido.' };
  }
  const registro = {};
  const falha = (campo, r) => ({ ok: false, erro: `${ROTULOS[campo]}: ${r.erro}` });

  for (const [campo, coluna] of Object.entries(CAMPOS_TEXTO)) {
    if (!tem(corpo, campo)) continue;
    const r = interpretarTexto(campo, corpo[campo]);
    if (!r.ok) return falha(campo, r);
    registro[coluna] = r.valor;
  }
  for (const [campo, coluna] of Object.entries(CAMPOS_FASE)) {
    if (!tem(corpo, campo)) continue;
    const r = interpretarNumero(corpo[campo]);
    if (!r.ok) return falha(campo, r);
    registro[coluna] = r.valor;
  }
  for (const [campo, coluna] of Object.entries(CAMPOS_DATA)) {
    if (!tem(corpo, campo)) continue;
    const r = interpretarData(corpo[campo]);
    if (!r.ok) return falha(campo, r);
    registro[coluna] = r.valor;
  }
  if (tem(corpo, 'pontosTotal')) {
    const r = interpretarPontosTotal(corpo.pontosTotal);
    if (!r.ok) return falha('pontosTotal', r);
    registro.pontos_total = r.valor;
    registro.em_analise = r.emAnalise;
  }

  if (Object.keys(registro).length === 0) {
    return { ok: false, erro: 'Nenhum campo válido para atualizar.' };
  }
  return { ok: true, registro };
}

/** Link clicável do Jira. Aceita a chave (JDCBBRB-360) ou a URL completa,
 * mas só devolve URL do próprio Jira da empresa: o valor é digitado por
 * gente da equipe e exibido pra todo mundo que entra, então nunca vira
 * link pra outro destino (nem "javascript:"). */
function urlJira(valor) {
  const texto = String(valor || '').trim();
  if (/^[A-Za-z][A-Za-z0-9]+-\d+$/.test(texto)) return `${SITE}/browse/${texto.toUpperCase()}`;
  if (texto.startsWith(`${SITE}/`) && /^\S+$/.test(texto)) return texto;
  return null;
}

const numeroOuNulo = (v) => (v === null || v === undefined ? null : Number(v));

/** Linha do banco -> formato que a API devolve. */
function deLinha(l) {
  return {
    id: l.id,
    mes: l.mes || null,
    demandaAcs: l.demanda_acs || '',
    artefatoJira: l.artefato_jira || '',
    artefatoUrl: urlJira(l.artefato_jira),
    nome: l.nome || '',
    pontosTotal: numeroOuNulo(l.pontos_total),
    emAnalise: !!l.em_analise,
    documentacao: numeroOuNulo(l.pontos_documentacao),
    desenvolvimento: numeroOuNulo(l.pontos_desenvolvimento),
    teste: numeroOuNulo(l.pontos_teste),
    implantacao: numeroOuNulo(l.pontos_implantacao),
    inicioAtendimento: l.inicio_atendimento || null,
    conclusaoPrevista: l.conclusao_prevista || null,
    previsaoExpedicao: l.previsao_expedicao || null,
    observacoes: l.observacoes || '',
    atualizadoPor: l.atualizado_por || null,
    atualizadoEm: l.atualizado_em || null
  };
}

/** :id da URL -> número, ou null se não for um inteiro positivo. */
function idDemanda(valor) {
  return /^\d{1,12}$/.test(String(valor)) && Number(valor) > 0 ? Number(valor) : null;
}

/* ---- Mês de competência ----
 * A entrega é por mês e cada mês tem registros novos: a mesma demanda pode
 * aparecer em vários meses, uma linha em cada, com o que foi pago naquele
 * mês. O mês é guardado como "AAAA-MM". */
const MESES_MAX = 24;
const MES_INVALIDO = { ok: false, erro: 'Mês inválido (use AAAA-MM).' };

function interpretarMes(valor) {
  const texto = valor === null || valor === undefined ? '' : String(valor).trim();
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(texto);
  if (!m || Number(m[1]) < 2000 || Number(m[1]) > 2100) return MES_INVALIDO;
  return { ok: true, valor: texto };
}

/** "2026-09,2026-10" -> ['2026-09','2026-10'], sem repetir e em ordem. */
function interpretarListaMeses(texto) {
  if (typeof texto !== 'string' || texto.trim() === '') {
    return { ok: false, erro: 'Informe ao menos um mês.' };
  }
  const meses = [];
  for (const parte of texto.split(',')) {
    const r = interpretarMes(parte);
    if (!r.ok) return r;
    if (!meses.includes(r.valor)) meses.push(r.valor);
  }
  if (meses.length > MESES_MAX) return { ok: false, erro: `Selecione no máximo ${MESES_MAX} meses.` };
  return { ok: true, valor: meses.sort() };
}

function mesesDisponiveis(demandas) {
  return [...new Set(demandas.map((d) => d.mes).filter(Boolean))].sort();
}

/** meses = null significa "todos". */
function filtrarPorMeses(demandas, meses) {
  return meses ? demandas.filter((d) => meses.includes(d.mes)) : demandas;
}

/* ---- Resumo e consolidado ---- */
const FASES = ['documentacao', 'desenvolvimento', 'teste', 'implantacao'];
const arredondar = (n) => Math.round(n * 100) / 100;
const somarCampo = (linhas, campo) =>
  arredondar(linhas.reduce((s, d) => s + (typeof d[campo] === 'number' ? d[campo] : 0), 0));

function resumoDeLinhas(linhas) {
  const r = { demandas: linhas.length, pontosTotal: somarCampo(linhas, 'pontosTotal') };
  FASES.forEach((f) => { r[f] = somarCampo(linhas, f); });
  r.entregue = arredondar(FASES.reduce((s, f) => s + r[f], 0));
  return r;
}

/** Consolidado de vários meses. As fases são o que foi PAGO em cada mês,
 * então somam. Já os "Pontos de Função (total)" são uma propriedade da
 * demanda, não do mês: se a mesma demanda (mesmo número ACS) aparece em
 * mais de um mês, o total dela entra UMA vez - o do mês mais recente em que
 * foi informado. Somar de novo a cada mês inflaria o total. Linha sem número
 * ACS não dá para reconhecer como repetida, então conta sozinha. */
function consolidar(linhas, qtdMeses) {
  const porAcs = new Map();
  const semAcs = [];
  for (const d of linhas) {
    const chave = (d.demandaAcs || '').trim();
    if (!chave) { semAcs.push(d); continue; }
    if (!porAcs.has(chave)) porAcs.set(chave, []);
    porAcs.get(chave).push(d);
  }
  let pontosTotal = 0;
  for (const grupo of porAcs.values()) {
    const maisRecente = grupo
      .filter((d) => typeof d.pontosTotal === 'number')
      .sort((a, b) => (b.mes || '').localeCompare(a.mes || '') || b.id - a.id)[0];
    if (maisRecente) pontosTotal += maisRecente.pontosTotal;
  }
  semAcs.forEach((d) => { if (typeof d.pontosTotal === 'number') pontosTotal += d.pontosTotal; });

  const fases = resumoDeLinhas(linhas);
  return {
    meses: qtdMeses,
    demandas: porAcs.size + semAcs.length,
    pontosTotal: arredondar(pontosTotal),
    documentacao: fases.documentacao,
    desenvolvimento: fases.desenvolvimento,
    teste: fases.teste,
    implantacao: fases.implantacao,
    entregue: fases.entregue
  };
}

/** Um resumo por mês (em ordem cronológica) + o consolidado do conjunto. */
function resumirMeses(demandas, meses) {
  const lista = [...new Set(meses)].sort();
  const dentro = demandas.filter((d) => lista.includes(d.mes));
  return {
    porMes: lista.map((mes) => ({ mes, ...resumoDeLinhas(dentro.filter((d) => d.mes === mes)) })),
    consolidado: consolidar(dentro, lista.length)
  };
}

module.exports = {
  interpretarNumero, interpretarPontosTotal, interpretarData, interpretarTexto,
  normalizarCampos, urlJira, deLinha, idDemanda,
  interpretarMes, interpretarListaMeses, mesesDisponiveis, filtrarPorMeses, resumirMeses
};
