// Testes de logica pura - sem rede, sem banco, deterministicos.
// Cada teste nomeia o bug que pegaria (testing-playbook R1).

process.env.ALLOWED_DOMAINS = 'dimensa.com.br,totvs.com.br,brb.com.br';
process.env.ALLOWED_EMAILS = 'convidado@parceiro.com';
process.env.SESSION_SECRET = 'segredo-de-teste-nao-usado-em-producao';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { emailPermitido, segredoConfere, criarSessao, lerSessao } = require('../auth');
const { mapearColunas, montarColunas } = require('../jira');

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
