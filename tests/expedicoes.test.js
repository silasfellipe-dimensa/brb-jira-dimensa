// Regras puras da tela de Expedições (checklist do time).

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  ITENS_PADRAO, chaveJira, normalizarExpedicao, normalizarItemNovo, normalizarEstadoItem, progresso,
  hojeBrasilia, classificar, itensDoQuadro, montarOpcoes, responsavelAtual, decorar, normalizarObservacao, deLinhaItem,
  deLinhaExpedicao, mesmaDemanda, linhaMaisRecente, planoParaDemandas, planoParaExpedicao, recadoSincronia, rotuloMes,
  normalizarMotivoExclusao, MAX_MOTIVO_EXCLUSAO
} = require('../expedicoes');

// 2026-11-19: excluir pede o motivo - menos na expedição em branco (rascunho)
test('motivo da exclusão: obrigatório com Jira/nome/ACS; em branco sai sem motivo', () => {
  const comJira = { artefatoJira: 'JDCBBRB-391', nome: '', demandaAcs: '' };
  assert.strictEqual(normalizarMotivoExclusao(comJira, '').ok, false);
  assert.strictEqual(normalizarMotivoExclusao(comJira, '   ab ').ok, false);
  assert.strictEqual(normalizarMotivoExclusao({ nome: 'só nome' }, null).ok, false);
  assert.deepStrictEqual(normalizarMotivoExclusao(comJira, '  Duplicada  —   da 391 '), { ok: true, motivo: 'Duplicada — da 391' });
  assert.strictEqual(normalizarMotivoExclusao(comJira, 'x'.repeat(MAX_MOTIVO_EXCLUSAO + 1)).ok, false);
  assert.deepStrictEqual(normalizarMotivoExclusao({ artefatoJira: '', nome: ' ', demandaAcs: '' }, undefined), { ok: true, motivo: '' });
});

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
  test('união das listas do time: 9 antes de comitar, 7 antes de expedir, sem repetir (Release Note saiu em 2026-10-21)', () => {
    assert.strictEqual(ITENS_PADRAO.filter((i) => i.bloco === 'comitar').length, 9);
    assert.strictEqual(ITENS_PADRAO.filter((i) => i.bloco === 'expedir').length, 7);
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

describe('PF da expedição e itens do "antes de comitar"', () => {
  test('PF aceita vírgula ou ponto, até 2 casas; vazio apaga; negativo, texto e número demais são recusados', () => {
    assert.strictEqual(normalizarExpedicao({ pontosFuncao: '10,4' }).registro.pontos_funcao, 10.4);
    assert.strictEqual(normalizarExpedicao({ pontosFuncao: '5.25' }).registro.pontos_funcao, 5.25);
    assert.strictEqual(normalizarExpedicao({ pontosFuncao: 7 }).registro.pontos_funcao, 7);
    assert.strictEqual(normalizarExpedicao({ pontosFuncao: '' }).registro.pontos_funcao, null);
    assert.strictEqual(normalizarExpedicao({ pontosFuncao: null }).registro.pontos_funcao, null);
    for (const ruim of ['abc', '-1', '1,234', 'em análise', 100000, -3]) {
      const r = normalizarExpedicao({ pontosFuncao: ruim });
      assert.strictEqual(r.ok, false, String(ruim));
      assert.match(r.erro, /^PF:/);
    }
  });

  test('PF sozinho é uma alteração válida, mas não basta para criar', () => {
    assert.strictEqual(normalizarExpedicao({ pontosFuncao: '3' }).ok, true);
    assert.strictEqual(normalizarExpedicao({ pontosFuncao: '3' }, { criando: true }).ok, false);
    assert.strictEqual(normalizarExpedicao({ nome: 'x', pontosFuncao: '3' }, { criando: true }).registro.pontos_funcao, 3);
  });

  test('Descrição, Documentos de Configuração e Solução NÃO são campos: viram itens do checklist e o servidor ignora texto enviado com esses nomes', () => {
    const r = normalizarExpedicao({ nome: 'x', descricao: 'a', documentosConfiguracao: 'b', solucao: 'c' });
    assert.deepStrictEqual(r.registro, { nome: 'x' });
    assert.strictEqual(normalizarExpedicao({ descricao: 'a', solucao: 'c' }).ok, false, 'sem nada válido para alterar');
    const textos = ITENS_PADRAO.filter((i) => i.bloco === 'comitar').map((i) => i.texto);
    for (const t of ['Descrição preenchida?', 'Documentos de Configuração preenchidos?', 'Solução preenchida?']) {
      assert.ok(textos.includes(t), t);
    }
  });

  test('a API devolve o PF como número (ou null); zero é um PF válido', () => {
    assert.strictEqual(deLinhaExpedicao({ id: 1, pontos_funcao: '10.40' }, []).pontosFuncao, 10.4);
    assert.strictEqual(deLinhaExpedicao({ id: 2 }, []).pontosFuncao, null);
    assert.strictEqual(deLinhaExpedicao({ id: 3, pontos_funcao: 0 }, []).pontosFuncao, 0);
    assert.ok(!('descricao' in deLinhaExpedicao({ id: 4 }, [])), 'sem os campos de texto antigos');
  });

  test('autocomplete traz o PF de Demandas; "em análise" e sem total ficam sem PF', () => {
    const op = montarOpcoes(QUADRO, [
      { mes: '2026-10', artefatoJira: 'JDCBBRB-401', demandaAcs: '1', nome: 'a', pontosTotal: 12.5, emAnalise: false },
      { mes: '2026-10', artefatoJira: 'JDCBBRB-900', demandaAcs: '2', nome: 'b', pontosTotal: null, emAnalise: true },
      { mes: '2026-10', artefatoJira: 'JDCBBRB-901', demandaAcs: '3', nome: 'c', pontosTotal: 4, emAnalise: true },
      { mes: '2026-10', artefatoJira: '', demandaAcs: '4', nome: 'd', pontosTotal: 8, emAnalise: false }
    ]);
    assert.strictEqual(op.find((o) => o.jira === 'JDCBBRB-401').pf, 12.5);
    assert.strictEqual(op.find((o) => o.jira === 'JDCBBRB-900').pf, null);
    assert.strictEqual(op.find((o) => o.jira === 'JDCBBRB-901').pf, null, 'em análise não vale mesmo com número');
    assert.strictEqual(op.find((o) => o.acs === '4').pf, 8);
    assert.strictEqual(op.find((o) => o.jira === 'JDCBBRB-410').pf, null, 'sem demanda correspondente');
  });
});

describe('observação do item', () => {
  test('texto livre e opcional: apara espaços; vazio ou só espaços apaga (null)', () => {
    assert.deepStrictEqual(normalizarObservacao({ observacao: '  Aguardando o BRB  ' }), { ok: true, observacao: 'Aguardando o BRB' });
    assert.deepStrictEqual(normalizarObservacao({ observacao: '' }), { ok: true, observacao: null });
    assert.deepStrictEqual(normalizarObservacao({ observacao: '   \n ' }), { ok: true, observacao: null });
    assert.deepStrictEqual(normalizarObservacao({ observacao: null }), { ok: true, observacao: null });
  });

  test('guarda quebras de linha e aceita exatamente 1000 caracteres, não 1001', () => {
    assert.strictEqual(normalizarObservacao({ observacao: 'a\nb' }).observacao, 'a\nb');
    assert.strictEqual(normalizarObservacao({ observacao: 'x'.repeat(1000) }).ok, true);
    assert.match(normalizarObservacao({ observacao: 'x'.repeat(1001) }).erro, /máximo 1000/);
  });

  test('corpo sem o campo, ou com tipo errado, é recusado', () => {
    for (const corpo of [null, undefined, [], {}, { outro: 'x' }, { observacao: 5 }, { observacao: {} }, { observacao: ['a'] }, { observacao: true }]) {
      assert.strictEqual(normalizarObservacao(corpo).ok, false, JSON.stringify(corpo));
    }
  });

  test('o item da API traz a observação e quem/quando; sem observação vem vazio', () => {
    const com = deLinhaItem({ id: 1, bloco: 'expedir', texto: 't', padrao: true, estado: 'pendente', observacao: 'nota', observacao_por: 'a@dimensa.com.br', observacao_em: '2026-10-09T12:00:00Z' });
    assert.strictEqual(com.observacao, 'nota');
    assert.strictEqual(com.observacaoPor, 'a@dimensa.com.br');
    assert.strictEqual(com.observacaoEm, '2026-10-09T12:00:00Z');
    const sem = deLinhaItem({ id: 2, bloco: 'expedir', texto: 't', padrao: true, estado: 'pendente' });
    assert.deepStrictEqual([sem.observacao, sem.observacaoPor, sem.observacaoEm], ['', '', null]);
  });

  test('a expedição conta quantos itens têm observação (removidos e vazios não contam)', () => {
    const e = decorar({ artefatoJira: '', dataExpedicao: null, itens: [
      { estado: 'pendente', observacao: 'a' }, { estado: 'concluido', observacao: 'b' }, { estado: 'pendente', observacao: '' },
      { estado: 'pendente', observacao: 'c', removido: true }, { estado: 'nao_aplicavel' }
    ] }, QUADRO, '2026-10-08');
    assert.strictEqual(e.observacoes, 2);
  });
});

describe('sincronia da data de expedição com Demandas', () => {
  const dem = (id, mes, jira, acs, previsao) => ({ id, mes, artefatoJira: jira, demandaAcs: acs, previsaoExpedicao: previsao || null });
  const exp = (id, jira, acs, data) => ({ id, artefatoJira: jira, demandaAcs: acs, dataExpedicao: data || null });

  test('mesma demanda: Jira dos dois lados decide (link ou chave, qualquer caixa); sem Jira, o ACS; nunca vazio com vazio', () => {
    assert.ok(mesmaDemanda({ artefatoJira: 'jdcbbrb-1' }, { artefatoJira: 'https://x/browse/JDCBBRB-1' }));
    assert.ok(!mesmaDemanda({ artefatoJira: 'JDCBBRB-1', demandaAcs: '5' }, { artefatoJira: 'JDCBBRB-2', demandaAcs: '5' }), 'Jira diferente vence o ACS igual');
    assert.ok(mesmaDemanda({ artefatoJira: '', demandaAcs: '20260525005' }, { artefatoJira: 'JDCBBRB-1', demandaAcs: ' 20260525005 ' }));
    assert.ok(!mesmaDemanda({ artefatoJira: '', demandaAcs: '' }, { artefatoJira: '', demandaAcs: '' }));
    assert.ok(!mesmaDemanda({ artefatoJira: 'JDCBBRB-1' }, { artefatoJira: '', demandaAcs: '' }));
  });

  test('linha de Demandas: a do mês mais recente; mesmo mês, a de maior id; meses de outras demandas não entram', () => {
    const l = [dem(1, '2026-09', 'JDCBBRB-1'), dem(2, '2026-10', 'JDCBBRB-1'), dem(3, '2026-10', 'JDCBBRB-1'), dem(4, '2026-11', 'JDCBBRB-9')];
    assert.strictEqual(linhaMaisRecente(l, { artefatoJira: 'JDCBBRB-1' }).id, 3);
    assert.strictEqual(linhaMaisRecente(l, { artefatoJira: 'JDCBBRB-404' }), null);
    assert.strictEqual(linhaMaisRecente([dem(1, '2025-12', 'JDCBBRB-1'), dem(2, '2026-01', 'JDCBBRB-1')], { artefatoJira: 'JDCBBRB-1' }).id, 2, 'virada de ano');
  });

  test('Expedições -> Demandas: atualiza só a linha do mês mais recente e nunca as antigas', () => {
    const demandas = [dem(1, '2026-09', 'JDCBBRB-1', '', '2026-09-30'), dem(2, '2026-10', 'JDCBBRB-1', '', null)];
    const e = exp(7, 'JDCBBRB-1', '', '2026-10-14');
    assert.deepStrictEqual(planoParaDemandas(e, [e], demandas), { acao: 'atualizar', demandaId: 2, mes: '2026-10', data: '2026-10-14' });
  });

  test('Expedições -> Demandas: nada a fazer quando já é igual, sem data, sem chave', () => {
    const demandas = [dem(2, '2026-10', 'JDCBBRB-1', '', '2026-10-14')];
    const e = exp(7, 'JDCBBRB-1', '', '2026-10-14');
    assert.strictEqual(planoParaDemandas(e, [e], demandas).motivo, 'igual');
    assert.strictEqual(planoParaDemandas({ ...e, dataExpedicao: null }, [e], demandas).motivo, 'sem-data', 'apagar a data nunca propaga');
    assert.strictEqual(planoParaDemandas(exp(8, '', '', '2026-10-14'), [], demandas).motivo, 'sem-chave');
  });

  test('Expedições -> Demandas: demanda inexistente avisa; duas expedições ativas para a mesma demanda não sincroniza', () => {
    const e = exp(7, 'JDCBBRB-1', '', '2026-10-14');
    assert.deepStrictEqual(planoParaDemandas(e, [e], []), { acao: 'avisar', motivo: 'sem-demanda' });
    const outra = exp(9, 'JDCBBRB-1', '', '2026-10-20');
    assert.deepStrictEqual(planoParaDemandas(e, [e, outra], [dem(2, '2026-10', 'JDCBBRB-1')]), { acao: 'avisar', motivo: 'varias-expedicoes' });
    // expedição de OUTRA demanda não atrapalha
    assert.strictEqual(planoParaDemandas(e, [e, exp(10, 'JDCBBRB-2', '', '2026-10-20')], [dem(2, '2026-10', 'JDCBBRB-1')]).acao, 'atualizar');
  });

  test('Demandas -> Expedições: atualiza a única expedição ativa da demanda', () => {
    const demandas = [dem(2, '2026-10', 'JDCBBRB-1', '', '2026-10-25')];
    assert.deepStrictEqual(planoParaExpedicao(demandas[0], demandas, [exp(7, 'JDCBBRB-1', '', '2026-10-14')]), { acao: 'atualizar', expedicaoId: 7, data: '2026-10-25' });
    assert.strictEqual(planoParaExpedicao(demandas[0], demandas, [exp(7, 'JDCBBRB-1', '', '2026-10-25')]).motivo, 'igual');
    assert.strictEqual(planoParaExpedicao(demandas[0], demandas, [exp(7, 'JDCBBRB-1', '', null)]).acao, 'atualizar', 'expedição sem data recebe a de Demandas');
  });

  test('Demandas -> Expedições: mês antigo não propaga; apagar não propaga; sem expedição fica quieto; várias avisa', () => {
    const demandas = [dem(1, '2026-09', 'JDCBBRB-1', '', '2026-09-30'), dem(2, '2026-10', 'JDCBBRB-1', '', '2026-10-25')];
    const e = exp(7, 'JDCBBRB-1', '', '2026-10-14');
    assert.strictEqual(planoParaExpedicao(demandas[0], demandas, [e]).motivo, 'mes-anterior');
    assert.strictEqual(planoParaExpedicao({ ...demandas[1], previsaoExpedicao: null }, demandas, [e]).motivo, 'sem-data');
    assert.strictEqual(planoParaExpedicao(demandas[1], demandas, []).motivo, 'sem-expedicao');
    assert.strictEqual(planoParaExpedicao(demandas[1], demandas, [e, exp(8, 'JDCBBRB-1', '', null)]).motivo, 'varias-expedicoes');
    assert.strictEqual(planoParaExpedicao(dem(5, '2026-10', '', '', '2026-10-25'), [], [e]).motivo, 'sem-chave');
  });

  test('ligação por ACS quando a demanda não tem Jira', () => {
    const demandas = [dem(2, '2026-10', '', '20260525005', '2026-10-25')];
    const e = exp(7, '', '20260525005', '2026-10-14');
    assert.strictEqual(planoParaExpedicao(demandas[0], demandas, [e]).acao, 'atualizar');
    assert.strictEqual(planoParaDemandas(e, [e], demandas).acao, 'atualizar');
  });

  test('recados: atualizada cita o mês; erro e avisos explicam; "nenhuma" não gera recado', () => {
    assert.deepStrictEqual(recadoSincronia('demandas', { acao: 'atualizar', mes: '2026-10' }, true),
      { destino: 'demandas', status: 'atualizada', texto: 'Data de expedição atualizada também em Demandas (Outubro de 2026).' });
    assert.strictEqual(recadoSincronia('expedicoes', { acao: 'atualizar' }, true).texto, 'Data de expedição atualizada também em Expedições.');
    assert.match(recadoSincronia('demandas', { acao: 'atualizar', mes: '2026-10' }, false).texto, /não consegui atualizá-la em Demandas/);
    assert.strictEqual(recadoSincronia('demandas', { acao: 'atualizar' }, false).status, 'erro');
    assert.match(recadoSincronia('demandas', { acao: 'avisar', motivo: 'varias-expedicoes' }, true).texto, /mais de uma expedição ativa/);
    assert.match(recadoSincronia('demandas', { acao: 'avisar', motivo: 'sem-demanda' }, true).texto, /Não encontrei esta demanda/);
    for (const motivo of ['igual', 'sem-data', 'sem-chave', 'mes-anterior', 'sem-expedicao']) {
      assert.strictEqual(recadoSincronia('demandas', { acao: 'nenhuma', motivo }, true), null, motivo);
    }
    assert.strictEqual(rotuloMes('2026-13'), '');
    assert.strictEqual(rotuloMes('2026-01'), 'Janeiro de 2026');
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
    assert.deepStrictEqual(e401, { jira: 'JDCBBRB-401', nome: 'Estornar Contratos', acs: '222', dataExpedicao: '2026-10-15', pf: null, responsavel: 'Ana Souza', origem: 'quadro' });
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
