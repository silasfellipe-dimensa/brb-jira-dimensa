// Expedições: item confirmado pelo Jira fica travado (disabled), e o navegador
// pinta checkbox travado de cinza ignorando o accent-color. Ele tem de aparecer
// verde, igual ao marcado à mão.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'paginas', 'expedicoes.html'), 'utf8');

test('checkbox travado e marcado é pintado de verde (var(--ok)) com o ✓', () => {
  const regra = html.match(/input\[type="checkbox"\]:disabled:checked \{([^}]*)\}/);
  assert.ok(regra, 'falta a regra para o checkbox travado e marcado');
  assert.match(regra[1], /appearance: none/);
  assert.match(regra[1], /background: var\(--ok\) var\(--check-img\)/);
  assert.ok((html.match(/--check-img: url\("data:image\/svg\+xml/g) || []).length >= 2, 'o ✓ precisa existir no tema claro e no escuro');
});
