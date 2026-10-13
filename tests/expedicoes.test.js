// Regras puras da tela de Expedições (checklist do time).

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  ITENS_PADRAO, chaveJira, normalizarExpedicao, normalizarItemNovo, normalizarEstadoItem, progresso,
  hojeBrasilia, classificar, itensDoQuadro, montarOpcoes, responsavelAtual, decorar
} = require('../expedicoes');

const QUADRO = {
  pessoas: { p1: { nome: 'Ana Souza' }, p2: { nome: 'Bruno Lima' } },
  colunas: [
    {
      nome: 'Desenvolvimento',
      cards: [
        { titulo: 'Estornar Contratos', epico: 'JDCBBRB-401', pessoa: 'p1', tarefas: [
          { chave: 'JDCBBRB-410', titulo: 'API de estorno', subtarefa: false, pessoa: 'p2' },
          { chave: 'JDCBBRB-411', titulo: 'Teste da API', subtarefa: true, pessoa: 'p2' }
        ] },
        { titulo: 'Ajuste avulso', epico: null, pessoa: null, tarefas: [
          { chave: 'JDCBBRB-500', titulo: 'Ajuste avulso', subtarefa: false, pessoa: null }
        ] }
      ]
    }
  ]
};

describe('itens padrão', () => {
  test('união das listas do time: 6 antes de comitar, 9 antes de expedir, sem repetir', () => {
    assert.strictEqual(ITENS_PADRAO.filter((i) => i.bloco === 'comitar').length, 6);
    assert.strictEqual(ITENS_PADRAO.filter((i) => i.bloco === 'expedir').length, 9);
    const textos = ITENS_PADRAO.map((i) => i.texto);
    assert.strictEqual(new Set(textos).size, textos.length);
  });
});

describe('chaveJira', () => {
  test('extrai a chave de texto ou de link, em maiúsculas', () => {
    assert.strictEqual(chaveJira('jdcbbrb-401'), 'JDCBBRB-401');
    assert.strictEqual(chaveJira('https://x.atlassian.net/browse/JDCBBRB-401?a=1'), 'JDCBBRB-401');
    assert.strictEqual(chaveJira('sem chave'), '');
    assert.strictEqual(chaveJira(null), '');
  });
});

describe('normalizarExpedicao', () => {
  test('criar exige Jira, nome ou ACS; aceita qualquer um dos três', () => {
    assert.strictEqual(normalizarExpedicao({}, { criando: true }).ok, false);
    assert.strictEqual(normalizarExpedicao({ nome: '  ' }, { criando: true }).ok, false);
    assert.deepStrictEqual(normalizarExpedicao({ demandaAcs: ' 123 ' }, { criando: true }).registro, { demanda_acs: '123' });
  });

  test('Jira vira chave em maiúsculas; link também', () => {
    const r = normalizarExpedicao({ artefatoJira: 'https://x/browse/jdcbbrb-9' }, { criando: true });
    assert.strictEqual(r.registro.artefato_jira, 'JDCBBRB-9');
  });

  test('data inválida é recusada; vazio limpa; campo desconhecido (e responsável) é ignorado', () => {
    assert.strictEqual(normalizarExpedicao({ dataExpedicao: '2026-02-31' }).ok, false);
    assert.strictEqual(normalizarExpedicao({ dataExpedicao: 'amanhã' }).ok, false);
    assert.deepStrictEqual(normalizarExpedicao({ dataExpedicao: '' }).registro, { data_expedicao: null });
    const r = normalizarExpedicao({ nome: 'x', removido: true, responsavel: 'Fulano', id: 9 });
    assert.deepStrictEqual(r.registro, { nome: 'x' });
  });

  test('texto longo demais e corpo inválido são recusados; PATCH vazio também', () => {
    assert.strictEqual(normalizarExpedicao({ nome: 'x'.repeat(301) }).ok, false);
    assert.strictEqual(normalizarExpedicao(null).ok, false);
    assert.strictEqual(normalizarExpedicao([]).ok, false);
    assert.strictEqual(normalizarExpedicao({ foo: 1 }).ok, false);
  });
});

describe('itens avulsos e estados', () => {
  test('item novo: bloco válido e texto de 3 a 200 caracteres', () => {
    assert.deepStrictEqual(normalizarItemNovo({ bloco: 'expedir', texto: '  Validar com o BRB ' }), { ok: true, bloco: 'expedir', texto: 'Validar com o BRB' });
    assert.strictEqual(normalizarItemNovo({ bloco: 'outro', texto: 'abc' }).ok, false);
    assert.strictEqual(normalizarItemNovo({ bloco: 'expedir', texto: 'ab' }).ok, false);
    assert.strictEqual(normalizarItemNovo({ bloco: 'expedir', texto: 'x'.repeat(201) }).ok, false);
    assert.strictEqual(normalizarItemNovo(null).ok, false);
  });

  test('"não aplicável" exige motivo de pelo menos 10 caracteres', () => {
    assert.strictEqual(normalizarEstadoItem({ estado: 'nao_aplicavel' }).ok, false);
    assert.strictEqual(normalizarEstadoItem({ estado: 'nao_aplicavel', justificativa: '         ' }).ok, false);
    assert.match(normalizarEstadoItem({ estado: 'nao_aplicavel', justificativa: 'curto' }).erro, /Explique/);
    const ok = normalizarEstadoItem({ estado: 'nao_aplicavel', justificativa: '  Não mexe em banco  ' });
    assert.deepStrictEqual(ok, { ok: true, estado: 'nao_aplicavel', justificativa: 'Não mexe em banco' });
    assert.strictEqual(normalizarEstadoItem({ estado: 'nao_aplicavel', justificativa: 'x'.repeat(501) }).ok, false);
  });

  test('concluído e pendente nunca guardam motivo (voltar atrás desfaz o N/A)', () => {
    assert.deepStrictEqual(normalizarEstadoItem({ estado: 'concluido', justificativa: 'sobra' }), { ok: true, estado: 'concluido', justificativa: null });
    assert.deepStrictEqual(normalizarEstadoItem({ estado: 'pendente', justificativa: 'sobra' }), { ok: true, estado: 'pendente', justificativa: null });
  });

  test('estado desconhecido é recusado', () => {
    assert.strictEqual(normalizarEstadoItem({ estado: 'feito' }).ok, false);
    assert.strictEqual(normalizarEstadoItem(null).ok, false);
  });
});

describe('progresso', () => {
  test('N/A conta como resolvido mas aparece separado; item removido não conta', () => {
    const itens = [
      { estado: 'concluido' }, { estado: 'concluido' }, { estado: 'nao_aplicavel' },
      { estado: 'pendente' }, { estado: 'pendente', removido: true }
    ];
    assert.deepStrictEqual(progresso(itens), { total: 4, concluidos: 2, naoAplicaveis: 1, pendentes: 1 });
  });
  test('sem itens: tudo zero', () => {
    assert.deepStrictEqual(progresso([]), { total: 0, concluidos: 0, naoAplicaveis: 0, pendentes: 0 });
  });
});

describe('data e urgência (relógio de Brasília)', () => {
  test('hoje no Brasil, não em UTC: 23h do dia 8 em Brasília já é dia 9 em UTC', () => {
    assert.strictEqual(hojeBrasilia(new Date('2026-10-09T02:30:00Z')), '2026-10-08');
    assert.strictEqual(hojeBrasilia(new Date('2026-10-09T03:00:00Z')), '2026-10-09');
  });

  test('grupos por data e alerta só com pendência e prazo de até 1 dia', () => {
    const hoje = '2026-10-08';
    assert.deepStrictEqual(classificar('2026-10-07', 2, hoje), { grupo: 'atrasadas', alerta: true, dias: -1 });
    assert.deepStrictEqual(classificar('2026-10-08', 1, hoje), { grupo: 'hoje', alerta: true, dias: 0 });
    assert.deepStrictEqual(classificar('2026-10-09', 1, hoje), { grupo: 'amanha', alerta: true, dias: 1 });
    assert.deepStrictEqual(classificar('2026-10-10', 5, hoje), { grupo: 'proximas', alerta: false, dias: 2 });
    assert.deepStrictEqual(classificar('2026-10-09', 0, hoje), { grupo: 'amanha', alerta: false, dias: 1 });
    assert.deepStrictEqual(classificar(null, 3, hoje), { grupo: 'sem-data', alerta: false, dias: null });
  });

  test('virada de mês e de ano', () => {
    assert.strictEqual(classificar('2026-11-01', 1, '2026-10-31').grupo, 'amanha');
    assert.strictEqual(classificar('2027-01-01', 1, '2026-12-31').grupo, 'amanha');
  });
});

describe('quadro Kanban e autocomplete', () => {
  test('lista o card (épico) e as tasks, nunca subtarefas, com o responsável do Jira', () => {
    const q = itensDoQuadro(QUADRO);
    assert.deepStrictEqual([...q.keys()].sort(), ['JDCBBRB-401', 'JDCBBRB-410', 'JDCBBRB-500']);
    assert.strictEqual(q.get('JDCBBRB-401').responsavel, 'Ana Souza');
    assert.strictEqual(q.get('JDCBBRB-410').responsavel, 'Bruno Lima');
    assert.strictEqual(q.get('JDCBBRB-500').responsavel, '');
  });

  test('quadro vazio ou com erro não quebra', () => {
    assert.strictEqual(itensDoQuadro({ vazio: true, colunas: [] }).size, 0);
    assert.strictEqual(itensDoQuadro(null).size, 0);
    assert.strictEqual(itensDoQuadro({}).size, 0);
  });

  test('opções: quadro enriquecido com ACS e data de Demandas; demanda fora do quadro também entra', () => {
    const demandas = [
      { mes: '2026-09', artefatoJira: 'JDCBBRB-401', demandaAcs: '111', nome: 'Antigo', previsaoExpedicao: '2026-09-30' },
      { mes: '2026-10', artefatoJira: 'https://x/browse/JDCBBRB-401', demandaAcs: '222', nome: 'Novo', previsaoExpedicao: '2026-10-15' },
      { mes: '2026-10', artefatoJira: 'JDCBBRB-900', demandaAcs: '333', nome: 'Fora do quadro', previsaoExpedicao: null },
      { mes: '2026-10', artefatoJira: '', demandaAcs: '444', nome: 'Sem Jira', previsaoExpedicao: null }
    ];
    const op = montarOpcoes(QUADRO, demandas);
    const e401 = op.find((o) => o.jira === 'JDCBBRB-401');
    assert.deepStrictEqual(e401, { jira: 'JDCBBRB-401', nome: 'Estornar Contratos', acs: '222', dataExpedicao: '2026-10-15', responsavel: 'Ana Souza', origem: 'quadro' });
    assert.strictEqual(op.find((o) => o.jira === 'JDCBBRB-410').acs, '');
    assert.strictEqual(op.find((o) => o.jira === 'JDCBBRB-900').origem, 'demandas');
    assert.strictEqual(op.find((o) => o.acs === '444').jira, '');
    assert.strictEqual(op.filter((o) => o.jira === 'JDCBBRB-401').length, 1);
  });

  test('responsável: Jira de hoje vence; senão o guardado; senão marca "nenhum"', () => {
    assert.deepStrictEqual(responsavelAtual({ artefatoJira: 'JDCBBRB-401', responsavelGuardado: 'Velho' }, QUADRO), { nome: 'Ana Souza', origem: 'jira' });
    assert.deepStrictEqual(responsavelAtual({ artefatoJira: 'JDCBBRB-500', responsavelGuardado: 'Guardado' }, QUADRO), { nome: 'Guardado', origem: 'guardado' });
    assert.deepStrictEqual(responsavelAtual({ artefatoJira: 'JDCBBRB-500', responsavelGuardado: '' }, QUADRO), { nome: '', origem: 'nenhum' });
    assert.deepStrictEqual(responsavelAtual({ artefatoJira: '', responsavelGuardado: '' }, null), { nome: '', origem: 'nenhum' });
  });

  test('decorar junta responsável, progresso e urgência', () => {
    const e = decorar({ artefatoJira: 'JDCBBRB-401', dataExpedicao: '2026-10-09', itens: [{ estado: 'pendente' }, { estado: 'concluido' }] }, QUADRO, '2026-10-08');
    assert.strictEqual(e.responsavel.nome, 'Ana Souza');
    assert.deepStrictEqual(e.progresso, { total: 2, concluidos: 1, naoAplicaveis: 0, pendentes: 1 });
    assert.strictEqual(e.grupo, 'amanha');
    assert.strictEqual(e.alerta, true);
  });
});
