// Caixas de diálogo do sistema (static/dialogo.js) no lugar dos pop-ups do
// navegador. Leitura estática, como os outros testes de interface: o que
// quebra em silêncio é alguém voltar a usar confirm()/alert() numa tela nova,
// ou a tela perder o arquivo do diálogo.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.ALLOWED_DOMAINS = 'dimensa.com.br,brb.com.br,evertecinc.com.br';
process.env.SESSION_SECRET = 'segredo-de-teste-nao-usado-em-producao';
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_ANON_KEY = 'chave-de-teste';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'chave-de-servico-de-teste';

const PAGINAS = path.join(__dirname, '..', 'paginas');
// telas que perguntam algo ao usuário
const TELAS = ['demandas.html', 'expedicoes.html', 'admin.html'];

describe('telas usam o diálogo do sistema, não o pop-up do navegador', () => {
  for (const tela of TELAS) {
    const html = fs.readFileSync(path.join(PAGINAS, tela), 'utf8');

    test(`${tela}: carrega /dialogo.js antes do script da tela`, () => {
      const dialogo = html.indexOf('<script src="/dialogo.js"></script>');
      const proprio = html.indexOf('<script>');
      assert.ok(dialogo >= 0, 'falta <script src="/dialogo.js">');
      assert.ok(dialogo < proprio, '/dialogo.js precisa vir antes do script da tela');
    });

    test(`${tela}: nenhum confirm()/alert() solto (só a reserva window.confirm/window.alert)`, () => {
      const solto = html.match(/(^|[^.\w])(confirm|alert|prompt)\(/g) || [];
      assert.deepStrictEqual(solto, [], `pop-up nativo encontrado: ${solto.join(' ')}`);
      // a reserva (o arquivo do diálogo não carregou) pode usar window.prompt/confirm/alert; solto, nunca
    });

    test(`${tela}: usa Dlg.confirmar/avisar`, () => {
      assert.match(html, /Dlg\.(confirmar|avisar)\(/);
    });
  }

  test('a reserva (arquivo não carregou) cai no navegador em vez de quebrar a tela', () => {
    for (const tela of TELAS) {
      const html = fs.readFileSync(path.join(PAGINAS, tela), 'utf8');
      assert.match(html, /var Dlg = window\.Dialogo \|\|/);
    }
  });
});

describe('static/dialogo.js', () => {
  const codigo = fs.readFileSync(path.join(__dirname, '..', 'static', 'dialogo.js'), 'utf8');

  test('não interpreta HTML do usuário: texto entra só por textContent', () => {
    // innerHTML só para o ícone fixo (SVG escrito no próprio arquivo)
    const usos = codigo.match(/innerHTML/g) || [];
    assert.strictEqual(usos.length, 1);
    assert.match(codigo, /icone\.innerHTML = '<svg/);
  });

  test('exclusão começa com o foco em Cancelar', () => {
    assert.match(codigo, /tom === 'perigo' && cancelar \? cancelar : ok/);
  });

  test('usa <dialog> nativo, para ficar acima de outras caixas abertas (como o formulário de ocorrência)', () => {
    assert.match(codigo, /showModal/);
  });
});

describe('rota pública /dialogo.js', () => {
  const app = require('../server');
  let servidor; let base;
  before(async () => { await new Promise((r) => { servidor = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${servidor.address().port}`; });
  after(() => servidor && servidor.close());

  test('responde sem login, como JavaScript, e sempre revalidando', async () => {
    const r = await fetch(`${base}/dialogo.js`);
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
    assert.match(r.headers.get('cache-control'), /no-cache/);
    assert.match(await r.text(), /window\.Dialogo/);
  });
});
