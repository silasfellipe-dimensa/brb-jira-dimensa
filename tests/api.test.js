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
