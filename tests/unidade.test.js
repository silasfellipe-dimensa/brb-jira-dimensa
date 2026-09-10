// Testes de logica pura - sem rede, sem banco, deterministicos.
// Cada teste nomeia o bug que pegaria (testing-playbook R1).

process.env.ALLOWED_DOMAINS = 'dimensa.com.br,totvs.com.br,brb.com.br';
process.env.ALLOWED_EMAILS = 'convidado@parceiro.com';
process.env.SESSION_SECRET = 'segredo-de-teste-nao-usado-em-producao';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { emailPermitido, segredoConfere, criarSessao, lerSessao } = require('../auth');
const {
  mapearColunas, montarColunas, montarMetricas, epicoDe, ehSubtarefa
} = require('../jira');

describe('emailPermitido — quem pode entrar', () => {
  // Bug: alguem de fora dos dominios da equipe cria conta e le o board.
  test('aceita os dominios liberados', () => {
    assert.ok(emailPermitido('fulano@dimensa.com.br'));
    assert.ok(emailPermitido('fulano@totvs.com.br'));
    assert.ok(emailPermitido('cliente@brb.com.br'));
  });

  test('recusa dominio de fora', () => {
    assert.ok(!emailPermitido('invasor@gmail.com'));
    assert.ok(!emailPermitido('invasor@outraempresa.com.br'));
  });

  test('aceita e-mail avulso da allowlist', () => {
    assert.ok(emailPermitido('convidado@parceiro.com'));
  });

  test('ignora diferenca de maiuscula/minuscula', () => {
    assert.ok(emailPermitido('Fulano@DIMENSA.com.br'));
  });

  // Bug: "dimensa.com.br.invasor.com" terminaria com o dominio liberado se a
  // checagem fosse por "termina com" em vez de comparar o dominio inteiro.
  test('recusa dominio que apenas CONTEM o liberado', () => {
    assert.ok(!emailPermitido('x@dimensa.com.br.invasor.com'));
    assert.ok(!emailPermitido('x@naodimensa.com.br'));
    assert.ok(!emailPermitido('x@sub.dimensa.com.br'));
  });

  test('recusa entrada malformada sem quebrar', () => {
    assert.ok(!emailPermitido('sem-arroba'));
    assert.ok(!emailPermitido('@dimensa.com.br'.replace('@', '')));
    assert.ok(!emailPermitido(''));
  });
});

describe('segredoConfere — autenticacao do cron', () => {
  // Bug: comparacao frouxa deixaria o cron ser disparado por qualquer um.
  test('aceita o segredo exato', () => {
    assert.ok(segredoConfere('Bearer abc123', 'Bearer abc123'));
  });

  test('recusa segredo errado, vazio ou de tamanho diferente', () => {
    assert.ok(!segredoConfere('Bearer errado', 'Bearer abc123'));
    assert.ok(!segredoConfere('', 'Bearer abc123'));
    assert.ok(!segredoConfere(undefined, 'Bearer abc123'));
    assert.ok(!segredoConfere('Bearer abc123', ''));
  });

  test('recusa prefixo correto mas incompleto', () => {
    assert.ok(!segredoConfere('Bearer abc', 'Bearer abc123'));
  });
});

describe('sessao — assinatura do cookie', () => {
  // Bug: sessao forjada daria acesso ao board sem login.
  test('ida e volta preserva o e-mail', () => {
    const token = criarSessao({ email: 'fulano@dimensa.com.br' });
    assert.strictEqual(lerSessao(token).email, 'fulano@dimensa.com.br');
  });

  test('recusa token adulterado', () => {
    const token = criarSessao({ email: 'fulano@dimensa.com.br' });
    assert.strictEqual(lerSessao(token.slice(0, -3) + 'xyz'), null);
  });

  test('recusa lixo e vazio', () => {
    assert.strictEqual(lerSessao('nao-e-um-token'), null);
    assert.strictEqual(lerSessao(''), null);
  });
});

describe('mapearColunas — quais colunas aparecem', () => {
  const cfg = {
    columnConfig: {
      columns: [
        { name: 'BACKLOG', statuses: [{ id: 1 }] },
        { name: 'PLANEJADO', statuses: [{ id: 2 }] },
        { name: 'Em andamento', statuses: [{ id: 3 }, { id: 4 }] },
        { name: 'TESTE', statuses: [{ id: 5 }] }
      ]
    }
  };

  // Bug: coluna que deveria ficar oculta aparece no board publico.
  test('omite as colunas ocultas e mantem a ordem do Jira', () => {
    const { ordemColunas } = mapearColunas(cfg);
    assert.deepStrictEqual(ordemColunas, ['Em andamento', 'TESTE']);
  });

  test('mapeia todos os status da coluna, nao so o primeiro', () => {
    const { statusParaColuna } = mapearColunas(cfg);
    assert.strictEqual(statusParaColuna['3'], 'Em andamento');
    assert.strictEqual(statusParaColuna['4'], 'Em andamento');
  });

  test('nao mapeia status de coluna oculta', () => {
    const { statusParaColuna } = mapearColunas(cfg);
    assert.strictEqual(statusParaColuna['1'], undefined);
  });

  test('aguenta resposta vazia ou malformada do Jira', () => {
    assert.deepStrictEqual(mapearColunas({}).ordemColunas, []);
    assert.deepStrictEqual(mapearColunas({ columnConfig: {} }).ordemColunas, []);
  });
});

describe('montarColunas — onde cada card cai', () => {
  const ordem = ['Em andamento', 'TESTE'];
  const mapa = { '3': 'Em andamento', '5': 'TESTE' };

  const issues = [
    { fields: { summary: 'Task A', status: { id: 3 }, assignee: { accountId: 'u1', displayName: 'Ana', avatarUrls: { '48x48': 'http://a' } } } },
    { fields: { summary: 'Task B', status: { id: 5 }, assignee: null } },
    { fields: { summary: 'Task C', status: { id: 3 }, assignee: { accountId: 'u1', displayName: 'Ana', avatarUrls: { '48x48': 'http://a' } } } },
    // Status que nao pertence a nenhuma coluna visivel (ex: item no backlog).
    { fields: { summary: 'Task oculta', status: { id: 99 }, assignee: null } }
  ];

  // Bug: card aparecendo na coluna errada, ou item de coluna oculta vazando.
  test('coloca cada card na coluna do seu status', () => {
    const { colunas } = montarColunas(ordem, mapa, issues, true);
    assert.deepStrictEqual(colunas[0].cards.map((c) => c.titulo), ['Task A', 'Task C']);
    assert.deepStrictEqual(colunas[1].cards.map((c) => c.titulo), ['Task B']);
  });

  test('descarta issue cujo status nao esta em coluna visivel', () => {
    const { colunas } = montarColunas(ordem, mapa, issues, true);
    const todos = colunas.flatMap((c) => c.cards.map((x) => x.titulo));
    assert.ok(!todos.includes('Task oculta'));
  });

  test('deduplica a pessoa em vez de repetir a cada card', () => {
    const { pessoas } = montarColunas(ordem, mapa, issues, true);
    assert.strictEqual(Object.keys(pessoas).length, 1);
    assert.strictEqual(pessoas.u1.nome, 'Ana');
  });

  // Bug: virar a chave de privacidade e o nome continuar saindo no JSON.
  test('com mostrarResponsavel=false nao expoe pessoa alguma', () => {
    const { colunas, pessoas } = montarColunas(ordem, mapa, issues, false);
    assert.deepStrictEqual(pessoas, {});
    assert.ok(colunas.every((c) => c.cards.every((card) => card.pessoa === null)));
  });

  test('card sem responsavel fica com pessoa nula, sem quebrar', () => {
    const { colunas } = montarColunas(ordem, mapa, issues, true);
    assert.strictEqual(colunas[1].cards[0].pessoa, null);
  });

  test('coluna sem nenhuma issue vem vazia, nao some', () => {
    const { colunas } = montarColunas(['Em andamento', 'VAZIA'], mapa, issues, true);
    assert.strictEqual(colunas.length, 2);
    assert.deepStrictEqual(colunas[1].cards, []);
  });
});

/* ---------------------------------------------------------------------------
 * Agrupamento por epico.
 *
 * Os cenarios abaixo sao copias reduzidas do que o board 2587 devolve de
 * verdade - inclusive as armadilhas que so apareceram consultando o Jira:
 * o "Epic Name" preenchido como "BRB" e o parent que aponta para uma task.
 * ------------------------------------------------------------------------- */
describe('montarColunas — agrupamento por epico', () => {
  const ordem = ['Em andamento', 'TESTE', 'Itens concluídos'];
  const mapa = { '3': 'Em andamento', '5': 'TESTE', '9': 'Itens concluídos' };

  const EPICO = { key: 'JDCBEPIC-192', name: '', summary: '20260525007 - Efetivar portabilidade' };

  const tipoTask = { name: 'Participativo', subtask: false, hierarchyLevel: 0 };
  const tipoSub = { name: 'Code Review', subtask: true, hierarchyLevel: -1 };

  function issue(key, resumo, statusId, extra) {
    return Object.assign({
      key,
      fields: {
        summary: resumo,
        status: { id: statusId },
        assignee: null,
        issuetype: tipoTask
      }
    }, extra || {});
  }

  const issues = [
    // Duas tasks do mesmo epico, em colunas diferentes.
    (() => { const i = issue('T-1', 'DEV do portabilidade', 5); i.fields.epic = EPICO; return i; })(),
    (() => { const i = issue('T-2', 'MID do portabilidade', 9); i.fields.epic = EPICO; return i; })(),
    // Subtarefa: nao carrega epic, so o parent apontando para a task.
    (() => {
      const i = issue('S-1', 'Code Review - portabilidade', 9);
      i.fields.issuetype = tipoSub;
      i.fields.parent = { key: 'T-1' };
      return i;
    })(),
    // Task sem epico nenhum.
    issue('T-3', 'Solicitação de Correção — PRO/RET', 5)
  ];

  test('junta as tasks do mesmo epico num card so', () => {
    const { colunas } = montarColunas(ordem, mapa, issues, true);
    const todos = colunas.flatMap((c) => c.cards.map((x) => x.titulo));
    assert.strictEqual(todos.filter((t) => t === EPICO.summary).length, 1);
  });

  // Bug que isso trava: o epico pular para "concluido" com trabalho aberto.
  test('poe o epico na coluna MENOS avancada entre as tasks dele', () => {
    const { colunas } = montarColunas(ordem, mapa, issues, true);
    const emTeste = colunas[1].cards.map((c) => c.titulo);
    const concluidos = colunas[2].cards.map((c) => c.titulo);
    assert.ok(emTeste.includes(EPICO.summary));
    assert.ok(!concluidos.includes(EPICO.summary));
  });

  test('usa o summary do epico, nunca o Epic Name (que vem como "BRB")', () => {
    const poluido = { key: 'E-9', name: 'BRB', summary: '20260630008 - Corrigir simulação' };
    const um = issue('T-9', 'DEV', 3);
    um.fields.epic = poluido;
    const { colunas } = montarColunas(ordem, mapa, [um], true);
    assert.strictEqual(colunas[0].cards[0].titulo, '20260630008 - Corrigir simulação');
    assert.ok(!colunas.flatMap((c) => c.cards).some((c) => c.titulo === 'BRB'));
  });

  test('task sem epico continua aparecendo com o proprio nome', () => {
    const { colunas } = montarColunas(ordem, mapa, issues, true);
    const emTeste = colunas[1].cards.map((c) => c.titulo);
    assert.ok(emTeste.includes('Solicitação de Correção — PRO/RET'));
  });

  test('subtarefa nao vira card, mas entra no detalhe do epico', () => {
    const { colunas } = montarColunas(ordem, mapa, issues, true);
    const todos = colunas.flatMap((c) => c.cards.map((x) => x.titulo));
    assert.ok(!todos.includes('Code Review - portabilidade'));

    const card = colunas.flatMap((c) => c.cards).find((c) => c.epico === EPICO.key);
    assert.ok(card.tarefas.some((t) => t.chave === 'S-1' && t.subtarefa));
  });

  test('conta o progresso somando tarefas e subtarefas concluidas', () => {
    const { colunas } = montarColunas(ordem, mapa, issues, true);
    const card = colunas.flatMap((c) => c.cards).find((c) => c.epico === EPICO.key);
    assert.strictEqual(card.total, 3);
    assert.strictEqual(card.concluidas, 2);
  });

  test('subtarefa orfa (pai fora do board) nao vira card solto', () => {
    const orfa = issue('S-99', 'Atualização de Ambiente - BRB', 9);
    orfa.fields.issuetype = tipoSub;
    orfa.fields.parent = { key: 'NAO-EXISTE-1' };
    const { colunas } = montarColunas(ordem, mapa, [orfa], true);
    assert.deepStrictEqual(colunas.flatMap((c) => c.cards), []);
  });

  /* Armadilha real do board 2587: "Teste de Aceitação Concluído" e categoria
   * done no Jira, mas mora na coluna AGUARDANDO TERCEIROS. Se a categoria
   * mandasse, o card apareceria "6/6 concluídas" fora da coluna de concluídos. */
  test('conta pela coluna do board, nao pela categoria "done" do Jira', () => {
    const aceito = issue('T-7', 'Teste de Aceitação Concluído', 5);
    aceito.fields.status.statusCategory = { key: 'done' };
    const { colunas } = montarColunas(ordem, mapa, [aceito], true);
    assert.strictEqual(colunas[1].cards[0].concluidas, 0);
  });
});

describe('epicoDe / ehSubtarefa — leitura dos campos do Jira', () => {

  // Bug real: 43 das 61 issues do board tem como parent uma TASK, nao um
  // epico. Quem le o parent monta "epico" que na verdade e task.
  test('ignora o parent: epico so vem de fields.epic', () => {
    const comPaiTask = { fields: { parent: { key: 'JDCBBRB-191' } } };
    assert.strictEqual(epicoDe(comPaiTask), null);
  });

  test('prefere o summary ao name poluido', () => {
    const i = { fields: { epic: { key: 'E-1', name: 'BRB', summary: 'Nome bom' } } };
    assert.strictEqual(epicoDe(i).titulo, 'Nome bom');
  });

  test('cai para a chave se o epico vier sem texto algum', () => {
    const i = { fields: { epic: { key: 'E-1', name: '', summary: '' } } };
    assert.strictEqual(epicoDe(i).titulo, 'E-1');
  });

  test('reconhece subtarefa e aguenta issue sem issuetype', () => {
    assert.ok(ehSubtarefa({ fields: { issuetype: { subtask: true } } }));
    assert.ok(!ehSubtarefa({ fields: { issuetype: { subtask: false } } }));
    assert.ok(!ehSubtarefa({ fields: {} }));
  });
});

/* ---------------------------------------------------------------------------
 * Metricas do dashboard.
 *
 * Cenario montado com as caracteristicas reais do board 2587: item antigo que
 * atravessa sprints, escopo entrando no meio, subtarefa que nao deve inflar a
 * lista, e `updated` recente num item parado ha meses (o campo que robo de
 * apontamento de horas mexe).
 * ------------------------------------------------------------------------- */
describe('montarMetricas — numeros do sprint', () => {
  const ordem = ['Em andamento', 'TESTE', 'Itens concluídos'];
  const mapa = { '3': 'Em andamento', '5': 'TESTE', '9': 'Itens concluídos' };
  const AGORA = new Date('2026-09-10T12:00:00.000Z');
  const sprint = { startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-09-30T00:00:00.000Z' };

  const task = { name: 'História', subtask: false };
  const sub = { name: 'Code Review', subtask: true };

  function it_(key, statusId, opts) {
    opts = opts || {};
    return {
      key,
      fields: {
        summary: opts.titulo || key,
        status: { id: statusId },
        issuetype: opts.sub ? sub : task,
        assignee: opts.quem ? { displayName: opts.quem } : null,
        created: opts.criado || '2026-08-01T10:00:00.000Z',
        updated: opts.mexido || '2026-09-09T10:00:00.000Z',
        resolutiondate: opts.fim || null,
        statuscategorychangedate: opts.fase || null
      }
    };
  }

  const issues = [
    // Zumbi: parado desde junho, mas com `updated` de ontem (robô de horas).
    it_('Z-1', 3, { criado: '2026-06-21T10:00:00.000Z', fase: '2026-06-21T10:00:00.000Z', quem: 'Ana' }),
    it_('N-1', 5, { criado: '2026-09-05T10:00:00.000Z', quem: 'Bia' }),   // entrou no meio
    it_('S-1', 9, { sub: true, fim: '2026-09-08T10:00:00.000Z' }),        // subtarefa pronta
    it_('P-1', 9, { fim: '2026-09-02T10:00:00.000Z', quem: 'Ana' }),
    it_('P-2', 9, { fim: '2026-09-03T10:00:00.000Z', quem: 'Bia' })
  ];

  const m = montarMetricas(ordem, mapa, issues, sprint, AGORA, true);

  test('conta o relogio do sprint a partir das datas do Jira', () => {
    assert.strictEqual(m.relogio.totalDias, 29);
    assert.strictEqual(m.relogio.corridos, 9);
    // 10/09 12:00 -> 30/09 00:00 sao 19,5 dias, truncados para 19: dia contado
    // e dia inteiro disponivel, entao arredondar para cima prometeria tempo
    // que nao existe.
    assert.strictEqual(m.relogio.restantes, 19);
  });

  test('separa aberto de concluido pela ultima coluna', () => {
    assert.strictEqual(m.itens.total, 5);
    assert.strictEqual(m.itens.concluidos, 3);
    assert.strictEqual(m.itens.abertos, 2);
  });

  // O denominador crescendo no meio do caminho e o que faz "% concluido" andar
  // para tras sem ninguem errar nada.
  test('acusa escopo criado depois do inicio do sprint', () => {
    assert.strictEqual(m.escopoNovo.qtd, 1);
    assert.strictEqual(m.escopoNovo.itens[0].chave, 'N-1');
  });

  test('mede idade pelo created, ignorando o updated contaminado', () => {
    const zumbi = m.aging.find((a) => a.chave === 'Z-1');
    assert.strictEqual(zumbi.diasAberto, 81);   // desde 21/06, nao desde ontem
    assert.strictEqual(zumbi.diasNaFase, 81);   // statuscategorychangedate
  });

  /* Ordenar por idade poria no topo um item que nasceu ha meses e comecou
   * ontem - que nao e problema nenhum. O que urge e tempo TRAVADO na fase. */
  test('ordena pelo tempo na fase, nao pela idade do item', () => {
    const velhoParado = it_('V-1', 3, {
      criado: '2026-06-01T10:00:00.000Z', fase: '2026-06-01T10:00:00.000Z'
    });
    const velhoRecemComecado = it_('V-2', 3, {
      criado: '2026-05-01T10:00:00.000Z', fase: '2026-09-09T10:00:00.000Z'
    });
    const r = montarMetricas(ordem, mapa, [velhoRecemComecado, velhoParado], sprint, AGORA, true);

    assert.strictEqual(r.aging[0].chave, 'V-1');   // 101 dias travado
    assert.strictEqual(r.aging[1].chave, 'V-2');   // mais antigo, mas so 1 dia na fase
    assert.ok(r.aging[1].diasAberto > r.aging[0].diasAberto);
  });

  test('cai para a idade quando o Jira nao manda a data da fase', () => {
    const semFase = it_('F-1', 3, { criado: '2026-08-01T10:00:00.000Z' });
    const r = montarMetricas(ordem, mapa, [semFase], sprint, AGORA, true);
    assert.strictEqual(r.aging[0].diasNaFase, null);
    assert.strictEqual(r.aging[0].diasAberto, 40);
  });

  test('marca subtarefa, para o dashboard poder deixar de fora', () => {
    const abertos = m.aging.map((a) => a.chave);
    assert.ok(!abertos.includes('S-1'));  // ela esta concluida, nem entra
    const todas = montarMetricas(ordem, mapa, [it_('S-9', 3, { sub: true })], sprint, AGORA, true);
    assert.strictEqual(todas.aging[0].subtarefa, true);
  });

  test('agrupa a vazao por semana de conclusao', () => {
    const total = m.vazao.reduce((s, x) => s + x.qtd, 0);
    assert.strictEqual(total, 3);
    assert.ok(m.vazao.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.semana)));
  });

  test('preve pela vazao, nunca por story point (que ninguem preenche)', () => {
    assert.ok(m.previsao.vazaoMedia > 0);
    assert.strictEqual(m.previsao.devemFechar + m.previsao.escorregam, m.itens.abertos);
  });

  test('nao promete fechar mais itens do que existem em aberto', () => {
    const rapido = montarMetricas(ordem, mapa, issues.concat([
      it_('X-1', 9, { fim: '2026-09-01T10:00:00.000Z' }),
      it_('X-2', 9, { fim: '2026-09-01T11:00:00.000Z' }),
      it_('X-3', 9, { fim: '2026-09-01T12:00:00.000Z' })
    ]), sprint, AGORA, true);
    assert.ok(rapido.previsao.devemFechar <= rapido.itens.abertos);
    assert.ok(rapido.previsao.escorregam >= 0);
  });

  test('conta a fila de cada coluna, inclusive as vazias', () => {
    assert.deepStrictEqual(m.wip.map((w) => w.coluna), ordem);
    assert.strictEqual(m.wip.find((w) => w.coluna === 'Em andamento').qtd, 1);
  });

  // Mesma regra de privacidade do board: virou a chave, nao sai nome nenhum.
  test('com mostrarResponsavel=false nao expoe pessoa alguma', () => {
    const sem = montarMetricas(ordem, mapa, issues, sprint, AGORA, false);
    assert.deepStrictEqual(sem.carga, []);
    assert.ok(sem.aging.every((a) => a.pessoa === null));
  });

  test('aguenta sprint sem datas sem quebrar', () => {
    const semData = montarMetricas(ordem, mapa, issues, {}, AGORA, true);
    assert.strictEqual(semData.relogio, null);
    assert.strictEqual(semData.escopoNovo.qtd, 0);
  });
});

describe('serieEscopo — curva de crescimento do sprint', () => {
  const ordem = ['Em andamento'];
  const mapa = { '3': 'Em andamento' };
  const sprint = { startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-09-30T00:00:00.000Z' };
  const tipo = { name: 'História', subtask: false };
  const mk = (k, criado) => ({
    key: k,
    fields: { summary: k, status: { id: 3 }, issuetype: tipo, assignee: null, created: criado }
  });

  const issues = [
    mk('velha-1', '2026-08-20T10:00:00.000Z'),
    mk('velha-2', '2026-08-21T10:00:00.000Z'),
    mk('nova-1', '2026-09-03T10:00:00.000Z'),
    mk('nova-2', '2026-09-03T15:00:00.000Z'),
    mk('nova-3', '2026-09-07T10:00:00.000Z')
  ];
  const m = montarMetricas(ordem, mapa, issues, sprint, new Date('2026-09-08T12:00:00.000Z'), true);
  const s = m.escopoNovo.serie;

  test('parte do que o sprint ja tinha ao comecar', () => {
    assert.strictEqual(m.escopoNovo.base, 2);
    assert.strictEqual(s[0].total, 2);
  });

  test('acumula: a curva so sobe, nunca desce', () => {
    for (let i = 1; i < s.length; i++) assert.ok(s[i].total >= s[i - 1].total);
    assert.strictEqual(s[s.length - 1].total, 5);
  });

  test('marca em que dia cada item entrou', () => {
    const dia3 = s.find((x) => x.dia === '2026-09-03');
    assert.strictEqual(dia3.entraram, 2);
    assert.strictEqual(s.find((x) => x.dia === '2026-09-04').entraram, 0);
  });

  // Bug real: somar 24h a partir da meia-noite passava de "hoje" quando agora
  // era de manha, e a curva ganhava um dia no futuro.
  test('para em hoje, nunca desenha dia futuro', () => {
    assert.strictEqual(s[s.length - 1].dia, '2026-09-08');
  });

  test('sprint sem data nao gera serie, em vez de quebrar', () => {
    const sem = montarMetricas(ordem, mapa, issues, {}, new Date(), true);
    assert.deepStrictEqual(sem.escopoNovo.serie, []);
  });

  test('lista os itens novos do mais recente para o mais antigo', () => {
    assert.deepStrictEqual(m.escopoNovo.itens.map((i) => i.chave), ['nova-3', 'nova-2', 'nova-1']);
  });
});

/* Bug real do sprint Setembro: 22 itens nasceram depois do inicio, mas 16 eram
 * Codificacao / Code Review / Documento Tecnico de demandas que JA estavam no
 * sprint. Contar os 22 juntos transformava 6 demandas em um alarme de 25%. */
describe('escopoNovo — demanda pactuada vs desdobramento interno', () => {
  const ordem = ['Em andamento'];
  const mapa = { '3': 'Em andamento' };
  const sprint = { startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-09-30T00:00:00.000Z' };
  const AGORA = new Date('2026-09-10T12:00:00.000Z');
  const task = { name: 'História', subtask: false };
  const sub = { name: 'Code Review', subtask: true };

  const mk = (k, criado, ehSub) => ({
    key: k,
    fields: {
      summary: k, status: { id: 3 }, assignee: null,
      issuetype: ehSub ? sub : task, created: criado
    }
  });

  const issues = [
    mk('base-1', '2026-08-10T10:00:00.000Z', false),
    mk('base-2', '2026-08-11T10:00:00.000Z', false),
    mk('nova-1', '2026-09-05T10:00:00.000Z', false),
    mk('sub-1', '2026-09-06T10:00:00.000Z', true),
    mk('sub-2', '2026-09-06T11:00:00.000Z', true),
    mk('sub-3', '2026-09-07T10:00:00.000Z', true)
  ];
  const e = montarMetricas(ordem, mapa, issues, sprint, AGORA, true).escopoNovo;

  test('conta demanda e desdobramento separadamente', () => {
    assert.strictEqual(e.qtd, 4);            // tudo que nasceu depois
    assert.strictEqual(e.demandas, 1);       // so a de nivel 0
    assert.strictEqual(e.desdobramentos, 3);
  });

  // 4 de 6 seriam 67%; a demanda nova e 1 de 3, isto e, 33%.
  test('mede o percentual sobre demandas, nao sobre tudo', () => {
    assert.strictEqual(e.pctDemandas, 33);
    assert.notStrictEqual(e.pctDemandas, e.pct);
  });

  test('marca cada item como subtarefa ou nao, com o tipo do Jira', () => {
    const s1 = e.itens.find((i) => i.chave === 'sub-1');
    assert.strictEqual(s1.subtarefa, true);
    assert.strictEqual(s1.tipo, 'Code Review');
    assert.strictEqual(e.itens.find((i) => i.chave === 'nova-1').subtarefa, false);
  });

  test('a curva segue contando tudo: o volume de trabalho cresceu de fato', () => {
    assert.strictEqual(e.serie[e.serie.length - 1].total, 6);
  });
});
