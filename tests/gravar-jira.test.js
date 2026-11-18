// Gravação da Solução no Jira pela tela de Expedições (gravarJira.js).
// O Jira é falso (função `chamar` injetada): nada sai para a rede.

process.env.ALLOWED_DOMAINS = 'dimensa.com.br,totvs.com.br,brb.com.br,evertecinc.com.br';
process.env.ALLOWED_EMAILS = '';
process.env.SESSION_SECRET = 'segredo-de-teste-nao-usado-em-producao';
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_ANON_KEY = 'chave-de-teste';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'chave-de-servico-de-teste';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const G = require('../gravarJira');

const paragrafo = (...content) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content }] });
const txt = (text, marks) => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const BR = { type: 'hardBreak' };

describe('quem grava no Jira', () => {
  // Combinado em 2026-11-18: só Dimensa e Evertec. TOTVS e BRB nunca - e a
  // lista é fixa no código, para EDITOR_DOMAINS não abrir a gravação sem querer.
  test('só @dimensa.com.br e @evertecinc.com.br; TOTVS, BRB e domínio parecido não', () => {
    assert.ok(G.podeGravarJira('fulano@dimensa.com.br'));
    assert.ok(G.podeGravarJira('Fulano@EvertecInc.com.br'));
    for (const e of ['x@totvs.com.br', 'x@brb.com.br', 'x@sub.dimensa.com.br', 'x@dimensa.com.br.mal.com', '@dimensa.com.br', '', null]) {
      assert.strictEqual(G.podeGravarJira(e), false, String(e));
    }
  });

  test('só issues do projeto JDCBBRB (o token enxerga a empresa inteira)', () => {
    assert.strictEqual(G.chaveDoProjeto('jdcbbrb-363'), 'JDCBBRB-363');
    assert.strictEqual(G.chaveDoProjeto('CRED5-1050'), '');
    assert.strictEqual(G.chaveDoProjeto('JDCBBRB-363 OR 1=1'), '');
  });
});

describe('formato igual ao do Jira', () => {
  // Formato real da Solução da JDCBBRB-363: um parágrafo, quebra de linha = hardBreak.
  const REAL = paragrafo(txt('Alterar a tela de alteração de Liberação.'), BR, txt('Incluir campo de observação.'));

  test('lê a Solução do Jira como texto, com a quebra de linha', () => {
    assert.deepStrictEqual(G.adfParaTexto(REAL), { texto: 'Alterar a tela de alteração de Liberação.\nIncluir campo de observação.', simples: true });
    assert.deepStrictEqual(G.adfParaTexto(null), { texto: '', simples: true });
  });

  test('grava no mesmo formato: o texto lido e regravado dá exatamente o mesmo documento', () => {
    assert.deepStrictEqual(G.textoParaAdf(G.adfParaTexto(REAL).texto), REAL);
    // linha em branco = duas quebras seguidas, sem texto vazio no meio
    assert.deepStrictEqual(G.textoParaAdf('a\r\n\r\nb'), paragrafo(txt('a'), BR, BR, txt('b')));
    assert.strictEqual(G.textoParaAdf('   \n  '), null, 'vazio apaga o campo');
  });

  test('qualquer formatação deixa a Solução fora da edição (salvar por cima apagaria)', () => {
    const casos = {
      negrito: paragrafo(txt('a', [{ type: 'strong' }])),
      link: paragrafo(txt('a', [{ type: 'link', attrs: { href: 'https://x' } }])),
      mencao: paragrafo(txt('a'), { type: 'mention', attrs: { id: '1' } }),
      lista: { type: 'doc', version: 1, content: [{ type: 'bulletList', content: [] }] },
      doisParagrafos: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [txt('a')] }, { type: 'paragraph', content: [txt('b')] }] }
    };
    for (const [nome, doc] of Object.entries(casos)) assert.strictEqual(G.adfParaTexto(doc).simples, false, nome);
  });
});

// Jira falso: guarda a Solução e registra cada chamada
function jiraFalso(solucao, extra = {}) {
  const estado = { solucao, chamadas: [] };
  estado.chamar = async (caminho, opcoes = {}) => {
    estado.chamadas.push({ caminho, metodo: opcoes.metodo || 'GET', corpo: opcoes.corpo });
    if (opcoes.metodo === 'PUT') { estado.solucao = opcoes.corpo.fields[G.CAMPO_SOLUCAO]; return null; }
    return {
      key: 'JDCBBRB-363',
      fields: {
        summary: 'DEV - campo de observação', status: { name: 'Concluído' },
        issuetype: { name: 'Participativo', hierarchyLevel: 0, subtask: false }, project: { key: 'JDCBBRB' },
        [G.CAMPO_SOLUCAO]: estado.solucao, ...extra
      }
    };
  };
  return estado;
}
const pedido = (texto, versao) => G.validarPedido('JDCBBRB-363', { texto, versao });

describe('gravar a Solução', () => {
  test('grava só o campo Solução (sem comentário nem outra marca) e devolve antes/depois', async () => {
    const j = jiraFalso(paragrafo(txt('antigo')));
    const versao = G.versaoDe(j.solucao);
    const r = await G.gravarSolucao(pedido('novo\nsegunda linha', versao), j.chamar);
    assert.deepStrictEqual(r, { ok: true, anterior: 'antigo', novo: 'novo\nsegunda linha' });
    const escritas = j.chamadas.filter((c) => c.metodo !== 'GET');
    assert.strictEqual(escritas.length, 1, 'uma única escrita no Jira');
    assert.deepStrictEqual(escritas[0], { caminho: '/rest/api/3/issue/JDCBBRB-363', metodo: 'PUT', corpo: { fields: { [G.CAMPO_SOLUCAO]: paragrafo(txt('novo'), BR, txt('segunda linha')) } } });
  });

  test('mudou no Jira depois que a tela leu: recusa, não grava, e devolve o texto atual', async () => {
    const j = jiraFalso(paragrafo(txt('antigo')));
    const versaoVelha = G.versaoDe(j.solucao);
    j.solucao = paragrafo(txt('outra pessoa mudou'));
    const r = await G.gravarSolucao(pedido('meu texto', versaoVelha), j.chamar);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.conflito, true);
    assert.strictEqual(r.atual.texto, 'outra pessoa mudou');
    assert.ok(!j.chamadas.some((c) => c.metodo === 'PUT'));
  });

  test('Solução formatada no Jira: recusa (edite no Jira)', async () => {
    const j = jiraFalso(paragrafo(txt('a', [{ type: 'strong' }])));
    const r = await G.gravarSolucao(pedido('b', G.versaoDe(j.solucao)), j.chamar);
    assert.strictEqual(r.formatada, true);
    assert.ok(!j.chamadas.some((c) => c.metodo === 'PUT'));
  });

  test('mesmo texto: não grava nada (nem linha no histórico do Jira)', async () => {
    const j = jiraFalso(paragrafo(txt('igual')));
    const r = await G.gravarSolucao(pedido('  igual \r\n', G.versaoDe(j.solucao)), j.chamar);
    assert.strictEqual(r.semMudanca, true);
    assert.ok(!j.chamadas.some((c) => c.metodo === 'PUT'));
  });

  test('issue de outro projeto ou subtarefa: recusa mesmo com a chave certa', async () => {
    const fora = jiraFalso(null, { project: { key: 'CRED5' } });
    assert.strictEqual((await G.gravarSolucao(pedido('x', G.versaoDe(null)), fora.chamar)).foraDoProjeto, true);
    const sub = jiraFalso(null, { issuetype: { name: 'Codificação', hierarchyLevel: -1, subtask: true } });
    assert.strictEqual((await G.gravarSolucao(pedido('x', G.versaoDe(null)), sub.chamar)).foraDoProjeto, true);
  });

  test('validação antes do Jira: chave de outro projeto, sem versão, texto longo demais', () => {
    assert.strictEqual(G.validarPedido('CRED5-1', { texto: 'x', versao: 'a'.repeat(32) }).ok, false);
    assert.strictEqual(G.validarPedido('JDCBBRB-1', { texto: 'x' }).ok, false);
    assert.strictEqual(G.validarPedido('JDCBBRB-1', { texto: 'x'.repeat(G.MAX_TEXTO + 1), versao: 'a'.repeat(32) }).ok, false);
    assert.strictEqual(G.validarPedido('JDCBBRB-1', { texto: 'x', versao: 'a'.repeat(32) }).ok, true);
  });
});

describe('ler as Soluções da expedição', () => {
  test('épico: as tasks filhas, sem canceladas; task: ela mesma', async () => {
    const chamadas = [];
    const chamar = async (caminho) => {
      chamadas.push(caminho);
      if (caminho.startsWith('/rest/api/3/issue/')) return { key: 'JDCBBRB-360', fields: { issuetype: { hierarchyLevel: 1 } } };
      return {
        issues: [
          { key: 'JDCBBRB-363', fields: { summary: 'A', status: { name: 'Concluído' }, [G.CAMPO_SOLUCAO]: paragrafo(txt('s')) } },
          { key: 'JDCBBRB-364', fields: { summary: 'B', status: { name: 'Cancelado' } } }
        ]
      };
    };
    const r = await G.lerSolucoes('JDCBBRB-360', chamar);
    assert.deepStrictEqual(r.tarefas.map((t) => [t.chave, t.texto, t.editavel]), [['JDCBBRB-363', 's', true]]);
    assert.strictEqual((await G.lerSolucoes('CRED5-1', chamar)).status, 'fora-do-projeto');
  });
});

describe('rotas', () => {
  const app = require('../server');
  const { criarSessao, COOKIE_NAME } = require('../auth');
  let servidor, base;
  before(async () => { await new Promise((r) => { servidor = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${servidor.address().port}`; });
  after(() => servidor && servidor.close());
  const cookie = (email) => `${COOKIE_NAME}=${criarSessao({ email })}`;
  const put = (chave, corpo, email) => fetch(`${base}/api/jira/solucao/${chave}`, {
    method: 'PUT', redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(email ? { Cookie: cookie(email) } : {}) },
    body: JSON.stringify(corpo)
  });

  test('sem login: 401; BRB e TOTVS: 403 (nada chega ao Jira)', async () => {
    const corpo = { texto: 'x', versao: 'a'.repeat(32) };
    assert.strictEqual((await put('JDCBBRB-1', corpo)).status, 401);
    assert.strictEqual((await put('JDCBBRB-1', corpo, 'cliente@brb.com.br')).status, 403);
    assert.strictEqual((await put('JDCBBRB-1', corpo, 'fulano@totvs.com.br')).status, 403);
  });

  test('Dimensa com chave de outro projeto: 400 antes de falar com o Jira', async () => {
    const r = await put('CRED5-1', { texto: 'x', versao: 'a'.repeat(32) }, 'fulano@dimensa.com.br');
    assert.strictEqual(r.status, 400);
    const g = await fetch(`${base}/api/jira/solucao?chave=CRED5-1`, { headers: { Cookie: cookie('fulano@evertecinc.com.br') } });
    assert.strictEqual(g.status, 400);
  });

  test('a Solução cabe no corpo (até 4000 caracteres com acento e quebra de linha)', async () => {
    const texto = ('ação\n').repeat(800); // 4000 caracteres
    const r = await put('CRED5-1', { texto, versao: 'a'.repeat(32) }, 'fulano@dimensa.com.br');
    assert.strictEqual(r.status, 400, 'chega na validação (não é barrado por tamanho do corpo)');
    assert.match((await r.json()).erro, /projeto JDCBBRB/);
  });
});
