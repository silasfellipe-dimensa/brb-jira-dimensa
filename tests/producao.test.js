// Tela "Produção PF" - producao.js. Sem banco, sem rede.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { montarProducao } = require('../producao');

const PESOS = { F1: 0, F2: 0, F3: 0, F4: 0.3, F5: 0.4, F6: 0.2, F7: 0.1 };
const contrato = (extra = {}) => ({
  sq: 15, nome: 'Contrato de teste', pesos: PESOS,
  indicadores: [{ id: 129, pf: 2, atividade: 'Alta complexidade' }, { id: 126, pf: 0, atividade: 'Produto padrão' }],
  ...extra
});
const fase = (f, situacao, validacao, inclusao = '2026-10-01T10:00:00-03:00') => ({ fase: f, situacao, inclusao, validacao, rejeicao: null });
const metrica = (pf, situacao = 'A', data = '2026-09-01T10:00:00-03:00') => ({ pf, tipo: 'D', situacao, data, documento: '' });
const demanda = (numero, fases, metricas) => ({ numero, resumo: `Demanda ${numero}`, fases, metricas });
const chamado = (numero, finalizacao, quantidade, indicador = 129, situacao = 5) =>
  ({ numero, situacao, finalizacao, quantidade, indicador, contrato: 15 });

describe('montarProducao — demandas', () => {
  test('cada fase aprovada credita PF x peso no mês da aprovação', () => {
    const p = montarProducao({
      solicitacoes: [demanda(1, [fase('F4', 'A', '2026-10-05T10:00:00-03:00'), fase('F5', 'A', '2026-11-03T10:00:00-03:00')], [metrica(10)])],
      sustentacoes: [], contrato: contrato(), hoje: '2026-11-26'
    });
    const out = p.meses.find((m) => m.mes === '2026-10');
    const nov = p.meses.find((m) => m.mes === '2026-11');
    assert.strictEqual(out.demandas, 3);
    assert.strictEqual(nov.demandas, 4);
    assert.strictEqual(p.creditos.length, 2);
  });

  test('fase com peso 0 (F1 a F3 no contrato) não credita nada', () => {
    const p = montarProducao({
      solicitacoes: [demanda(1, [fase('F1', 'A', '2026-11-01T10:00:00-03:00'), fase('F3', 'A', '2026-11-02T10:00:00-03:00')], [metrica(10)])],
      sustentacoes: [], contrato: contrato(), hoje: '2026-11-26'
    });
    assert.strictEqual(p.creditos.length, 0);
  });

  // Bug que isto pega: somar como produzido o que ainda nem foi aprovado.
  test('fase aguardando aprovação vai para "a creditar", não para o mês', () => {
    const p = montarProducao({
      solicitacoes: [demanda(1, [fase('F6', 'E', null)], [metrica(12.9)])],
      sustentacoes: [], contrato: contrato(), hoje: '2026-11-26'
    });
    assert.strictEqual(p.meses.find((m) => m.mes === '2026-11').demandas, 0);
    assert.strictEqual(p.aCreditar.length, 1);
    assert.strictEqual(p.aCreditar[0].credito, 2.58);
  });

  test('fase rejeitada não credita; demanda sem contagem de PF é contada à parte', () => {
    const p = montarProducao({
      solicitacoes: [
        demanda(1, [fase('F5', 'R', null)], [metrica(10)]),
        demanda(2, [fase('F4', 'A', '2026-11-01T10:00:00-03:00')], [])
      ],
      sustentacoes: [], contrato: contrato(), hoje: '2026-11-26'
    });
    assert.strictEqual(p.creditos.length, 0);
    assert.strictEqual(p.semContagem, 1);
  });

  test('sem contrato (ainda não veio do ACS), nada é creditado e não quebra', () => {
    const p = montarProducao({
      solicitacoes: [demanda(1, [fase('F4', 'A', '2026-11-01T10:00:00-03:00')], [metrica(10)])],
      sustentacoes: [chamado(9, '2026-11-02T10:00:00-03:00', 1)], contrato: null, hoje: '2026-11-26'
    });
    assert.strictEqual(p.contrato, null);
    assert.ok(p.meses.every((m) => m.total === 0));
  });
});

describe('montarProducao — sustentação', () => {
  test('quantidade x PF do indicador, no mês da finalização', () => {
    const p = montarProducao({
      solicitacoes: [], contrato: contrato(), hoje: '2026-11-26',
      sustentacoes: [chamado(1, '2026-11-26T13:30:00-03:00', 3), chamado(2, '2026-10-31T23:00:00-03:00', 1)]
    });
    assert.strictEqual(p.meses.find((m) => m.mes === '2026-11').sustentacao, 6);
    assert.strictEqual(p.meses.find((m) => m.mes === '2026-10').sustentacao, 2);
  });

  test('chamado aberto, cancelado ou de outro contrato não conta', () => {
    const p = montarProducao({
      solicitacoes: [], contrato: contrato(), hoje: '2026-11-26',
      sustentacoes: [
        chamado(1, null, 1),
        chamado(2, '2026-11-02T10:00:00-03:00', 1, 129, 6),
        { ...chamado(3, '2026-11-02T10:00:00-03:00', 1), contrato: 99 }
      ]
    });
    assert.strictEqual(p.sustentacoes.length, 0);
  });

  test('indicador desconhecido entra com PF 0 (aparece na conferência)', () => {
    const p = montarProducao({ solicitacoes: [], contrato: contrato(), hoje: '2026-11-26', sustentacoes: [chamado(1, '2026-11-02T10:00:00-03:00', 2, 777)] });
    assert.strictEqual(p.sustentacoes.length, 1);
    assert.strictEqual(p.sustentacoes[0].pf, 0);
    assert.strictEqual(p.sustentacoes[0].pfUnitario, null);
  });
});

describe('montarProducao — meses', () => {
  test('12 meses terminando no mês de hoje, total = demandas + sustentação', () => {
    const p = montarProducao({
      solicitacoes: [demanda(1, [fase('F4', 'A', '2026-11-01T10:00:00-03:00')], [metrica(10)])],
      sustentacoes: [chamado(1, '2026-11-02T10:00:00-03:00', 1)], contrato: contrato(), hoje: '2026-11-26'
    });
    assert.strictEqual(p.meses.length, 12);
    assert.strictEqual(p.meses[0].mes, '2025-12');
    assert.strictEqual(p.meses[11].mes, '2026-11');
    assert.deepStrictEqual(p.meses[11], { mes: '2026-11', demandas: 3, sustentacao: 2, total: 5 });
    assert.strictEqual(p.mesAtual, '2026-11');
  });
});
