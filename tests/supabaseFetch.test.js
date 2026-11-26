// supabaseFetch.js: nova tentativa só para "JWT issued at future".

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { criarFetchComNovaTentativa } = require('../supabaseFetch');

const resposta = (status, corpo) => new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
const NO_FUTURO = { code: 'PGRST303', message: 'JWT issued at future' };

function fetchFalso(respostas) {
  const chamadas = [];
  const f = async (url, opcoes) => { chamadas.push({ url, opcoes }); return respostas[Math.min(chamadas.length - 1, respostas.length - 1)](); };
  return { f, chamadas };
}
const sem = { esperaMs: 0 };

describe('fetch do Supabase com nova tentativa', () => {
  test('recusa por relógio seguida de sucesso: repete e devolve o sucesso', async () => {
    const { f, chamadas } = fetchFalso([() => resposta(401, NO_FUTURO), () => resposta(200, [{ ok: 1 }])]);
    const r = await criarFetchComNovaTentativa(f, sem)('https://x/rest/v1/t', { method: 'POST', body: '{"a":1}' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(chamadas.length, 2);
    assert.strictEqual(chamadas[1].opcoes.body, '{"a":1}', 'o mesmo pedido é reenviado');
  });

  test('continua recusando: para depois de 2 novas tentativas e devolve o erro (legível)', async () => {
    const { f, chamadas } = fetchFalso([() => resposta(401, NO_FUTURO)]);
    const r = await criarFetchComNovaTentativa(f, sem)('https://x', {});
    assert.strictEqual(chamadas.length, 3);
    assert.strictEqual(r.status, 401);
    assert.strictEqual((await r.json()).message, 'JWT issued at future', 'o corpo continua legível para o cliente');
  });

  // Bug que isto pega: repetir à toa (e mascarar) chave errada ou erro de verdade.
  test('outro 401, 400 ou 500 volta na hora, sem repetir', async () => {
    for (const [status, corpo] of [[401, { message: 'Invalid API key' }], [400, { message: 'bad' }], [500, { message: 'JWT issued at future' }]]) {
      const { f, chamadas } = fetchFalso([() => resposta(status, corpo)]);
      const r = await criarFetchComNovaTentativa(f, sem)('https://x', {});
      assert.strictEqual(r.status, status);
      assert.strictEqual(chamadas.length, 1, `${status} ${corpo.message}`);
    }
  });

  test('sucesso de primeira: uma chamada só', async () => {
    const { f, chamadas } = fetchFalso([() => resposta(200, [])]);
    await criarFetchComNovaTentativa(f, sem)('https://x', {});
    assert.strictEqual(chamadas.length, 1);
  });
});
