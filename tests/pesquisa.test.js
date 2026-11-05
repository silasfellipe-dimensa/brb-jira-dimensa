// Pesquisa por número do chamado (pesquisa.js + /pesquisa). Sem rede: o Jira é
// uma função falsa; o servidor aponta o Supabase para 127.0.0.1:1.

process.env.ALLOWED_DOMAINS = 'dimensa.com.br,totvs.com.br,brb.com.br,evertecinc.com.br';
process.env.SESSION_SECRET = 'segredo-de-teste-nao-usado-em-producao';
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_ANON_KEY = 'chave-de-teste';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'chave-de-servico-de-teste';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const p = require('../pesquisa');

const issue = (key, extra = {}) => ({
  key,
  fields: {
    summary: extra.summary || `Resumo ${key}`,
    status: { name: extra.status || 'Aberto', statusCategory: { key: extra.categoria || 'new' } },
    assignee: extra.responsavel ? { displayName: extra.responsavel } : null,
    issuetype: { name: extra.tipo || 'Tarefa', subtask: !!extra.subtask },
    project: { key: key.split('-')[0] },
    parent: extra.pai ? { key: extra.pai, fields: { summary: 'Pai' } } : undefined,
    updated: extra.updated || '2026-10-01T10:00:00.000-0300'
  }
});

/** Jira falso: responde busca de texto, busca de filhas e leitura por chave. */
function jiraFalso({ busca = [], filhas = [], existentes = {}, cair = false, lentasAntes = 0, erro = null } = {}) {
  const chamadas = [];
  let lentas = lentasAntes;
  const chamar = async (caminho) => {
    chamadas.push(decodeURIComponent(caminho));
    if (cair) throw new Error('Jira não respondeu em 10000ms');
    if (erro) throw new Error(erro);
    if (lentas > 0) { lentas--; throw new Error('Jira não respondeu em 10000ms (' + caminho + ')'); }
    if (caminho.startsWith('/rest/api/3/issue/')) {
      const k = decodeURIComponent(caminho.split('/')[5].split('?')[0]);
      if (!existentes[k]) throw new Error('Jira respondeu 404 (board ou sprint não encontrado) em ' + caminho);
      return existentes[k];
    }
    const jql = decodeURIComponent(caminho);
    if (jql.includes('parent in (')) return { issues: filhas };
    const pais = /key in \(([^)]*)\)/.exec(jql);
    if (pais) return { issues: pais[1].split(',').map((k) => existentes[k]).filter(Boolean) };
    return { issues: busca };
  };
  return { chamar, chamadas };
}

describe('normalizarTermo', () => {
  test('10 dígitos é TTB, 11 é ACS; prefixo TTB/ACS some', () => {
    assert.deepStrictEqual(p.normalizarTermo('2026110141'), { ok: true, termo: '2026110141', tipo: 'ttb', numero: '2026110141' });
    assert.strictEqual(p.normalizarTermo('TTB - 2026110141').numero, '2026110141');
    assert.strictEqual(p.normalizarTermo('ttb-2026110141').tipo, 'ttb');
    assert.strictEqual(p.normalizarTermo('20260917002').tipo, 'acs');
    assert.strictEqual(p.normalizarTermo('ACS 20260917002').numero, '20260917002');
    assert.strictEqual(p.normalizarTermo('123456').tipo, 'numero');
  });

  test('chave do Jira e termo livre', () => {
    assert.deepStrictEqual(p.normalizarTermo(' jdcbbrb-420 '), { ok: true, termo: 'JDCBBRB-420', tipo: 'jira', chave: 'JDCBBRB-420' });
    assert.strictEqual(p.normalizarTermo('T402COGC_HST').tipo, 'texto');
    assert.strictEqual(p.normalizarTermo('BDCF 89.01').termo, 'BDCF 89.01');
  });

  test('aspas, barras e operadores da busca não entram na JQL', () => {
    const n = p.normalizarTermo('x" OR project = SEGREDO OR text ~ "y\\');
    assert.ok(n.ok);
    assert.ok(!/["\\=~]/.test(n.termo), n.termo);
    assert.ok(!/["\\]/.test(p.montarJql(n).replace(/text ~ "[^"]*"/g, '')));
  });

  test('curto, longo ou vazio: erro claro', () => {
    assert.strictEqual(p.normalizarTermo('ab').ok, false);
    assert.strictEqual(p.normalizarTermo('').ok, false);
    assert.strictEqual(p.normalizarTermo(undefined).ok, false);
    assert.strictEqual(p.normalizarTermo('"""').ok, false);
    assert.strictEqual(p.normalizarTermo('a'.repeat(81)).ok, false);
  });
});

describe('montarJql', () => {
  test('número vai sozinho e grudado no prefixo (o Jira lê "TTB-2026070342" como uma palavra só)', () => {
    const jql = p.montarJql(p.normalizarTermo('2026070342'));
    assert.match(jql, /text ~ "2026070342"/);
    assert.match(jql, /text ~ "TTB-2026070342"/);
    assert.match(jql, /ORDER BY updated DESC$/);
  });
});

describe('naBase', () => {
  const demandas = [
    { id: 1, mes: '2026-10', demandaAcs: '20260917002', artefatoJira: 'JDCBBRB-382', nome: 'Efetivação automática de empréstimos' },
    { id: 2, mes: '2026-10', demandaAcs: '20260811001', artefatoJira: 'https://x.atlassian.net/browse/jdcbbrb-300', nome: 'Outra coisa' }
  ];
  const expedicoes = [{ id: 9, demandaAcs: '', artefatoJira: 'JDCBBRB-300', nome: 'Expedição da outra', dataExpedicao: '2026-11-10' }];

  test('ACS por número inteiro, não por pedaço', () => {
    assert.strictEqual(p.naBase(p.normalizarTermo('20260917002'), demandas, expedicoes).demandas.length, 1);
    assert.strictEqual(p.naBase(p.normalizarTermo('2026091700'), demandas, expedicoes).demandas.length, 0);
  });

  test('chave acha em Demandas (mesmo com URL) e em Expedições', () => {
    const r = p.naBase(p.normalizarTermo('JDCBBRB-300'), demandas, expedicoes);
    assert.strictEqual(r.demandas[0].jira, 'JDCBBRB-300');
    assert.strictEqual(r.expedicoes[0].id, 9);
  });

  test('termo pelo nome, sem acento e sem caixa', () => {
    assert.strictEqual(p.naBase(p.normalizarTermo('efetivacao automatica'), demandas, expedicoes).demandas[0].id, 1);
  });
});

describe('pesquisar', () => {
  test('ACS da nossa base: a task ligada vem primeiro, marcada "base", mesmo que o Jira não cite o número', async () => {
    const j = jiraFalso({ busca: [], existentes: { 'JDCBBRB-382': issue('JDCBBRB-382', { responsavel: 'Fabiana' }) } });
    const r = await p.pesquisar(p.normalizarTermo('20260917002'), {
      chamar: j.chamar, demandas: [{ id: 1, demandaAcs: '20260917002', artefatoJira: 'JDCBBRB-382', nome: 'x' }], expedicoes: []
    });
    assert.deepStrictEqual(r.projeto.map((i) => [i.chave, i.origem]), [['JDCBBRB-382', 'base']]);
    assert.strictEqual(r.base.demandas.length, 1);
  });

  test('separa o nosso projeto dos outros times; sem repetir a mesma task', async () => {
    const j = jiraFalso({
      busca: [issue('JDCBCRED5-1050'), issue('JDCBBRB-435'), issue('JDCBBRB-420')],
      existentes: { 'JDCBBRB-420': issue('JDCBBRB-420') }
    });
    const r = await p.pesquisar(p.normalizarTermo('JDCBBRB-420'), { chamar: j.chamar, demandas: [], expedicoes: [] });
    assert.deepStrictEqual(r.projeto.map((i) => i.chave), ['JDCBBRB-420', 'JDCBBRB-435']);
    assert.deepStrictEqual(r.outros.map((i) => i.chave), ['JDCBCRED5-1050']);
  });

  test('quem trabalhou: responsável da task + das subtarefas; subtarefa com pai na lista não aparece solta', async () => {
    const j = jiraFalso({
      busca: [issue('JDCBBRB-259', { responsavel: 'Marcelo' }), issue('JDCBBRB-266', { pai: 'JDCBBRB-259', responsavel: 'Marcelo', subtask: true })],
      filhas: [
        issue('JDCBBRB-266', { pai: 'JDCBBRB-259', responsavel: 'Marcelo', summary: 'Codificação' }),
        issue('JDCBBRB-268', { pai: 'JDCBBRB-259', responsavel: 'Silas', summary: 'Teste Integrado' }),
        issue('JDCBBRB-267', { pai: 'JDCBBRB-259', summary: 'Documentação' })
      ]
    });
    const r = await p.pesquisar(p.normalizarTermo('RECEBER_TTB'), { chamar: j.chamar, demandas: [], expedicoes: [] });
    assert.deepStrictEqual(r.projeto.map((i) => i.chave), ['JDCBBRB-259']);
    assert.deepStrictEqual(r.projeto[0].envolvidos, ['Marcelo', 'Silas']);
    assert.strictEqual(r.projeto[0].filhos.length, 3);
  });

  test('Jira fora do ar: não derruba, a base responde sozinha', async () => {
    const j = jiraFalso({ cair: true });
    const r = await p.pesquisar(p.normalizarTermo('20260917002'), {
      chamar: j.chamar, demandas: [{ id: 1, demandaAcs: '20260917002', artefatoJira: 'JDCBBRB-382', nome: 'x' }], expedicoes: []
    });
    assert.strictEqual(r.jira.status, 'indisponivel');
    assert.strictEqual(r.base.demandas.length, 1);
    assert.deepStrictEqual(r.projeto, []);
  });

  // Pedido: subtarefa não é resultado (é pedaço do trabalho); vira a task-pai,
  // com a nota de onde o termo veio - descartar perderia a task.
  test('subtarefa achada sozinha vira a task-pai, com a nota "na subtarefa"', async () => {
    const j = jiraFalso({
      busca: [issue('JDCBBRB-266', { pai: 'JDCBBRB-259', subtask: true, summary: 'Codificação' })],
      existentes: { 'JDCBBRB-259': issue('JDCBBRB-259', { responsavel: 'Marcelo', summary: 'RECEBER_TTB' }) }
    });
    const r = await p.pesquisar(p.normalizarTermo('PCRA2_CARGA'), { chamar: j.chamar, demandas: [], expedicoes: [] });
    assert.deepStrictEqual(r.projeto.map((i) => i.chave), ['JDCBBRB-259']);
    assert.deepStrictEqual(r.projeto[0].via.map((v) => v.chave), ['JDCBBRB-266']);
    assert.strictEqual(r.projeto[0].subtarefa, false);
  });

  test('task dentro de épico continua sendo a task (o épico é amplo demais)', async () => {
    const j = jiraFalso({
      busca: [issue('JDCBBRB-358', { tipo: 'Epico' }), issue('JDCBBRB-420', { pai: 'JDCBBRB-358' })],
      filhas: [issue('JDCBBRB-420', { pai: 'JDCBBRB-358' })]
    });
    const r = await p.pesquisar(p.normalizarTermo('PCRA2'), { chamar: j.chamar, demandas: [], expedicoes: [] });
    assert.deepStrictEqual(r.projeto.map((i) => i.chave).sort(), ['JDCBBRB-358', 'JDCBBRB-420']);
  });

  test('pai da subtarefa não veio do Jira: a subtarefa fica, em vez de sumir', async () => {
    const j = jiraFalso({ busca: [issue('JDCBBRB-266', { pai: 'JDCBBRB-999', subtask: true })] });
    const r = await p.pesquisar(p.normalizarTermo('PCRA2_CARGA'), { chamar: j.chamar, demandas: [], expedicoes: [] });
    assert.deepStrictEqual(r.projeto.map((i) => i.chave), ['JDCBBRB-266']);
  });

  // Bug real: a mesma busca estourou 10 s e, logo depois, voltou em 1 s.
  test('Jira lento uma vez: tenta de novo e acha', async () => {
    const j = jiraFalso({ lentasAntes: 1, busca: [issue('JDCBBRB-222')] });
    const r = await p.pesquisar(p.normalizarTermo('2026070342'), { chamar: j.chamar, demandas: [], expedicoes: [] });
    assert.strictEqual(r.jira.status, 'ok');
    assert.deepStrictEqual(r.projeto.map((i) => i.chave), ['JDCBBRB-222']);
  });

  test('erro que não é lentidão (busca inválida) não repete a chamada', async () => {
    const j = jiraFalso({ erro: 'Jira respondeu 400 em /rest/api/3/search/jql' });
    const r = await p.pesquisar(p.normalizarTermo('2026070342'), { chamar: j.chamar, demandas: [], expedicoes: [] });
    assert.strictEqual(r.jira.status, 'indisponivel');
    assert.strictEqual(j.chamadas.length, 1);
  });

  test('busca demorada: as filhas ficam de fora para não passar dos 30 s da Vercel', async () => {
    let t = 0;
    const j = jiraFalso({ busca: [issue('JDCBBRB-259', { responsavel: 'Marcelo' })] });
    const r = await p.pesquisar(p.normalizarTermo('RECEBER_TTB'), { chamar: j.chamar, demandas: [], expedicoes: [], agora: () => (t += 16000) });
    assert.ok(!j.chamadas.some((c) => c.includes('parent in (')));
    assert.deepStrictEqual(r.projeto[0].envolvidos, ['Marcelo']);
  });

  test('task da base que o Jira não acha fica listada como não encontrada', async () => {
    const j = jiraFalso({ busca: [] });
    const r = await p.pesquisar(p.normalizarTermo('20260917002'), {
      chamar: j.chamar, demandas: [{ id: 1, demandaAcs: '20260917002', artefatoJira: 'JDCBBRB-999', nome: 'x' }], expedicoes: []
    });
    assert.deepStrictEqual(r.jira.naoEncontradas, ['JDCBBRB-999']);
  });
});

describe('tela', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'paginas', 'pesquisa.html'), 'utf8');

  test('tudo que vem da API passa por esc(); link só https', () => {
    assert.match(html, /function esc\(s\)/);
    assert.match(html, /function href\(url\) \{ return \/\^https:\\\/\\\/\/\.test/);
    assert.ok(!/innerHTML = [^;]*r\.termo(?!\))/.test(html.replace(/esc\(r\.termo\)/g, '')));
  });

  // Bug: com o Jira fora, a tela dizia "Nenhuma task no Jira tem o número".
  test('Jira fora e nada na base: não afirma que a task não existe, oferece tentar de novo', () => {
    const corpo = html.slice(html.indexOf('function vazioHtml'), html.indexOf('function render'));
    const jiraFora = corpo.indexOf("r.jira.status !== 'ok'");
    assert.ok(jiraFora > 0 && jiraFora < corpo.indexOf('Nenhuma task'), 'o caso do Jira fora vem antes de qualquer "Nenhuma task"');
    assert.match(corpo, /ainda não sei se existe task/);
    assert.match(html, /id="tentar">Tentar de novo/);
  });

  test('sem achar nada, diz que a task ainda não foi criada e qual é o padrão do título', () => {
    assert.match(html, /a task ainda não foi criada/);
    assert.match(html, /TTB - ' \+ esc\(r\.termo\) \+ ' - descrição/);
  });
});

describe('servidor', () => {
  const app = require('../server');
  const { criarSessao, COOKIE_NAME } = require('../auth');
  let servidor; let base;
  before(async () => { await new Promise((r) => { servidor = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${servidor.address().port}`; });
  after(() => servidor && servidor.close());
  const pedir = (c, email) => fetch(base + c, { redirect: 'manual', headers: email ? { Cookie: `${COOKIE_NAME}=${criarSessao({ email })}` } : {} });

  test('sem sessão: página vai para o login, API 401', async () => {
    assert.strictEqual((await pedir('/pesquisa')).headers.get('location'), '/login.html');
    assert.strictEqual((await pedir('/api/pesquisa?q=2026110141')).status, 401);
  });

  test('BRB e TOTVS: página volta para o board, API 403', async () => {
    for (const email of ['cliente@brb.com.br', 'fulano@totvs.com.br', 'x@dimensa.com.br.invasor.com']) {
      const pg = await pedir('/pesquisa', email);
      if (email.endsWith('invasor.com')) { assert.notStrictEqual(pg.status, 200); continue; }
      assert.strictEqual(pg.headers.get('location'), '/');
      assert.strictEqual((await pedir('/api/pesquisa?q=2026110141', email)).status, 403);
    }
  });

  test('equipe abre a página; termo inválido responde 400 antes de tocar no Jira', async () => {
    const r = await pedir('/pesquisa', 'fulano@evertecinc.com.br');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('cache-control'), /no-cache/);
    const ruim = await pedir('/api/pesquisa?q=ab', 'fulano@dimensa.com.br');
    assert.strictEqual(ruim.status, 400);
    assert.match((await ruim.json()).erro, /pelo menos 3/);
  });

  const postar = (corpo, email) => fetch(base + '/api/pesquisa/ampla', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(email ? { Cookie: `${COOKIE_NAME}=${criarSessao({ email })}` } : {}) },
    body: JSON.stringify(corpo)
  });

  test('ampla: mesma regra de acesso (401 sem sessão, 403 BRB e TOTVS)', async () => {
    const corpo = { texto: 'a PCRA2_CARGA falhou' };
    assert.strictEqual((await postar(corpo)).status, 401);
    assert.strictEqual((await postar(corpo, 'cliente@brb.com.br')).status, 403);
    assert.strictEqual((await postar(corpo, 'fulano@totvs.com.br')).status, 403);
  });

  test('ampla: mensagem sem nome técnico ou longa demais responde 400 antes do Jira', async () => {
    const sem = await postar({ texto: 'bom dia, o sistema está com problema, podem ver?' }, 'fulano@dimensa.com.br');
    assert.strictEqual(sem.status, 400);
    assert.match((await sem.json()).erro, /Não achei nomes técnicos/);
    assert.strictEqual((await postar({ texto: 'x'.repeat(p.MAX_TEXTO + 1) }, 'fulano@dimensa.com.br')).status, 400);
  });
});

describe('pesquisa ampla', () => {
  const MSG = 'Bom dia pessoal. Chamado TTB 2026110141: a PCRA2_CARGA está gravando duplicado na T402COGC_HST depois que subimos a versão BDCF 89.01 em PROD. Podem verificar?';

  test('tira da mensagem do cliente o número do chamado e os nomes técnicos', () => {
    assert.deepStrictEqual(p.extrairTermos(MSG), { numeros: ['2026110141'], termos: ['PCRA2_CARGA', 'T402COGC_HST', '89.01', 'BDCF'] });
  });

  test('extração: acento não corta palavra, valor não vira versão, siglas comuns ficam de fora', () => {
    assert.deepStrictEqual(p.extrairTermos('FAVOR VERIFICAÇÃO URGENTE DA ROTINA. VERSÃO 89.01.').termos, ['89.01']);
    assert.deepStrictEqual(p.extrairTermos('valor 1.500,00 na JDCBBRB-420; TTB-2026070342').termos, ['JDCBBRB-420']);
    assert.deepStrictEqual(p.extrairTermos('TTB-2026070342 e ACS 20260917002').numeros, ['2026070342', '20260917002']);
  });

  test('termo que a pessoa manda passa pelo mesmo filtro da busca', () => {
    assert.strictEqual(p.limparTermo('x" OR project = SEGREDO'), 'XORPROJECTSEGREDO');
    assert.strictEqual(p.limparTermo('ab'), '');
  });

  /** Jira falso por termo: { termo: [issues] }. */
  const jiraPorTermo = (mapa, filhas = []) => async (caminho) => {
    const jql = decodeURIComponent(caminho);
    if (jql.includes('parent in (')) return { issues: filhas };
    const m = /text ~ "([^"]+)"/.exec(jql);
    const v = (m && mapa[m[1]]) || [];
    return Array.isArray(v) ? { issues: v } : v; // { issues, nextPageToken } = "25+"
  };
  const todasAmpla = (r) => [...r.provaveis, ...r.nosso, ...r.outros];

  test('relevância: termo no título vale o dobro; cancelada vale a metade', () => {
    const pesos = p.pesoTermos([{ termo: 'PCRA2_CARGA', tasks: 3 }, { termo: 'PCRA2', tasks: 25, maisDe: true }]);
    assert.strictEqual(pesos.PCRA2_CARGA.raro, true);
    assert.strictEqual(pesos.PCRA2.raro, false);
    assert.ok(pesos.PCRA2_CARGA.peso > pesos.PCRA2.peso);
    const base = { termos: ['PCRA2_CARGA'], status: 'Aberto' };
    const noTitulo = p.pontuar({ ...base, resumo: 'Erro na procedure pcra2_carga' }, pesos);
    const naDescricao = p.pontuar({ ...base, resumo: 'Outra coisa' }, pesos);
    assert.ok(Math.abs(noTitulo.pontos - 2 * naDescricao.pontos) < 0.01);
    assert.deepStrictEqual(noTitulo.motivos, [{ termo: 'PCRA2_CARGA', titulo: true, raro: true }]);
    const cancelada = p.pontuar({ ...base, resumo: 'Outra coisa', status: 'Cancelado' }, pesos);
    assert.ok(cancelada.cancelada && Math.abs(cancelada.pontos - naDescricao.pontos / 2) < 0.01);
  });

  // Caso real (mensagem do BDCF 89.01): a task certa era de outro time, com
  // "89.01" no título, e ficava atrás de todo o JDCBBRB - até de uma que só
  // citava "PCRA2" de passagem.
  test('mais prováveis: de qualquer projeto, por relevância; termo comum de passagem fica em baixa', async () => {
    const chamar = jiraPorTermo({
      PCRA2_CARGA: [issue('JDCBBRB-420', { responsavel: 'Leonardo', summary: 'Erro na procedure pcra2_carga' }), issue('JDCBBRB-435', { responsavel: 'Leonardo' })],
      T402COGC_HST: [issue('JDCBBRB-435', { responsavel: 'Leonardo' })],
      '89.01': [issue('JDCBCRED5-1050', { responsavel: 'Andreia', summary: 'DB CREDIMASTER 89.01 SCRIPT' }), issue('JDCBBRB-415', { responsavel: 'Vitor' })],
      PCRA2: { issues: [issue('JDCBBRB-87', { summary: 'Estudo IFRS9' })], nextPageToken: 'mais' },
      PCRA3: [issue('JDCBCRED5-78', { status: 'Cancelado', categoria: 'done' })]
    });
    const r = await p.pesquisarAmplo({ termos: ['PCRA2_CARGA', 'T402COGC_HST', '89.01', 'PCRA2', 'PCRA3'], numeros: [] }, { chamar, demandas: [], expedicoes: [] });
    assert.deepStrictEqual(r.provaveis.map((i) => i.chave), ['JDCBBRB-435', 'JDCBBRB-420', 'JDCBCRED5-1050']);
    assert.strictEqual(r.provaveis.find((i) => i.chave === 'JDCBCRED5-1050').nivel, 'alta');
    const de = (k) => todasAmpla(r).find((i) => i.chave === k);
    assert.strictEqual(de('JDCBBRB-87').nivel, 'baixa');
    assert.ok(de('JDCBCRED5-78').cancelada);
    assert.ok(!r.provaveis.some((i) => i.chave === 'JDCBCRED5-78'));
    // Sem repetir: quem está em "mais prováveis" não aparece de novo embaixo.
    assert.strictEqual(new Set(todasAmpla(r).map((i) => i.chave)).size, todasAmpla(r).length);
    assert.deepStrictEqual(r.pessoas[0], { nome: 'Leonardo', tasks: 2 });
    assert.strictEqual(r.jira.status, 'ok');
  });

  test('número da mensagem vai pela busca exata; a task dele não se repete no "mesmo assunto"', async () => {
    const t222 = issue('JDCBBRB-222', { summary: 'TTB - 2026070342 - Carga' });
    const chamar = async (caminho) => {
      const jql = decodeURIComponent(caminho);
      if (jql.includes('parent in (')) return { issues: [] };
      if (jql.includes('2026070342')) return { issues: [t222] };
      if (jql.includes('PCRA2_CARGA')) return { issues: [t222, issue('JDCBBRB-420')] };
      return { issues: [] };
    };
    const r = await p.pesquisarAmplo({ termos: ['PCRA2_CARGA'], numeros: ['2026070342'] }, { chamar, demandas: [], expedicoes: [] });
    assert.deepStrictEqual(r.exatas[0].projeto.map((i) => i.chave), ['JDCBBRB-222']);
    assert.deepStrictEqual(todasAmpla(r).map((i) => i.chave), ['JDCBBRB-420']);
  });

  test('ampla: subtarefas de termos diferentes sobem para a mesma task e somam os termos', async () => {
    const pai = issue('JDCBBRB-259', { responsavel: 'Marcelo' });
    const chamar = jiraPorTermo({
      PCRA2_CARGA: [issue('JDCBBRB-266', { pai: 'JDCBBRB-259', subtask: true, summary: 'Codificação' })],
      T402COGC_HST: [issue('JDCBBRB-268', { pai: 'JDCBBRB-259', subtask: true, summary: 'Teste' })]
    });
    const comPais = async (c) => (decodeURIComponent(c).includes('key in (') ? { issues: [pai] } : chamar(c));
    const r = await p.pesquisarAmplo({ termos: ['PCRA2_CARGA', 'T402COGC_HST'], numeros: [] }, { chamar: comPais, demandas: [], expedicoes: [] });
    assert.deepStrictEqual(todasAmpla(r).map((i) => [i.chave, i.termos.length, i.via.length]), [['JDCBBRB-259', 2, 2]]);
  });

  test('um termo falha: os outros respondem e o status fica "parcial"', async () => {
    const chamar = async (caminho) => {
      const jql = decodeURIComponent(caminho);
      if (jql.includes('BDCF')) throw new Error('Jira respondeu 400 em x');
      if (jql.includes('parent in (')) return { issues: [] };
      return { issues: [issue('JDCBBRB-420')] };
    };
    const r = await p.pesquisarAmplo({ termos: ['PCRA2_CARGA', 'BDCF'], numeros: [] }, { chamar, demandas: [], expedicoes: [] });
    assert.strictEqual(r.jira.status, 'parcial');
    assert.deepStrictEqual(r.termos.map((t) => t.falhou), [false, true]);
    assert.strictEqual(todasAmpla(r).length, 1);
  });

  test('tela: aviso de pesquisa ampla com ruído, e a mensagem vai por POST (não pela URL)', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'paginas', 'pesquisa.html'), 'utf8');
    assert.match(html, /<b>Ampla:<\/b>[^<]*<b>Pode ter ruído\.<\/b>/);
    assert.match(html, /<b>Pesquisa ampla:<\/b>[^']*podem ter ruído/);
    assert.match(html, /fetch\('\/api\/pesquisa\/ampla', \{ method: 'POST'/);
  });
});
