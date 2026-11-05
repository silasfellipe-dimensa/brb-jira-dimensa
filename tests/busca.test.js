// Painel "Buscar no Jira" (static/busca.js): botão flutuante em todas as telas
// da equipe. Leitura estática + a regra de escolha do modo rodada à parte.

process.env.ALLOWED_DOMAINS = 'dimensa.com.br,totvs.com.br,brb.com.br,evertecinc.com.br';
process.env.SESSION_SECRET = 'segredo-de-teste-nao-usado-em-producao';
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_ANON_KEY = 'chave-de-teste';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'chave-de-servico-de-teste';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const codigo = fs.readFileSync(path.join(__dirname, '..', 'static', 'busca.js'), 'utf8');

/** A função modoPara, tirada do arquivo para rodar sem navegador. */
const modoPara = new Function(codigo.match(/function modoPara\(t\) \{[\s\S]*?\n  \}/)[0] + '; return modoPara;')();

describe('static/busca.js', () => {
  test('número, task ou termo curto -> exata; mensagem colada -> ampla', () => {
    assert.strictEqual(modoPara('2026110141'), 'exata');
    assert.strictEqual(modoPara('TTB - 2026110141'), 'exata');
    assert.strictEqual(modoPara('JDCBBRB-420'), 'exata');
    assert.strictEqual(modoPara('BDCF 89.01'), 'exata');
    assert.strictEqual(modoPara('a PCRA2_CARGA está gravando duplicado'), 'ampla');
    assert.strictEqual(modoPara('linha 1\nlinha 2'), 'ampla');
    assert.strictEqual(modoPara('x'.repeat(81)), 'ampla');
  });

  // Bug: a tela inteira ficou com o layout antigo (abas) enquanto o painel tinha
  // um campo só - a escolha do modo tem que ser a mesma nos dois.
  test('tela inteira escolhe o modo com a mesma regra do painel, sem abas', () => {
    const tela = fs.readFileSync(path.join(__dirname, '..', 'paginas', 'pesquisa.html'), 'utf8');
    const regra = (s) => s.match(/function modoPara\(t\) \{[\s\S]*?\n\s*\}/)[0].replace(/\s+/g, ' ');
    assert.strictEqual(regra(tela), regra(codigo));
    assert.ok(!tela.includes('role="tablist"'));
  });

  test('não aparece na tela inteira (/pesquisa) nem duas vezes', () => {
    assert.match(codigo, /if \(window\.Busca\) return;/);
    assert.match(codigo, /if \(window\.location\.pathname === '\/pesquisa'\) return;/);
  });

  test('tudo da API passa por esc(); link só https', () => {
    assert.match(codigo, /function href\(url\) \{ return \/\^https:\\\/\\\/\/\.test/);
    for (const campo of ['i.resumo', 'i.chave', 'r.termo', 'e.termo', 'p.nome', 't.termo', 'd.nome', 'e.nome']) {
      const cru = new RegExp(`'\\s*\\+\\s*${campo.replace('.', '\\.')}\\s*\\+`);
      assert.ok(!cru.test(codigo), `${campo} entra no HTML sem esc()`);
    }
  });

  test('a mensagem do cliente não vai pela URL nem fica guardada: só o termo curto da exata', () => {
    assert.match(codigo, /fetch\('\/api\/pesquisa\/ampla', \{ method: 'POST'/);
    assert.match(codigo, /if \(m === 'exata'\) \{ guardarRecente\(t\);/);
    assert.ok(!/localStorage\.setItem\([^)]*campo/.test(codigo));
    // Para a tela inteira, a mensagem vai pela aba (sessionStorage) e é apagada ao ler.
    const tela = fs.readFileSync(path.join(__dirname, '..', 'paginas', 'pesquisa.html'), 'utf8');
    assert.match(tela, /sessionStorage\.removeItem\('pesquisa-ampla-texto'\)/);
  });

  test('aviso de ruído na ampla; Esc fecha; "/" não rouba a tecla de quem está digitando', () => {
    assert.match(codigo, /<b>Pesquisa ampla:<\/b>[^']*podem ter ruído/);
    assert.match(codigo, /ev\.key === 'Escape'/);
    assert.match(codigo, /\^\(INPUT\|TEXTAREA\|SELECT\)\$/);
  });
});

describe('servidor', () => {
  const app = require('../server');
  let servidor; let base;
  before(async () => { await new Promise((r) => { servidor = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${servidor.address().port}`; });
  after(() => servidor && servidor.close());

  test('/busca.js responde como JavaScript e sempre revalidando', async () => {
    const r = await fetch(`${base}/busca.js`);
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
    assert.match(r.headers.get('cache-control'), /no-cache/);
  });
});
