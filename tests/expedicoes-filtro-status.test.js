// Expedições: filtro por status. A tela abre só com o que ainda pede trabalho
// (em andamento + atrasadas); concluídas só aparecem quando alguém filtra.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'paginas', 'expedicoes.html'), 'utf8');

/** Roda as funções de status da página de verdade, com um estado de teste. */
function regras(status) {
  const trecho = (de, ate) => html.slice(html.indexOf(de), html.indexOf(ate, html.indexOf(de)));
  const codigo =
    trecho('function concluida(e)', '\n') + '\n' +
    trecho('var STATUS = [', '/* Quantas o filtro');
  const ctx = { estado: { status } };
  vm.runInNewContext(codigo, ctx);
  return ctx;
}

const exp = (grupo, pendentes, total = 16) => ({ grupo, progresso: { total, pendentes } });
const ATRASADA = exp('atrasadas', 1);
const ANDAMENTO = exp('proximas', 3);
const CONCLUIDA = exp('hoje', 0);
const CONCLUIDA_VENCIDA = exp('atrasadas', 0);

test('a tela começa em "Em andamento e atrasadas", e isso não é lembrado entre visitas', () => {
  assert.match(html, /status: 'abertas',/);
  assert.ok(!/localStorage\.[a-zA-Z]+\('expedicoes\.status/.test(html), 'o filtro de status não deve ser guardado');
});

test('status de cada expedição: concluída vence a data', () => {
  const r = regras('todas');
  assert.strictEqual(r.statusDe(ATRASADA), 'atrasada');
  assert.strictEqual(r.statusDe(ANDAMENTO), 'andamento');
  assert.strictEqual(r.statusDe(CONCLUIDA), 'concluida');
  assert.strictEqual(r.statusDe(CONCLUIDA_VENCIDA), 'concluida');
  assert.strictEqual(r.statusDe(exp('proximas', 0, 0)), 'andamento', 'sem itens não é concluída');
});

test('cada opção do filtro mostra o que promete', () => {
  const todas = [ATRASADA, ANDAMENTO, CONCLUIDA, CONCLUIDA_VENCIDA];
  const mostra = (status) => todas.filter(regras(status).passaStatus);
  assert.deepStrictEqual(mostra('abertas'), [ATRASADA, ANDAMENTO]);
  assert.deepStrictEqual(mostra('andamento'), [ANDAMENTO]);
  assert.deepStrictEqual(mostra('atrasada'), [ATRASADA]);
  assert.deepStrictEqual(mostra('concluida'), [CONCLUIDA, CONCLUIDA_VENCIDA]);
  assert.deepStrictEqual(mostra('todas'), todas);
});

test('as concluídas escondidas são avisadas e levam até elas', () => {
  assert.match(html, /<label for="selStatus">Status<\/label><select id="selStatus">/);
  assert.match(html, /data-acao="ver-concluidas"/);
  assert.match(html, /Escolha "Concluídas" no filtro Status para vê-las\./);
  assert.ok(!html.includes('ocultarConc'), 'a caixa "Ocultar concluídas" foi substituída pelo filtro');
});
