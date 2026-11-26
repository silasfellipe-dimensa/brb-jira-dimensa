// Tela "Produção PF": quanto de ponto de função a equipe produziu por mês,
// calculado a partir do que o coletor traz do ACS. Regras puras - sem banco,
// sem rede - para serem testadas isoladamente.
//
// As regras (escritas também na própria tela, para quem confere):
//
//   Demandas: o PF da demanda é pago em pedaços, um por fase, conforme os
//   pesos do contrato (no da Dimensa: F4 30%, F5 40%, F6 20%, F7 10%). O
//   pedaço de uma fase conta no mês em que a fase foi APROVADA no ACS. O PF
//   usado é o da contagem que vale hoje (a aprovada mais recente; sem
//   aprovada, a que aguarda aprovação).
//
//   A creditar: fase pedida e ainda aguardando aprovação - entra no mês em
//   que for aprovada.
//
//   Sustentação: cada chamado vale quantidade x PF do indicador (tabela do
//   contrato) e conta no mês em que foi finalizado (situação Atendida ou
//   Finalizada).

const { pfAtual, NOMES_FASE } = require('./acs');

const SITUACOES_SUST_CONTAM = new Set([3, 5]); // Atendida, Finalizada
const MESES_NO_GRAFICO = 12;

const arred = (n) => Math.round(n * 1000) / 1000;
/** "2026-10-14T15:39:22-03:00" -> "2026-10" (a hora já vem em Brasília). */
const mesDe = (instante) => (typeof instante === 'string' && /^\d{4}-\d{2}/.test(instante) ? instante.slice(0, 7) : null);

function mesesAte(ultimo, quantos) {
  const [a, m] = ultimo.split('-').map(Number);
  const lista = [];
  for (let i = quantos - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(a, m - 1 - i, 1));
    lista.push(d.toISOString().slice(0, 7));
  }
  return lista;
}

/**
 * @param solicitacoes linhas do banco (acs_solicitacoes) com fases e metricas
 * @param sustentacoes linhas do banco (acs_sustentacoes)
 * @param contrato     { nome, pesos: {F1..F7}, sq, indicadores: [{id, pf, atividade}] } ou null
 * @param hoje         "AAAA-MM-DD" em Brasília
 */
function montarProducao({ solicitacoes, sustentacoes, contrato, hoje }) {
  const pesos = (contrato && contrato.pesos) || {};
  const creditos = [];
  const aCreditar = [];
  let semContagem = 0;

  for (const s of solicitacoes || []) {
    const fases = Array.isArray(s.fases) ? s.fases : [];
    const pf = pfAtual(s.metricas);
    const pagas = fases.filter((f) => (pesos[f.fase] || 0) > 0 && (f.situacao === 'A' || f.situacao === 'E'));
    if (!pagas.length) continue;
    if (!pf) { semContagem++; continue; }
    for (const f of pagas) {
      const item = {
        numero: s.numero,
        resumo: s.resumo || '',
        fase: f.fase,
        faseNome: NOMES_FASE[f.fase] || '',
        peso: pesos[f.fase],
        pfDemanda: pf.valor,
        pfSituacao: pf.situacao,
        credito: arred(pf.valor * pesos[f.fase])
      };
      if (f.situacao === 'A' && f.validacao) creditos.push({ ...item, mes: mesDe(f.validacao), aprovadaEm: f.validacao });
      else if (f.situacao === 'E') aCreditar.push({ ...item, pedidaEm: f.inclusao || null });
    }
  }

  const pfIndicador = new Map(((contrato && contrato.indicadores) || []).map((i) => [i.id, i]));
  const chamados = [];
  for (const c of sustentacoes || []) {
    if (!c.finalizacao || !SITUACOES_SUST_CONTAM.has(c.situacao)) continue;
    if (contrato && contrato.sq && c.contrato && c.contrato !== contrato.sq) continue;
    const ind = pfIndicador.get(c.indicador);
    const pf = arred((c.quantidade || 0) * (ind ? ind.pf : 0));
    chamados.push({
      numero: c.numero,
      mes: mesDe(c.finalizacao),
      finalizadoEm: c.finalizacao,
      indicador: c.indicador,
      atividade: ind ? ind.atividade : '',
      quantidade: c.quantidade || 0,
      pfUnitario: ind ? ind.pf : null,
      pf
    });
  }

  const mesAtual = String(hoje || '').slice(0, 7);
  const meses = mesesAte(mesAtual, MESES_NO_GRAFICO).map((mes) => {
    const demandas = arred(creditos.filter((c) => c.mes === mes).reduce((t, c) => t + c.credito, 0));
    const sustentacao = arred(chamados.filter((c) => c.mes === mes).reduce((t, c) => t + c.pf, 0));
    return { mes, demandas, sustentacao, total: arred(demandas + sustentacao) };
  });

  return {
    mesAtual,
    contrato: contrato ? { nome: contrato.nome || '', pesos } : null,
    meses,
    creditos: creditos.sort((a, b) => b.aprovadaEm.localeCompare(a.aprovadaEm)),
    aCreditar,
    sustentacoes: chamados.sort((a, b) => b.finalizadoEm.localeCompare(a.finalizadoEm)),
    semContagem
  };
}

module.exports = { montarProducao, SITUACOES_SUST_CONTAM, MESES_NO_GRAFICO };
