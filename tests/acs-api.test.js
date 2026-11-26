// Rotas da tela "Demandas" (ACS): quem vê, e quem pode mandar carga.
//
// Determinístico, como o api.test.js: o Supabase aponta para 127.0.0.1:1
// (recusa a conexão na hora). O que se prova aqui é o portão - cada pedido é
// barrado ANTES do banco, ou passa do portão e a falha do banco vira 503.

process.env.ALLOWED_DOMAINS = 'dimensa.com.br,totvs.com.br,brb.com.br,evertecinc.com.br';
process.env.ALLOWED_EMAILS = '';
process.env.SESSION_SECRET = 'segredo-de-teste-nao-usado-em-producao';
process.env.CRON_SECRET = 'cron-de-teste';
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_ANON_KEY = 'chave-de-teste';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'chave-de-servico-de-teste';
// gerado na hora: nenhum segredo, nem de teste, fica escrito no repositório
const SEGREDO = require('node:crypto').randomBytes(32).toString('hex');
process.env.ACS_COLETOR_SEGREDO = SEGREDO;

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const app = require('../server');
const { criarSessao, COOKIE_NAME } = require('../auth');
const { assinar } = require('../acs');

let servidor;
let base;

before(async () => {
  await new Promise((resolve) => { servidor = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});
after(() => servidor && servidor.close());

const cookie = (email) => `${COOKIE_NAME}=${criarSessao({ email })}`;
const EQUIPE = ['fulano@dimensa.com.br', 'fulano@evertecinc.com.br'];
const DE_FORA = ['cliente@brb.com.br', 'fulano@totvs.com.br'];
const vazamento = /127\.0\.0\.1|ECONNREFUSED|stack|supabase|postgres/i;

function pedir(caminho, opcoes = {}) {
  return fetch(base + caminho, { redirect: 'manual', ...opcoes });
}

/** Pedido como o coletor faz: timestamp + assinatura do corpo. */
function comoColetor(metodo, caminho, corpo, mudancas = {}) {
  const texto = corpo === undefined ? undefined : JSON.stringify(corpo);
  const timestamp = mudancas.timestamp || String(Math.floor(Date.now() / 1000));
  const assinatura = mudancas.assinatura || assinar(mudancas.segredo || SEGREDO, {
    timestamp, metodo, caminho: mudancas.caminhoAssinado || caminho, corpo: texto ? Buffer.from(mudancas.corpoAssinado || texto) : undefined
  });
  return pedir(caminho, {
    method: metodo,
    headers: {
      ...(texto ? { 'Content-Type': 'application/json' } : {}),
      'X-Coletor-Timestamp': timestamp,
      'X-Coletor-Assinatura': assinatura
    },
    body: texto
  });
}

const solicitacao = (numero) => ({
  SQ_SOLICITACAO: numero, SISSIGLA: 'TTB', DS_STATUS_SOLICITACAO: 'EM EXECUÇÃO', ST_SOLICITACAO: 'X',
  DS_RESUMO: 'Resumo de teste', DT_IMPLANTACAO: '29/10/2026', DT_SOLICITACAO: '11/05/2026',
  DT_PREVISAO_INICIO: '27/05/2026', DT_PREVISAO_TERMINO: '26/06/2026', NO_GESTOR_NEGOCIO: 'FULANA', NR_GESTOR_NEGOCIO: 1
});

describe('tela Demandas (ACS) — só a equipe vê', () => {
  test('sem sessão: página vai para o login, API responde 401', async () => {
    const pagina = await pedir('/demandas');
    assert.strictEqual(pagina.status, 302);
    assert.strictEqual(pagina.headers.get('location'), '/login.html');
    assert.strictEqual((await pedir('/api/acs')).status, 401);
    assert.strictEqual((await pedir('/api/acs/atualizar', { method: 'POST' })).status, 401);
  });

  // Bug que isto pega: BRB/TOTVS lendo a lista do ACS (nome de gestor, dado
  // interno) chamando a API direto, mesmo sem o item aparecer no menu.
  test('BRB e TOTVS: página volta para o board e a API responde 403', async () => {
    for (const email of DE_FORA) {
      const c = { Cookie: cookie(email) };
      const pagina = await pedir('/demandas', { headers: c });
      assert.strictEqual(pagina.status, 302, email);
      assert.strictEqual(pagina.headers.get('location'), '/', email);
      assert.strictEqual((await pedir('/api/acs', { headers: c })).status, 403, email);
      assert.strictEqual((await pedir('/api/acs/atualizar', { method: 'POST', headers: c })).status, 403, email);
    }
  });

  test('Dimensa e Evertec abrem a página nova (a do ACS, não a de Pontos de Função)', async () => {
    for (const email of EQUIPE) {
      const r = await pedir('/demandas', { headers: { Cookie: cookie(email) } });
      assert.strictEqual(r.status, 200, email);
      const html = await r.text();
      assert.ok(html.includes('/api/acs'), 'a página servida é a do ACS');
      assert.strictEqual(r.headers.get('cache-control'), 'no-cache');
    }
  });

  test('com o banco fora do ar, a equipe recebe 503/500 sem vazar detalhe', async () => {
    const c = { Cookie: cookie(EQUIPE[0]) };
    const lista = await pedir('/api/acs', { headers: c });
    assert.strictEqual(lista.status, 503);
    const pedido = await pedir('/api/acs/atualizar', { method: 'POST', headers: c });
    assert.strictEqual(pedido.status, 500);
    for (const r of [lista, pedido]) {
      const corpo = await r.json();
      assert.ok(corpo.erro);
      assert.ok(!vazamento.test(JSON.stringify(corpo)));
    }
  });

  test('a tela não usa pop-up do navegador e escapa o que vem do ACS', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'paginas', 'demandas-acs.html'), 'utf8');
    assert.deepStrictEqual(html.match(/(^|[^.\w])(confirm|alert|prompt)\(/g) || [], []);
    // todo campo de texto do ACS passa por esc() antes de virar HTML
    for (const campo of ['s.numero', 's.status', 's.resumo', 's.gestor']) {
      assert.ok(html.includes(`esc(${campo})`), `${campo} sem esc()`);
    }
  });
});

describe('coletor do ACS — só entra pedido assinado', () => {
  const ROTAS = [['GET', '/api/acs/coletor/tarefa', undefined], ['POST', '/api/acs/coletor/carga', { solicitacoes: [solicitacao(1)] }]];

  test('sem cabeçalhos de assinatura: 401', async () => {
    for (const [metodo, caminho, corpo] of ROTAS) {
      const r = await pedir(caminho, {
        method: metodo,
        headers: corpo ? { 'Content-Type': 'application/json' } : {},
        body: corpo ? JSON.stringify(corpo) : undefined
      });
      assert.strictEqual(r.status, 401, caminho);
    }
  });

  // Bug que isto pega: a sessão de um usuário logado servir para mandar carga.
  test('sessão de usuário (mesmo da equipe) não substitui a assinatura', async () => {
    const r = await pedir('/api/acs/coletor/carga', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie(EQUIPE[0]) },
      body: JSON.stringify({ solicitacoes: [solicitacao(1)] })
    });
    assert.strictEqual(r.status, 401);
  });

  test('assinatura com outro segredo: 401', async () => {
    for (const [metodo, caminho, corpo] of ROTAS) {
      const r = await comoColetor(metodo, caminho, corpo, { segredo: require('node:crypto').randomBytes(32).toString('hex') });
      assert.strictEqual(r.status, 401, caminho);
    }
  });

  test('corpo trocado depois de assinado: 401', async () => {
    const r = await comoColetor('POST', '/api/acs/coletor/carga', { solicitacoes: [solicitacao(2)] },
      { corpoAssinado: JSON.stringify({ solicitacoes: [solicitacao(1)] }) });
    assert.strictEqual(r.status, 401);
  });

  test('assinatura de uma rota não serve na outra: 401', async () => {
    const r = await comoColetor('GET', '/api/acs/coletor/tarefa', undefined, { caminhoAssinado: '/api/acs/coletor/carga' });
    assert.strictEqual(r.status, 401);
  });

  test('pedido velho (10 minutos atrás) é recusado: 401', async () => {
    const velho = String(Math.floor(Date.now() / 1000) - 600);
    for (const [metodo, caminho, corpo] of ROTAS) {
      assert.strictEqual((await comoColetor(metodo, caminho, corpo, { timestamp: velho })).status, 401, caminho);
    }
  });

  test('assinatura certa passa do portão (e o banco fora do ar vira 503, sem vazar detalhe)', async () => {
    const tarefa = await comoColetor('GET', '/api/acs/coletor/tarefa');
    assert.strictEqual(tarefa.status, 503);
    const carga = await comoColetor('POST', '/api/acs/coletor/carga', { solicitacoes: [solicitacao(1), solicitacao(2)] });
    assert.strictEqual(carga.status, 503);
    const falha = await comoColetor('POST', '/api/acs/coletor/carga', { erro: 'ACS respondeu 401' });
    assert.strictEqual(falha.status, 503);
    for (const r of [tarefa, carga, falha]) assert.ok(!vazamento.test(JSON.stringify(await r.json())));
  });

  test('carga assinada mas inválida (lista vazia, item torto) responde 400', async () => {
    for (const corpo of [{ solicitacoes: [] }, { solicitacoes: [{ SQ_SOLICITACAO: 'x' }] }, {}]) {
      const r = await comoColetor('POST', '/api/acs/coletor/carga', corpo);
      assert.strictEqual(r.status, 400, JSON.stringify(corpo));
    }
  });

  test('a carga aceita uma lista grande (o limite de 10kb das outras rotas não vale aqui)', async () => {
    const muitas = Array.from({ length: 400 }, (_, i) => solicitacao(1000 + i));
    assert.ok(JSON.stringify({ solicitacoes: muitas }).length > 100 * 1024);
    const r = await comoColetor('POST', '/api/acs/coletor/carga', { solicitacoes: muitas });
    assert.strictEqual(r.status, 503, 'passou da leitura do corpo e da validação; parou só no banco');
  });

  test('sem ACS_COLETOR_SEGREDO no ambiente, nem a assinatura certa passa', async () => {
    delete process.env.ACS_COLETOR_SEGREDO;
    try {
      assert.strictEqual((await comoColetor('GET', '/api/acs/coletor/tarefa')).status, 401);
    } finally {
      process.env.ACS_COLETOR_SEGREDO = SEGREDO;
    }
  });
});

describe('tela Produção PF — só a equipe vê', () => {
  test('sem sessão: página vai para o login, API responde 401', async () => {
    const pagina = await pedir('/producao');
    assert.strictEqual(pagina.status, 302);
    assert.strictEqual(pagina.headers.get('location'), '/login.html');
    assert.strictEqual((await pedir('/api/producao')).status, 401);
  });

  test('BRB e TOTVS: página volta para o board e a API responde 403', async () => {
    for (const email of DE_FORA) {
      const c = { Cookie: cookie(email) };
      const pagina = await pedir('/producao', { headers: c });
      assert.strictEqual(pagina.status, 302, email);
      assert.strictEqual(pagina.headers.get('location'), '/', email);
      assert.strictEqual((await pedir('/api/producao', { headers: c })).status, 403, email);
    }
  });

  test('Dimensa e Evertec abrem a página; com o banco fora do ar a API dá 503 sem vazar detalhe', async () => {
    for (const email of EQUIPE) {
      const c = { Cookie: cookie(email) };
      const r = await pedir('/producao', { headers: c });
      assert.strictEqual(r.status, 200, email);
      assert.ok((await r.text()).includes('/api/producao'));
      const api = await pedir('/api/producao', { headers: c });
      assert.strictEqual(api.status, 503);
      assert.ok(!vazamento.test(JSON.stringify(await api.json())));
    }
  });

  test('a tela não usa pop-up do navegador e escapa o texto que vem do ACS', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'paginas', 'producao-pf.html'), 'utf8');
    assert.deepStrictEqual(html.match(/(^|[^.\w])(confirm|alert|prompt)\(/g) || [], []);
    for (const campo of ['c.resumo', 'c.numero', 'c.atividade', 'c.faseNome']) assert.ok(html.includes(`esc(${campo}`), `${campo} sem esc()`);
  });

  test('carga com extras assinada passa do portão (e para só no banco)', async () => {
    const r = await comoColetor('POST', '/api/acs/coletor/carga', {
      solicitacoes: [solicitacao(1)], implantadas: [], sustentacoes: [{ SQ_SUSTENTACAO: 'torto' }], contrato: { lixo: true }
    });
    assert.strictEqual(r.status, 503);
  });
});
