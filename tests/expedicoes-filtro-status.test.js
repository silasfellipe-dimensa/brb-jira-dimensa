// Expedições: filtro por status. A tela abre só com o que ainda pede trabalho
// (em andamento + atrasadas); concluídas só aparecem quando alguém filtra, e o
// próprio filtro diz quantas há em cada opção.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'paginas', 'expedicoes.html'), 'utf8');

/** Roda as funções de status da página de verdade, com um estado de teste. */
function regras(estado) {
  const trecho = (de, ate) => html.slice(html.indexOf(de), html.indexOf(ate, html.indexOf(de)));
  const codigo =
    trecho('function concluida(e)', '\n') + '\n' +
    trecho('function doResponsavel(e)', 'function atualizarContagens');
  const ctx = { estado: Object.assign({ status: 'abertas', filtro: '', expedicoes: [] }, estado) };
  vm.runInNewContext(codigo, ctx);
  return ctx;
}

const exp = (grupo, pendentes, nome = 'ana', total = 16) =>
  ({ grupo, progresso: { total, pendentes }, responsavel: { nome } });
const ATRASADA = exp('atrasadas', 1);
const ANDAMENTO = exp('proximas', 3);
const CONCLUIDA = exp('hoje', 0);
const CONCLUIDA_VENCIDA = exp('atrasadas', 0);
const TODAS = [ATRASADA, ANDAMENTO, CONCLUIDA, CONCLUIDA_VENCIDA];

test('a tela começa em "Em andamento e atrasadas", e isso não é lembrado entre visitas', () => {
  assert.match(html, /status: 'abertas',/);
  assert.ok(!/localStorage\.[a-zA-Z]+\('expedicoes\.status/.test(html), 'o filtro de status não deve ser guardado');
});

test('status de cada expedição: concluída vence a data', () => {
  const r = regras();
  assert.strictEqual(r.statusDe(ATRASADA), 'atrasada');
  assert.strictEqual(r.statusDe(ANDAMENTO), 'andamento');
  assert.strictEqual(r.statusDe(CONCLUIDA), 'concluida');
  assert.strictEqual(r.statusDe(CONCLUIDA_VENCIDA), 'concluida');
  assert.strictEqual(r.statusDe(exp('proximas', 0, 'ana', 0)), 'andamento', 'sem itens não é concluída');
});

test('cada opção do filtro mostra o que promete', () => {
  const mostra = (status) => regras({ status, expedicoes: TODAS }).visiveis();
  assert.deepStrictEqual(mostra('abertas'), [ATRASADA, ANDAMENTO]);
  assert.deepStrictEqual(mostra('andamento'), [ANDAMENTO]);
  assert.deepStrictEqual(mostra('atrasada'), [ATRASADA]);
  assert.deepStrictEqual(mostra('concluida'), [CONCLUIDA, CONCLUIDA_VENCIDA]);
  assert.deepStrictEqual(mostra('todas'), TODAS);
});

test('a contagem de cada opção respeita o filtro de responsável', () => {
  const r = regras({ filtro: 'ana', expedicoes: TODAS.concat([exp('hoje', 0, 'bia')]) });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.contagemStatus())),
    { abertas: 2, andamento: 1, atrasada: 1, concluida: 2, todas: 4, excluidas: 0 });
});

// 2026-11-19: "Excluídas" é uma opção do filtro, vinda de outra consulta. Não
// entra em "Todas" (todas = as ativas) e o número vem do servidor.
test('"Excluídas" no filtro: nenhuma ativa passa nele; o número vem do servidor', () => {
  const r = regras({ expedicoes: TODAS });
  assert.deepStrictEqual(regras({ status: 'excluidas', expedicoes: TODAS }).visiveis(), []);
  assert.strictEqual(r.STATUS[r.STATUS.length - 1].valor, 'excluidas');
  assert.match(html, /c\.excluidas = estado\.excluidas \? estado\.excluidas\.length : estado\.qtdExcluidas;/);
  assert.match(html, /if \(estado\.status === 'excluidas'\) return carregarExcluidas\(\);/);
  assert.match(html, /data-acao="restaurar"/);
});

test('excluir pede o motivo (menos expedição em branco); "Outro" exige explicação', () => {
  assert.match(html, /titulo: 'Por que excluir esta expedição\?'/);
  assert.match(html, /tipo: 'escolha', opcoes: MOTIVOS_EXCLUSAO/);
  assert.match(html, /v\.escolha === 'Outro' && String\(v\.texto \|\| ''\)\.trim\(\)\.length < 10/);
  assert.match(html, /chamar\('DELETE', '\/api\/expedicoes\/' \+ e\.id, \{ motivo: textoMotivo\(v\) \}\)/);
});

test('a contagem fica no filtro; sem pílula de "ocultas"; tela vazia explica uma vez', () => {
  assert.match(html, /<label for="selStatus">Status<\/label><select id="selStatus">/);
  assert.match(html, /op\.textContent = s\.rotulo \+ \(c\[s\.valor\] === null \|\| c\[s\.valor\] === undefined \? '' : ' \(' \+ c\[s\.valor\] \+ '\)'\)/);
  assert.ok(!html.includes('ver-concluidas'), 'a pílula foi trocada pela contagem no filtro');
  assert.ok(!html.includes('ocultarConc'), 'a caixa "Ocultar concluídas" foi substituída pelo filtro');
  assert.match(html, /escolha "Concluídas" no filtro Status\./);
});
