// Menu do topo (static/menu.js), igual em todas as telas. Leitura estática,
// como os testes do diálogo: o que quebra em silêncio é uma tela nova sem o
// menu, ou uma tela voltando a ter botões próprios no topo.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.ALLOWED_DOMAINS = 'dimensa.com.br,brb.com.br,evertecinc.com.br,totvs.com.br';
process.env.SESSION_SECRET = 'segredo-de-teste-nao-usado-em-producao';
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_ANON_KEY = 'chave-de-teste';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'chave-de-servico-de-teste';
process.env.HUB_URL = 'https://portal.exemplo/';
process.env.QUALIDADE_URL = 'https://qualidade.exemplo/';

const PAGINAS = path.join(__dirname, '..', 'paginas');
// tela -> item que fica de fora do menu ('' = nenhum: tela que não é item)
const TELAS = {
  'index.html': 'kanban',
  'demandas.html': 'demandas',
  'demandas-historico.html': '',
  'expedicoes.html': 'expedicoes',
  'dashboard.html': 'dashboard',
  'admin.html': ''
};

describe('todas as telas usam o menu único', () => {
  for (const [tela, atual] of Object.entries(TELAS)) {
    const html = fs.readFileSync(path.join(PAGINAS, tela), 'utf8');

    test(`${tela}: tem <nav data-menu="${atual}"> no topo e carrega /menu.js`, () => {
      assert.ok(html.includes(`<nav data-menu="${atual}"></nav>`));
      assert.ok(html.includes('<script src="/menu.js"></script>'));
      assert.ok(html.indexOf('<nav data-menu') < html.indexOf('</header>'), 'o menu fica dentro do <header>');
    });

    test(`${tela}: sem os botões de navegação antigos no topo`, () => {
      assert.ok(!/Voltar ao board|Voltar às demandas|id="linkExpedicoes"|id="linkAdmin"|id="btnSair"/.test(html));
    });
  }

  test('o Admin não aparece no menu de nenhuma tela (fica só no Portal)', () => {
    const codigo = fs.readFileSync(path.join(__dirname, '..', 'static', 'menu.js'), 'utf8');
    assert.ok(!codigo.includes("href: '/admin'"));
  });
});

describe('static/menu.js', () => {
  const codigo = fs.readFileSync(path.join(__dirname, '..', 'static', 'menu.js'), 'utf8');

  test('ordem igual à do Portal: Kanban BRB, Demandas, Expedições, Dashboard, Qualidade', () => {
    const ordem = ['kanban', 'demandas', 'expedicoes', 'dashboard', 'qualidade'].map((id) => codigo.indexOf(`{ id: '${id}'`));
    assert.ok(ordem.every((i) => i > 0));
    assert.deepStrictEqual([...ordem].sort((a, b) => a - b), ordem);
  });

  test('a tela atual não aparece no próprio menu', () => {
    assert.match(codigo, /if \(i\.id === atual\) return;/);
  });

  test('Qualidade só aparece quando o servidor manda o endereço; o link é o /ir/qualidade (leva o passe)', () => {
    assert.match(codigo, /id: 'qualidade'[^}]*href: '\/ir\/qualidade'[^}]*externo: 'qualidadeUrl'/);
    assert.match(codigo, /if \(i\.externo && !\(eu && eu\[i\.externo\]\)\) return;/);
  });

  test('Expedições só para a equipe (editor)', () => {
    assert.match(codigo, /id: 'expedicoes'[^}]*soEquipe: true/);
    assert.match(codigo, /if \(i\.soEquipe && !\(eu && eu\.editor\)\) return;/);
  });

  test('e-mail entra por textContent; endereço do Portal só com http(s)', () => {
    assert.match(codigo, /el\('span', 'menux-email', eu\.email\)/);
    assert.match(codigo, /u\.protocol === 'https:' \|\| u\.protocol === 'http:'/);
    // innerHTML só com o que o próprio arquivo escreve (ícones e rótulos fixos)
    assert.ok(!/innerHTML[^;]*eu\./.test(codigo));
  });
});

describe('servidor', () => {
  const app = require('../server');
  const { criarSessao, COOKIE_NAME } = require('../auth');
  let servidor; let base;
  before(async () => { await new Promise((r) => { servidor = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${servidor.address().port}`; });
  after(() => servidor && servidor.close());
  const eu = async (email) => (await fetch(`${base}/api/eu`, { headers: { Cookie: `${COOKIE_NAME}=${criarSessao({ email })}` } })).json();

  test('/menu.js responde sem login, como JavaScript, e sempre revalidando', async () => {
    const r = await fetch(`${base}/menu.js`);
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
    assert.match(r.headers.get('cache-control'), /no-cache/);
    assert.match(await r.text(), /window\.Menu/);
  });

  // O BRB é mandado do Portal direto para o Kanban: o atalho para lá seria um vaivém.
  test('Portal: aparece para Dimensa, Evertec e TOTVS; não para o BRB', async () => {
    assert.strictEqual((await eu('fulano@dimensa.com.br')).hubUrl, process.env.HUB_URL);
    assert.strictEqual((await eu('fulano@evertecinc.com.br')).hubUrl, process.env.HUB_URL);
    assert.strictEqual((await eu('fulano@totvs.com.br')).hubUrl, process.env.HUB_URL);
    assert.strictEqual((await eu('cliente@brb.com.br')).hubUrl, null);
    assert.strictEqual((await eu('CLIENTE@BRB.COM.BR')).hubUrl, null);
  });

  // Mesma regra do cartão do Qualidade no Portal (DOMINIOS_QUALIDADE do hub).
  test('Qualidade: aparece para Dimensa, Evertec e BRB; não para TOTVS', async () => {
    assert.strictEqual((await eu('fulano@dimensa.com.br')).qualidadeUrl, process.env.QUALIDADE_URL);
    assert.strictEqual((await eu('fulano@evertecinc.com.br')).qualidadeUrl, process.env.QUALIDADE_URL);
    assert.strictEqual((await eu('cliente@brb.com.br')).qualidadeUrl, process.env.QUALIDADE_URL);
    assert.strictEqual((await eu('fulano@totvs.com.br')).qualidadeUrl, null);
  });

  test('Expedições: editor só para Dimensa e Evertec', async () => {
    assert.strictEqual((await eu('fulano@dimensa.com.br')).editor, true);
    assert.strictEqual((await eu('fulano@evertecinc.com.br')).editor, true);
    assert.strictEqual((await eu('cliente@brb.com.br')).editor, false);
    assert.strictEqual((await eu('fulano@totvs.com.br')).editor, false);
  });
});
