// Link de senha (senha.js): regras puras, sem banco e sem rede.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { VALIDADE_HORAS, idUsuario, codigoValido, novoPedido, conferirPedido, caminhoDoLink, hashDe } = require('../senha');

const AGORA = new Date('2026-11-24T15:00:00.000Z');
const ID = '3f2b8c1e-5a47-4d0b-9e6a-1c2d3e4f5a6b';

describe('novoPedido — o que vai no link e o que fica guardado', () => {
  test('o código tem 32 bytes aleatórios e cada pedido é diferente', () => {
    const a = novoPedido(AGORA);
    const b = novoPedido(AGORA);
    assert.match(a.codigo, /^[A-Za-z0-9_-]{43}$/);
    assert.notStrictEqual(a.codigo, b.codigo);
    assert.notStrictEqual(a.guardar.hash, b.guardar.hash);
  });

  // Bug que isto pega: guardar o código em claro - quem lesse os metadados
  // da conta (painel do Supabase, backup) poderia trocar a senha de alguém.
  test('guarda só o hash, nunca o código', () => {
    const p = novoPedido(AGORA);
    assert.strictEqual(p.guardar.hash, hashDe(p.codigo));
    assert.ok(!JSON.stringify(p.guardar).includes(p.codigo));
    assert.deepStrictEqual(Object.keys(p.guardar).sort(), ['expira', 'hash']);
  });

  test(`vence em ${VALIDADE_HORAS} horas`, () => {
    const p = novoPedido(AGORA);
    assert.strictEqual(new Date(p.guardar.expira).getTime() - AGORA.getTime(), VALIDADE_HORAS * 3600 * 1000);
  });
});

describe('conferirPedido — só o código certo, dentro do prazo', () => {
  const p = novoPedido(AGORA);

  test('código certo dentro do prazo passa', () => {
    assert.deepStrictEqual(conferirPedido(p.guardar, p.codigo, AGORA), { ok: true });
    const quaseNoFim = new Date(AGORA.getTime() + VALIDADE_HORAS * 3600 * 1000 - 1000);
    assert.strictEqual(conferirPedido(p.guardar, p.codigo, quaseNoFim).ok, true);
  });

  test('depois da validade não passa, mesmo com o código certo', () => {
    const depois = new Date(AGORA.getTime() + VALIDADE_HORAS * 3600 * 1000 + 1000);
    assert.deepStrictEqual(conferirPedido(p.guardar, p.codigo, depois), { ok: false, motivo: 'vencido' });
  });

  test('código de outro pedido não passa (gerar um link novo cancela o anterior)', () => {
    const outro = novoPedido(AGORA);
    assert.deepStrictEqual(conferirPedido(outro.guardar, p.codigo, AGORA), { ok: false, motivo: 'nao-confere' });
  });

  // Depois de usado, o servidor apaga o pedido da conta (null): o mesmo link
  // não troca a senha duas vezes.
  test('conta sem pedido (nunca gerado, ou já usado) não passa', () => {
    for (const guardado of [null, undefined, {}, 'x', 123, [], { hash: p.guardar.hash }, { expira: p.guardar.expira }, { hash: 1, expira: 2 }]) {
      assert.deepStrictEqual(conferirPedido(guardado, p.codigo, AGORA), { ok: false, motivo: 'sem-pedido' });
    }
  });

  test('código malformado, vazio ou que não é texto não passa (nem lança)', () => {
    for (const codigo of ['', 'curto', p.codigo + 'x', p.codigo.slice(1), null, undefined, 123, {}, [p.codigo], p.guardar.hash]) {
      assert.strictEqual(conferirPedido(p.guardar, codigo, AGORA).ok, false);
    }
  });

  test('validade ilegível conta como vencido', () => {
    assert.strictEqual(conferirPedido({ hash: p.guardar.hash, expira: 'amanhã' }, p.codigo, AGORA).motivo, 'vencido');
  });

  test('hash guardado estragado não passa nem lança', () => {
    assert.strictEqual(conferirPedido({ hash: 'zz', expira: p.guardar.expira }, p.codigo, AGORA).ok, false);
    assert.strictEqual(conferirPedido({ hash: '', expira: p.guardar.expira }, p.codigo, AGORA).ok, false);
  });
});

describe('idUsuario e codigoValido — o que chega de fora', () => {
  test('idUsuario aceita só UUID', () => {
    assert.strictEqual(idUsuario(ID), ID);
    assert.strictEqual(idUsuario(ID.toUpperCase()), ID);
    for (const v of ['', '1', 'abc', ID + '0', ID.slice(1), '../' + ID, null, undefined, 1, {}, [ID]]) {
      assert.strictEqual(idUsuario(v), null);
    }
  });

  test('codigoValido aceita só o formato que geramos', () => {
    const { codigo } = novoPedido(AGORA);
    assert.strictEqual(codigoValido(codigo), codigo);
    for (const v of ['', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(42) + '/', null, undefined, 1, {}, [codigo]]) {
      assert.strictEqual(codigoValido(v), null);
    }
  });
});

describe('caminhoDoLink — o código vai no fragmento', () => {
  // Bug que isto pega: código na query string (?c=...) vai para o servidor e
  // fica no log de acesso da hospedagem. No fragmento (#) o navegador não envia.
  test('id e código ficam depois do #, nunca na query string', () => {
    const { codigo } = novoPedido(AGORA);
    const caminho = caminhoDoLink(ID, codigo);
    const [antes, depois] = caminho.split('#');
    assert.strictEqual(antes, '/redefinir-senha.html');
    assert.strictEqual(new URLSearchParams(depois).get('u'), ID);
    assert.strictEqual(new URLSearchParams(depois).get('c'), codigo);
    assert.ok(!antes.includes('?'));
  });
});

describe('telas do link de senha', () => {
  const pagina = fs.readFileSync(path.join(__dirname, '..', 'paginas', 'redefinir-senha.html'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, '..', 'paginas', 'admin.html'), 'utf8');

  test('a página lê o fragmento, limpa a barra de endereço e só envia no POST', () => {
    assert.match(pagina, /window\.location\.hash/);
    assert.match(pagina, /history\.replaceState/);
    assert.match(pagina, /fetch\('\/auth\/redefinir-senha'/);
    assert.ok(!/location\.search/.test(pagina), 'nada vem pela query string');
  });

  test('a página não monta HTML com dado vindo de fora', () => {
    assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(pagina));
  });

  test('o admin tem o botão por usuário e avisa de quem é o link antes de gerar', () => {
    assert.match(admin, /class="btn-senha"/);
    assert.match(admin, /\/link-senha/);
    assert.match(admin, /Quem abrir o link define a senha desta conta/);
  });
});
