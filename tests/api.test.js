// Testes de API - provam os controles de acesso do servidor.
//
// Deterministicos: nenhuma chamada de rede real acontece. O Supabase aponta
// para 127.0.0.1:1, que recusa conexao imediatamente, e todos os caminhos
// testados ou sao rejeitados ANTES de qualquer chamada externa, ou tratam a
// falha de forma prevista.

process.env.ALLOWED_DOMAINS = 'dimensa.com.br,totvs.com.br,brb.com.br,evertecinc.com.br';
process.env.ALLOWED_EMAILS = '';
process.env.SESSION_SECRET = 'segredo-de-teste-nao-usado-em-producao';
process.env.CRON_SECRET = 'cron-de-teste';
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_ANON_KEY = 'chave-de-teste';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'chave-de-servico-de-teste';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const app = require('../server');
const { criarSessao, COOKIE_NAME } = require('../auth');

let servidor;
let base;

before(async () => {
  await new Promise((resolve) => {
    servidor = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(() => servidor && servidor.close());

const cookieValido = () => `${COOKIE_NAME}=${criarSessao({ email: 'fulano@dimensa.com.br' })}`;

function pedir(caminho, opcoes = {}) {
  return fetch(base + caminho, { redirect: 'manual', ...opcoes });
}

// Editar so quem e Dimensa ou Evertec; BRB (e TOTVS) so visualiza.
const cookieEditor = () => `${COOKIE_NAME}=${criarSessao({ email: 'editor@dimensa.com.br' })}`;
const cookieLeitor = () => `${COOKIE_NAME}=${criarSessao({ email: 'cliente@brb.com.br' })}`;

function enviarJson(metodo, caminho, corpo, cookie) {
  return pedir(caminho, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: corpo === undefined ? undefined : JSON.stringify(corpo)
  });
}

function postarJson(caminho, corpo, cabecalhos = {}) {
  return pedir(caminho, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cabecalhos },
    body: JSON.stringify(corpo)
  });
}

describe('portao de acesso — sem sessao ninguem entra', () => {
  // Bug: o board ficar acessivel sem login. Ja aconteceu duas vezes neste
  // projeto (RLS permissiva e arquivos estaticos servidos pela Vercel),
  // entao este e o teste mais importante da suite.
  test('a pagina do board redireciona para o login', async () => {
    const r = await pedir('/');
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.get('location'), '/login.html');
  });

  test('a API de dados responde 401', async () => {
    const r = await pedir('/api/dados');
    assert.strictEqual(r.status, 401);
  });

  test('a API de identidade responde 401', async () => {
    const r = await pedir('/api/eu');
    assert.strictEqual(r.status, 401);
  });

  test('a atualizacao manual responde 401', async () => {
    const r = await pedir('/api/atualizar', { method: 'POST' });
    assert.strictEqual(r.status, 401);
  });

  test('cookie de sessao forjado com outro segredo nao entra', async () => {
    const r = await pedir('/api/dados', { headers: { Cookie: `${COOKIE_NAME}=token.forjado.aqui` } });
    assert.strictEqual(r.status, 401);
  });

  test('a tela de login continua publica', async () => {
    const r = await pedir('/login.html');
    assert.strictEqual(r.status, 200);
  });
});

describe('portao de acesso — com sessao valida', () => {
  test('a API de identidade devolve o e-mail da sessao', async () => {
    const r = await pedir('/api/eu', { headers: { Cookie: cookieValido() } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).email, 'fulano@dimensa.com.br');
  });

  // Bug: banco fora do ar derrubar a pagina ou vazar o erro do Postgres.
  test('com o banco indisponivel, devolve estado vazio em vez de erro cru', async () => {
    const r = await pedir('/api/dados', { headers: { Cookie: cookieValido() } });
    assert.strictEqual(r.status, 200);
    const corpo = await r.json();
    assert.strictEqual(corpo.vazio, true);
    const texto = JSON.stringify(corpo);
    assert.ok(!/127\.0\.0\.1|ECONNREFUSED|stack|supabase/i.test(texto), 'nao pode vazar detalhe interno');
  });
});

describe('planejamento — validacao e portao de acesso', () => {
  test('sem sessao responde 401', async () => {
    const r = await pedir('/api/planejamento?sprintId=123');
    assert.strictEqual(r.status, 401);
  });

  test('sem sprintId responde 400', async () => {
    const r = await pedir('/api/planejamento', { headers: { Cookie: cookieValido() } });
    assert.strictEqual(r.status, 400);
  });

  test('sprintId nao numerico responde 400', async () => {
    const r = await pedir('/api/planejamento?sprintId=abc', { headers: { Cookie: cookieValido() } });
    assert.strictEqual(r.status, 400);
  });

  // Bug: banco fora do ar derrubar a rota em vez de responder algo tratado.
  test('com o banco indisponivel, planejamento devolve nulo em vez de erro cru', async () => {
    const r = await pedir('/api/planejamento?sprintId=123', { headers: { Cookie: cookieValido() } });
    assert.strictEqual(r.status, 200);
    const corpo = await r.json();
    assert.strictEqual(corpo.planejamento, null);
    assert.strictEqual(corpo.carryOverEntregue, 0);
  });

  test('a serie historica responde 200 mesmo com o banco fora do ar', async () => {
    const r = await pedir('/api/planejamento/serie', { headers: { Cookie: cookieValido() } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual((await r.json()).serie, []);
  });
});

describe('demandas — quem ve, quem edita', () => {
  const vazamento = /127\.0\.0\.1|ECONNREFUSED|stack|supabase|postgres/i;

  test('sem sessao: pagina redireciona e a API responde 401 em todos os verbos', async () => {
    const pagina = await pedir('/demandas');
    assert.strictEqual(pagina.status, 302);
    assert.strictEqual(pagina.headers.get('location'), '/login.html');
    const edicao = await pedir('/demandas/editar');
    assert.strictEqual(edicao.status, 302);
    assert.strictEqual(edicao.headers.get('location'), '/login.html');
    assert.strictEqual((await pedir('/api/demandas')).status, 401);
    assert.strictEqual((await enviarJson('POST', '/api/demandas', { mes: '2026-10' })).status, 401);
    assert.strictEqual((await enviarJson('PATCH', '/api/demandas/1', { nome: 'x' })).status, 401);
    assert.strictEqual((await enviarJson('DELETE', '/api/demandas/1')).status, 401);
  });

  // Bug que isto pega: alguem do BRB conseguir gravar ponto pago chamando a
  // API direto, mesmo sem o botao aparecer na tela.
  test('BRB nao grava, em nenhum verbo (nao edita, nao inclui, nao remove)', async () => {
    const cookie = cookieLeitor();
    const criar = await enviarJson('POST', '/api/demandas', { mes: '2026-10' }, cookie);
    const alterar = await enviarJson('PATCH', '/api/demandas/1', { nome: 'x' }, cookie);
    const remover = await enviarJson('DELETE', '/api/demandas/1', undefined, cookie);
    [criar, alterar, remover].forEach((r) => assert.strictEqual(r.status, 403));
  });

  test('TOTVS tambem so visualiza; Dimensa e Evertec passam do guard', async () => {
    const totvs = `${COOKIE_NAME}=${criarSessao({ email: 'fulano@totvs.com.br' })}`;
    const evertec = `${COOKIE_NAME}=${criarSessao({ email: 'fulano@evertecinc.com.br' })}`;
    assert.strictEqual((await enviarJson('POST', '/api/demandas', { mes: '2026-10' }, totvs)).status, 403);
    // com o banco fora do ar o guard passa e a falha vira 500 (nao 403)
    assert.strictEqual((await enviarJson('POST', '/api/demandas', { mes: '2026-10' }, evertec)).status, 500);
    assert.strictEqual((await enviarJson('POST', '/api/demandas', { mes: '2026-10' }, cookieValido())).status, 500);
  });

  // A pagina de edicao nao esconde: encaminha quem nao edita para a
  // visualizacao, que mostra o mesmo dado.
  test('pagina de edicao: BRB vai para a visualizacao, editor abre', async () => {
    const leitor = await pedir('/demandas/editar', { headers: { Cookie: cookieLeitor() } });
    assert.strictEqual(leitor.status, 302);
    assert.strictEqual(leitor.headers.get('location'), '/demandas');
    const editor = await pedir('/demandas/editar', { headers: { Cookie: cookieEditor() } });
    assert.strictEqual(editor.status, 200);
    const visualizacao = await pedir('/demandas', { headers: { Cookie: cookieEditor() } });
    assert.strictEqual(visualizacao.status, 200, 'editor tambem pode abrir a visualizacao');
  });

  // Quem so visualiza nao pode nem LER o historico: ele traz e-mails da equipe
  // e valores de cobranca, inclusive de demandas excluidas.
  test('historico: sem sessao 401 e redireciona; BRB e TOTVS levam 403 na API e vao para /demandas na pagina', async () => {
    assert.strictEqual((await pedir('/api/demandas/historico')).status, 401);
    assert.strictEqual((await pedir('/demandas/historico')).headers.get('location'), '/login.html');
    const totvs = `${COOKIE_NAME}=${criarSessao({ email: 'fulano@totvs.com.br' })}`;
    for (const cookie of [cookieLeitor(), totvs]) {
      assert.strictEqual((await pedir('/api/demandas/historico', { headers: { Cookie: cookie } })).status, 403);
      assert.strictEqual((await pedir('/api/demandas/historico?demanda=1', { headers: { Cookie: cookie } })).status, 403);
      const pagina = await pedir('/demandas/historico', { headers: { Cookie: cookie } });
      assert.strictEqual(pagina.status, 302);
      assert.strictEqual(pagina.headers.get('location'), '/demandas');
    }
  });

  test('historico: editor abre a pagina; filtro invalido responde 400; banco fora vira 503 sem vazar detalhe', async () => {
    const cookie = cookieEditor();
    assert.strictEqual((await pedir('/demandas/historico', { headers: { Cookie: cookie } })).status, 200);
    assert.strictEqual((await pedir('/api/demandas/historico?demanda=abc', { headers: { Cookie: cookie } })).status, 400);
    assert.strictEqual((await pedir('/api/demandas/historico?mes=2026-13', { headers: { Cookie: cookie } })).status, 400);
    const r = await pedir('/api/demandas/historico', { headers: { Cookie: cookie } });
    assert.strictEqual(r.status, 503);
    assert.ok(!vazamento.test(JSON.stringify(await r.json())));
  });

  // O guard compara o dominio inteiro. Tentar passar por Dimensa/Evertec com
  // um e-mail parecido nao pode abrir nenhuma escrita nem o historico.
  test('e-mails parecidos com Dimensa/Evertec nao editam nem leem o historico', async () => {
    for (const email of ['x@naodimensa.com.br', 'x@sub.dimensa.com.br', 'x@dimensa.com.br.invasor.com', 'x@evertecinc.com', '@dimensa.com.br', 'a@b@dimensa.com.br']) {
      const cookie = `${COOKIE_NAME}=${criarSessao({ email })}`;
      const respostas = [
        await enviarJson('POST', '/api/demandas', { mes: '2026-10' }, cookie),
        await enviarJson('PATCH', '/api/demandas/1', { nome: 'x' }, cookie),
        await enviarJson('DELETE', '/api/demandas/1', undefined, cookie),
        await pedir('/api/demandas/historico', { headers: { Cookie: cookie } })
      ];
      respostas.forEach((r) => assert.strictEqual(r.status, 403, `${email} deveria levar 403, veio ${r.status}`));
      const editar = await pedir('/demandas/editar', { headers: { Cookie: cookie } });
      assert.strictEqual(editar.headers.get('location'), '/demandas', `${email} nao pode abrir a edicao`);
    }
  });

  test('cookie adulterado ou de outra assinatura nao vale como sessao de editor', async () => {
    const valido = cookieEditor();
    const adulterado = valido.slice(0, -3) + (valido.endsWith('abc') ? 'xyz' : 'abc');
    for (const cookie of [adulterado, `${COOKIE_NAME}=nao-e-um-token`]) {
      assert.strictEqual((await enviarJson('PATCH', '/api/demandas/1', { nome: 'x' }, cookie)).status, 401);
      assert.strictEqual((await pedir('/api/demandas/historico', { headers: { Cookie: cookie } })).status, 401);
    }
  });

  /* ---- Expedicoes: controle interno do time. BRB e TOTVS nem veem. ---- */
  const ROTAS_EXPEDICAO = [
    ['GET', '/api/expedicoes'],
    ['GET', '/api/expedicoes/opcoes'],
    ['POST', '/api/expedicoes', { jira: 'JDCBBRB-1' }],
    ['PATCH', '/api/expedicoes/1', { nome: 'x' }],
    ['DELETE', '/api/expedicoes/1'],
    ['GET', '/api/expedicoes/excluidas'],
    ['POST', '/api/expedicoes/1/restaurar'],
    ['POST', '/api/expedicoes/1/itens', { bloco: 'expedir', texto: 'item novo' }],
    ['PATCH', '/api/expedicoes/1/itens/1', { estado: 'concluido' }],
    ['DELETE', '/api/expedicoes/1/itens/1'],
    ['PATCH', '/api/expedicoes/1/itens/1/observacao', { observacao: 'nota' }],
    ['PATCH', '/api/expedicoes/1', { pontosFuncao: '3' }]
  ];

  test('expedicoes: sem sessao 401 em toda rota e a pagina manda para o login', async () => {
    for (const [metodo, caminho, corpo] of ROTAS_EXPEDICAO) {
      assert.strictEqual((await enviarJson(metodo, caminho, corpo)).status, 401, `${metodo} ${caminho}`);
    }
    assert.strictEqual((await pedir('/expedicoes')).headers.get('location'), '/login.html');
  });

  test('expedicoes: BRB e TOTVS levam 403 em TODA rota (ler e gravar) e a pagina volta para o board', async () => {
    const totvs = `${COOKIE_NAME}=${criarSessao({ email: 'fulano@totvs.com.br' })}`;
    for (const cookie of [cookieLeitor(), totvs]) {
      for (const [metodo, caminho, corpo] of ROTAS_EXPEDICAO) {
        assert.strictEqual((await enviarJson(metodo, caminho, corpo, cookie)).status, 403, `${metodo} ${caminho}`);
      }
      const pagina = await pedir('/expedicoes', { headers: { Cookie: cookie } });
      assert.strictEqual(pagina.status, 302);
      assert.strictEqual(pagina.headers.get('location'), '/');
    }
  });

  test('expedicoes: e-mails parecidos com Dimensa/Evertec tambem levam 403', async () => {
    for (const email of ['x@naodimensa.com.br', 'x@sub.dimensa.com.br', 'x@dimensa.com.br.invasor.com', 'x@evertecinc.com']) {
      const cookie = `${COOKIE_NAME}=${criarSessao({ email })}`;
      for (const [metodo, caminho, corpo] of ROTAS_EXPEDICAO) {
        assert.strictEqual((await enviarJson(metodo, caminho, corpo, cookie)).status, 403, `${email} ${metodo} ${caminho}`);
      }
      assert.strictEqual((await pedir('/expedicoes', { headers: { Cookie: cookie } })).headers.get('location'), '/');
    }
  });

  test('expedicoes: editor abre a pagina; entrada invalida responde 400 antes de tocar no banco', async () => {
    const cookie = cookieEditor();
    assert.strictEqual((await pedir('/expedicoes', { headers: { Cookie: cookie } })).status, 200);
    const ruins = [
      ['POST', '/api/expedicoes', {}],
      ['POST', '/api/expedicoes', { nome: '   ' }],
      ['POST', '/api/expedicoes', { nome: 'x', dataExpedicao: '2026-02-31' }],
      ['PATCH', '/api/expedicoes/abc', { nome: 'x' }],
      ['PATCH', '/api/expedicoes/1', { removido: true }],
      ['PATCH', '/api/expedicoes/1', { dataExpedicao: 'amanha' }],
      ['DELETE', '/api/expedicoes/0'],
      ['POST', '/api/expedicoes/abc/restaurar'],
      ['POST', '/api/expedicoes/1/itens', { bloco: 'outro', texto: 'abc' }],
      ['POST', '/api/expedicoes/1/itens', { bloco: 'expedir', texto: 'ab' }],
      ['POST', '/api/expedicoes/x/itens', { bloco: 'expedir', texto: 'abc' }],
      ['PATCH', '/api/expedicoes/1/itens/1', { estado: 'feito' }],
      ['PATCH', '/api/expedicoes/1/itens/1', { estado: 'nao_aplicavel' }],
      ['PATCH', '/api/expedicoes/1/itens/1', { estado: 'nao_aplicavel', justificativa: 'curto' }],
      ['PATCH', '/api/expedicoes/1/itens/abc', { estado: 'concluido' }],
      ['DELETE', '/api/expedicoes/1/itens/abc'],
      ['PATCH', '/api/expedicoes/1/itens/1/observacao', {}],
      ['PATCH', '/api/expedicoes/1/itens/1/observacao', { observacao: 123 }],
      ['PATCH', '/api/expedicoes/1/itens/1/observacao', { observacao: 'x'.repeat(1001) }],
      ['PATCH', '/api/expedicoes/abc/itens/1/observacao', { observacao: 'nota' }],
      ['PATCH', '/api/expedicoes/1/itens/0/observacao', { observacao: 'nota' }],
      ['PATCH', '/api/expedicoes/1', { pontosFuncao: 'abc' }],
      ['PATCH', '/api/expedicoes/1', { pontosFuncao: -2 }],
      ['POST', '/api/expedicoes', { nome: 'x', pontosFuncao: '1,234' }]
    ];
    for (const [metodo, caminho, corpo] of ruins) {
      assert.strictEqual((await enviarJson(metodo, caminho, corpo, cookie)).status, 400, `${metodo} ${caminho} ${JSON.stringify(corpo)}`);
    }
    const r = await enviarJson('PATCH', '/api/expedicoes/1/itens/1', { estado: 'nao_aplicavel' }, cookie);
    assert.match((await r.json()).erro, /Explique brevemente/);
  });

  test('expedicoes: com o banco fora do ar, listar vira 503 e gravar vira 500, sem vazar detalhe', async () => {
    const cookie = cookieEditor();
    const lista = await enviarJson('GET', '/api/expedicoes', undefined, cookie);
    assert.strictEqual(lista.status, 503);
    assert.ok(!vazamento.test(JSON.stringify(await lista.json())));
    for (const [metodo, caminho, corpo] of [
      // tres rotas bastam: cada chamada recusada demora alguns segundos no Windows
      ['POST', '/api/expedicoes', { artefatoJira: 'JDCBBRB-1' }],
      ['DELETE', '/api/expedicoes/1'],
      ['PATCH', '/api/expedicoes/1/itens/1', { estado: 'concluido' }]
    ]) {
      const r = await enviarJson(metodo, caminho, corpo, cookie);
      assert.strictEqual(r.status, 500, `${metodo} ${caminho}`);
      assert.ok(!vazamento.test(JSON.stringify(await r.json())));
    }
  });

  test('filtro por meses invalido responde 400 antes de tocar no banco', async () => {
    const cookie = cookieValido();
    for (const q of ['?meses=abc', '?meses=', '?meses=2026-13', '?meses=2026-10,x', '?meses=2026-10&meses=2026-09']) {
      const r = await pedir('/api/demandas' + q, { headers: { Cookie: cookie } });
      assert.strictEqual(r.status, 400, `${q} deveria ser 400, veio ${r.status}`);
    }
  });

  test('filtro por meses valido passa na validacao (e o banco fora do ar vira 503)', async () => {
    const r = await pedir('/api/demandas?meses=2026-09,2026-10', { headers: { Cookie: cookieValido() } });
    assert.strictEqual(r.status, 503);
  });

  test('criar linha exige um mes valido', async () => {
    const cookie = cookieEditor();
    for (const corpo of [undefined, {}, { mes: '' }, { mes: '2026-13' }, { mes: 'outubro' }, { mes: 202610 }]) {
      const r = await enviarJson('POST', '/api/demandas', corpo, cookie);
      assert.strictEqual(r.status, 400, `corpo ${JSON.stringify(corpo)} deveria ser 400, veio ${r.status}`);
    }
  });

  test('a identidade informa quem e editor e quem so visualiza', async () => {
    const viewer = await (await pedir('/api/eu', { headers: { Cookie: cookieLeitor() } })).json();
    const editor = await (await pedir('/api/eu', { headers: { Cookie: cookieEditor() } })).json();
    assert.strictEqual(viewer.editor, false);
    assert.strictEqual(editor.editor, true);
  });

  test('com o banco indisponivel, listar responde 503 sem vazar detalhe', async () => {
    const r = await pedir('/api/demandas', { headers: { Cookie: cookieValido() } });
    assert.strictEqual(r.status, 503);
    const corpo = await r.json();
    assert.ok(corpo.erro);
    assert.ok(!vazamento.test(JSON.stringify(corpo)));
  });

  test('editor: id invalido e corpo invalido respondem 400 antes de tocar no banco', async () => {
    const cookie = cookieEditor();
    assert.strictEqual((await enviarJson('PATCH', '/api/demandas/abc', { nome: 'x' }, cookie)).status, 400);
    assert.strictEqual((await enviarJson('DELETE', '/api/demandas/0', undefined, cookie)).status, 400);
    assert.strictEqual((await enviarJson('PATCH', '/api/demandas/1', { teste: 'abc' }, cookie)).status, 400);
    assert.strictEqual((await enviarJson('PATCH', '/api/demandas/1', { removido: true }, cookie)).status, 400);
    const r = await enviarJson('PATCH', '/api/demandas/1', { pontosTotal: 'talvez' }, cookie);
    assert.match((await r.json()).erro, /Pontos de Função/);
  });

  test('editor com o banco indisponivel: erro tratado, sem vazar detalhe', async () => {
    const cookie = cookieEditor();
    for (const r of [
      await enviarJson('POST', '/api/demandas', { mes: '2026-10' }, cookie),
      await enviarJson('PATCH', '/api/demandas/1', { nome: 'x' }, cookie),
      await enviarJson('DELETE', '/api/demandas/1', undefined, cookie)
    ]) {
      assert.strictEqual(r.status, 500);
      const corpo = await r.json();
      assert.ok(corpo.erro);
      assert.ok(!vazamento.test(JSON.stringify(corpo)));
    }
  });
});

describe('cron — so o agendador dispara', () => {
  // Bug: qualquer um forcar a atualizacao do board descobrindo a URL.
  test('sem o segredo responde 401', async () => {
    assert.strictEqual((await pedir('/api/cron-atualizar')).status, 401);
  });

  test('com segredo errado responde 401', async () => {
    const r = await pedir('/api/cron-atualizar', { headers: { Authorization: 'Bearer errado' } });
    assert.strictEqual(r.status, 401);
  });

  test('cookie de usuario nao serve para o cron', async () => {
    const r = await pedir('/api/cron-atualizar', { headers: { Cookie: cookieValido() } });
    assert.strictEqual(r.status, 401);
  });
});

describe('cadastro — barreira de dominio e senha', () => {
  // Bug: alguem de fora da Dimensa/TOTVS/BRB criar conta e ver o board.
  test('recusa dominio fora da lista', async () => {
    const r = await postarJson('/auth/cadastro', { email: 'invasor@gmail.com', senha: 'senhalonga123' });
    assert.strictEqual(r.status, 403);
  });

  // Bug: dominio hostil que apenas PARECE com o liberado. Os tres casos
  // pegam falhas diferentes: "naodimensa" pega comparacao por "termina
  // com", "sub." pega aceitar subdominio, e o sufixo pega "contem".
  test('recusa dominio parecido com o liberado', async () => {
    for (const email of ['x@naodimensa.com.br', 'x@sub.dimensa.com.br', 'x@dimensa.com.br.invasor.com']) {
      const r = await postarJson('/auth/cadastro', { email, senha: 'senhalonga123' });
      assert.strictEqual(r.status, 403, `deveria recusar ${email}`);
    }
  });

  // Bug: contornar o minlength do formulario chamando a API direto.
  test('recusa senha curta mesmo com dominio valido', async () => {
    const r = await postarJson('/auth/cadastro', { email: 'fulano@dimensa.com.br', senha: '1234567' });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).erro, /8 caracteres/);
  });

  test('recusa campos ausentes', async () => {
    assert.strictEqual((await postarJson('/auth/cadastro', { email: 'a@dimensa.com.br' })).status, 400);
    assert.strictEqual((await postarJson('/auth/cadastro', { senha: 'senhalonga123' })).status, 400);
    assert.strictEqual((await postarJson('/auth/cadastro', {})).status, 400);
  });

  test('recusa login sem campos', async () => {
    assert.strictEqual((await postarJson('/auth/entrar', {})).status, 400);
  });
});

describe('respostas nao vazam internals', () => {
  // Bug: mensagem de erro entregando caminho da API do Jira, id do board,
  // estado do token ou stack trace para quem esta sondando.
  test('401 do cron vem sem detalhe tecnico', async () => {
    const texto = await (await pedir('/api/cron-atualizar')).text();
    assert.ok(!/stack|jira|rest\/agile|token|supabase/i.test(texto));
  });

  test('403 do cadastro vem sem detalhe tecnico', async () => {
    const texto = await (await postarJson('/auth/cadastro', { email: 'x@gmail.com', senha: 'senhalonga123' })).text();
    assert.ok(!/stack|supabase|postgres|127\.0\.0\.1/i.test(texto));
  });
});

describe('cabecalhos de seguranca', () => {
  // Bug: perder um cabecalho numa refatoracao e so descobrir em auditoria.
  test('estao presentes em toda resposta', async () => {
    const h = (await pedir('/login.html')).headers;
    assert.strictEqual(h.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(h.get('x-frame-options'), 'DENY');
    assert.strictEqual(h.get('referrer-policy'), 'no-referrer');
    assert.match(h.get('content-security-policy'), /frame-ancestors 'none'/);
  });

  test('rotas de API nao ficam em cache', async () => {
    const h = (await pedir('/api/dados')).headers;
    assert.strictEqual(h.get('cache-control'), 'no-store');
  });
});

describe('limite de tentativas', () => {
  // Bug: forca bruta de senha sem nenhuma barreira.
  test('bloqueia com 429 depois de 10 tentativas', async () => {
    let status429 = false;
    for (let i = 0; i < 15; i++) {
      const r = await postarJson(
        '/auth/entrar',
        { email: 'alvo@dimensa.com.br', senha: `tentativa${i}` },
        { 'x-forwarded-for': '203.0.113.77' } // IP fixo e proprio deste teste
      );
      if (r.status === 429) { status429 = true; break; }
    }
    assert.ok(status429, 'deveria ter bloqueado antes da 15a tentativa');
  });
});
