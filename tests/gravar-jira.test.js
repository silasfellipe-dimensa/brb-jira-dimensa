// Gravação dos campos do checklist no Jira pela tela de Expedições (gravarJira.js).
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
const { REGRAS } = require('../checklistJira');

const doc = (...content) => ({ type: 'doc', version: 1, content });
const par = (...content) => ({ type: 'paragraph', content });
const txt = (text, marks) => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const BR = { type: 'hardBreak' };
const ID = (k) => G.CAMPOS_GRAVAVEIS[k].id;

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

describe('cada item do checklist sabe o que grava', () => {
  test('todo campo gravável existe; status, subtarefas e Documentação não gravam', () => {
    for (const r of REGRAS) for (const k of r.gravaveis || []) assert.ok(G.CAMPOS_GRAVAVEIS[k], `${r.texto} -> ${k}`);
    const sem = REGRAS.filter((r) => !(r.gravaveis || []).length).map((r) => r.rotulo).sort();
    assert.deepStrictEqual(sem, ['Documentação', 'Subtarefas']);
    assert.deepStrictEqual(REGRAS.find((r) => r.rotulo === 'Versão/Data prevista').gravaveis, ['versoes', 'dataPrevista']);
  });
});

describe('texto no formato do Jira', () => {
  test('lê parágrafos e quebras de linha como linhas (com o localId do editor novo)', () => {
    const real = doc({ type: 'paragraph', attrs: { localId: 'ae4994705c80' }, content: [txt('linha 1')] }, par(txt('linha 2'), BR, txt('linha 3')));
    assert.deepStrictEqual(G.adfParaTexto(real), { texto: 'linha 1\nlinha 2\nlinha 3', simples: true, perde: [] });
    assert.deepStrictEqual(G.adfParaTexto(null), { texto: '', simples: true, perde: [] });
  });

  test('grava como o editor do Jira: um parágrafo por linha, linha em branco = parágrafo vazio', () => {
    assert.deepStrictEqual(G.textoParaAdf('a\r\n\r\nb'), doc(par(txt('a')), par(), par(txt('b'))));
    assert.deepStrictEqual(G.adfParaTexto(G.textoParaAdf('a\n\nb')).texto, 'a\n\nb', 'ida e volta');
    assert.strictEqual(G.textoParaAdf('   \n  '), null, 'vazio apaga o campo');
  });

  // 2026-11-19: tudo é texto simples - formatado também se edita, limpo, dizendo o que some
  test('formatado vira texto simples legível e diz o que se perde ao salvar', () => {
    const casos = {
      negrito: [doc(par(txt('a', [{ type: 'strong' }]))), 'a', 'negrito, itálico ou cor'],
      link: [doc(par(txt('site', [{ type: 'link', attrs: { href: 'https://x' } }]))), 'site', 'link'],
      mencao: [doc(par(txt('fale com '), { type: 'mention', attrs: { id: '1', text: '@Ana' } })), 'fale com @Ana', 'menção'],
      titulo: [doc({ type: 'heading', attrs: { level: 1 }, content: [txt('Título')] }, par(txt('corpo'))), 'Título\ncorpo', 'título'],
      imagem: [doc(par(txt('veja')), { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x' } }] }), 'veja', 'imagem ou anexo']
    };
    for (const [nome, [d, texto, perda]] of Object.entries(casos)) {
      const l = G.adfParaTexto(d);
      assert.strictEqual(l.simples, false, nome);
      assert.strictEqual(l.texto, texto, nome);
      assert.ok(l.perde.includes(perda), `${nome}: ${l.perde}`);
    }
    const lista = doc({ type: 'bulletList', content: [
      { type: 'listItem', content: [par(txt('um'))] },
      { type: 'listItem', content: [par(txt('dois')), { type: 'orderedList', content: [{ type: 'listItem', content: [par(txt('sub'))] }] }] }
    ] });
    assert.strictEqual(G.adfParaTexto(lista).texto, '- um\n- dois\n  1. sub');
  });
});

describe('validação do pedido (antes de falar com o Jira)', () => {
  const v = 'a'.repeat(32);
  test('campo, chave, versão e tamanho', () => {
    assert.strictEqual(G.validarPedido('CRED5-1', { campo: 'solucao', valor: 'x', versao: v }).ok, false);
    assert.strictEqual(G.validarPedido('JDCBBRB-1', { campo: 'status', valor: 'x', versao: v }).ok, false, 'campo fora da lista');
    assert.strictEqual(G.validarPedido('JDCBBRB-1', { campo: 'constructor', valor: 'x', versao: v }).ok, false);
    assert.strictEqual(G.validarPedido('JDCBBRB-1', { campo: 'solucao', valor: 'x' }).ok, false, 'sem versão');
    assert.strictEqual(G.validarPedido('JDCBBRB-1', { campo: 'descricao', valor: 'x'.repeat(G.MAX_TEXTO + 1), versao: v }).ok, false);
    assert.strictEqual(G.validarPedido('JDCBBRB-1', { campo: 'solucao', valor: 'x', versao: v }).ok, true);
  });
  test('data: AAAA-MM-DD de verdade, ou vazio para apagar', () => {
    for (const ok of ['2026-11-19', '2028-02-29', '']) assert.strictEqual(G.validarPedido('JDCBBRB-1', { campo: 'dataPrevista', valor: ok, versao: v }).ok, true, ok);
    for (const ruim of ['2026-02-30', '19/11/2026', '2026-13-01', null, 20261119]) {
      assert.strictEqual(G.validarPedido('JDCBBRB-1', { campo: 'dataInterna', valor: ruim, versao: v }).ok, false, String(ruim));
    }
  });
  test('versões/componentes: lista de ids numéricos', () => {
    assert.deepStrictEqual(G.validarPedido('JDCBBRB-1', { campo: 'versoes', valor: ['16400', '12', '16400'], versao: v }).valor, ['12', '16400']);
    assert.strictEqual(G.validarPedido('JDCBBRB-1', { campo: 'componentes', valor: 'x', versao: v }).ok, false);
    assert.strictEqual(G.validarPedido('JDCBBRB-1', { campo: 'componentes', valor: [{ id: 1 }], versao: v }).ok, false);
  });
});

// Jira falso: uma task com os campos em `campos`, e o cadastro do projeto
function jiraFalso(campos = {}, extra = {}) {
  const estado = { campos: { ...campos }, chamadas: [] };
  const VERSOES = [
    { id: '16400', name: 'DJSBRB_6.4.2.0', releaseDate: '2026-10-22', released: true, archived: false },
    { id: '16500', name: 'DJSBRB_6.5.0.0', releaseDate: '2026-12-10', released: false, archived: false },
    { id: '10', name: 'velha', released: true, archived: true }
  ];
  const COMPONENTES = [{ id: '12271', name: 'SATÉLITE BRBCFI WEB VI' }, { id: '12272', name: 'CREDIMASTER' }];
  estado.chamar = async (caminho, opcoes = {}) => {
    estado.chamadas.push({ caminho, metodo: opcoes.metodo || 'GET', corpo: opcoes.corpo });
    if (opcoes.metodo === 'PUT') { Object.assign(estado.campos, opcoes.corpo.fields); return null; }
    if (caminho.endsWith('/versions')) return VERSOES;
    if (caminho.endsWith('/components')) return COMPONENTES;
    return {
      key: 'JDCBBRB-363',
      fields: {
        summary: 'DEV - campo de observação', status: { name: 'Concluído' },
        issuetype: { name: 'Participativo', hierarchyLevel: 0, subtask: false }, project: { key: 'JDCBBRB' },
        ...estado.campos, ...extra
      }
    };
  };
  estado.versao = (k) => G.lerCampo(k, estado.campos[ID(k)]).versao;
  return estado;
}
const pedido = (campo, valor, versao) => G.validarPedido('JDCBBRB-363', { campo, valor, versao });
const escritas = (j) => j.chamadas.filter((c) => c.metodo !== 'GET');

describe('gravar um campo', () => {
  test('texto: grava só aquele campo (sem comentário nem outra marca) e devolve antes/depois', async () => {
    const j = jiraFalso({ [ID('solucao')]: doc(par(txt('antigo'))) });
    const r = await G.gravarCampo(pedido('solucao', 'novo\nsegunda linha', j.versao('solucao')), j.chamar);
    assert.deepStrictEqual(r, { ok: true, nome: 'Solução', anterior: 'antigo', novo: 'novo\nsegunda linha' });
    assert.deepStrictEqual(escritas(j), [{
      caminho: '/rest/api/3/issue/JDCBBRB-363', metodo: 'PUT',
      corpo: { fields: { [ID('solucao')]: doc(par(txt('novo')), par(txt('segunda linha'))) } }
    }]);
  });

  test('Descrição grava em "description"', async () => {
    const j = jiraFalso({ description: null });
    await G.gravarCampo(pedido('descricao', 'texto', j.versao('descricao')), j.chamar);
    assert.deepStrictEqual(escritas(j)[0].corpo, { fields: { description: doc(par(txt('texto'))) } });
  });

  test('data: grava AAAA-MM-DD; vazio apaga (null); registra em dd/mm/aaaa', async () => {
    const j = jiraFalso({ [ID('dataPrevista')]: '2026-09-28' });
    const r = await G.gravarCampo(pedido('dataPrevista', '2026-10-22', j.versao('dataPrevista')), j.chamar);
    assert.deepStrictEqual([r.anterior, r.novo], ['28/09/2026', '22/10/2026']);
    assert.deepStrictEqual(escritas(j)[0].corpo, { fields: { [ID('dataPrevista')]: '2026-10-22' } });
    await G.gravarCampo(pedido('dataPrevista', '', j.versao('dataPrevista')), j.chamar);
    assert.deepStrictEqual(escritas(j)[1].corpo, { fields: { [ID('dataPrevista')]: null } });
  });

  test('versões: grava só ids do cadastro; arquivada que não estava na task é recusada', async () => {
    const j = jiraFalso({ fixVersions: [{ id: '16400', name: 'DJSBRB_6.4.2.0', released: true }] });
    const r = await G.gravarCampo(pedido('versoes', ['16500'], j.versao('versoes')), j.chamar);
    assert.deepStrictEqual([r.anterior, r.novo], ['DJSBRB_6.4.2.0', 'DJSBRB_6.5.0.0']);
    assert.deepStrictEqual(escritas(j)[0].corpo, { fields: { fixVersions: [{ id: '16500' }] } });
    for (const ruim of [['99999'], ['10']]) {
      const x = await G.gravarCampo(pedido('versoes', ruim, j.versao('versoes')), j.chamar);
      assert.strictEqual(x.invalido, true, ruim[0]);
    }
    assert.strictEqual(escritas(j).length, 1, 'as recusadas não chegaram ao Jira');
  });

  test('lançar a versão no Jira não vira conflito (a versão do campo olha só os ids)', () => {
    const antes = G.lerCampo('versoes', [{ id: '16500', name: 'v', released: false }]).versao;
    const depois = G.lerCampo('versoes', [{ id: '16500', name: 'v', released: true, releaseDate: '2026-12-10' }]).versao;
    assert.strictEqual(antes, depois);
  });

  test('componentes: vários; nenhum deixa vazio', async () => {
    const j = jiraFalso({ components: [] });
    await G.gravarCampo(pedido('componentes', ['12272', '12271'], j.versao('componentes')), j.chamar);
    assert.deepStrictEqual(escritas(j)[0].corpo, { fields: { components: [{ id: '12271' }, { id: '12272' }] } });
    await G.gravarCampo(pedido('componentes', [], j.versao('componentes')), j.chamar);
    assert.deepStrictEqual(escritas(j)[1].corpo, { fields: { components: [] } });
  });

  test('mudou no Jira depois que a tela leu: recusa, não grava, e devolve o valor atual', async () => {
    const j = jiraFalso({ [ID('dataInterna')]: '2026-11-01' });
    const versaoVelha = j.versao('dataInterna');
    j.campos[ID('dataInterna')] = '2026-11-05';
    const r = await G.gravarCampo(pedido('dataInterna', '2026-11-30', versaoVelha), j.chamar);
    assert.strictEqual(r.conflito, true);
    assert.strictEqual(r.atual.campos.dataInterna.valor, '2026-11-05');
    assert.strictEqual(escritas(j).length, 0);
  });

  test('texto formatado no Jira: grava como texto simples; abrir e não mudar não grava (a formatação fica)', async () => {
    const formatado = doc(par(txt('Requisito ', []), txt('importante', [{ type: 'strong' }])));
    const j = jiraFalso({ [ID('situacaoRequisito')]: formatado });
    const lido = G.lerCampo('situacaoRequisito', formatado);
    assert.deepStrictEqual([lido.editavel, lido.formatado, lido.valor], [true, true, 'Requisito importante']);
    const igual = await G.gravarCampo(pedido('situacaoRequisito', 'Requisito importante', lido.versao), j.chamar);
    assert.strictEqual(igual.semMudanca, true);
    assert.strictEqual(escritas(j).length, 0);
    await G.gravarCampo(pedido('situacaoRequisito', 'Requisito novo', lido.versao), j.chamar);
    assert.deepStrictEqual(escritas(j)[0].corpo, { fields: { [ID('situacaoRequisito')]: doc(par(txt('Requisito novo'))) } });
  });

  test('mesmo valor: não grava nada (nem linha no histórico do Jira)', async () => {
    const j = jiraFalso({ [ID('solucao')]: doc(par(txt('igual'))), components: [{ id: '12271', name: 'X' }] });
    assert.strictEqual((await G.gravarCampo(pedido('solucao', '  igual \r\n', j.versao('solucao')), j.chamar)).semMudanca, true);
    assert.strictEqual((await G.gravarCampo(pedido('componentes', ['12271'], j.versao('componentes')), j.chamar)).semMudanca, true);
    assert.strictEqual(escritas(j).length, 0);
  });

  test('issue de outro projeto ou subtarefa: recusa mesmo com a chave certa', async () => {
    const fora = jiraFalso({}, { project: { key: 'CRED5' } });
    assert.strictEqual((await G.gravarCampo(pedido('solucao', 'x', G.versaoDe(null)), fora.chamar)).foraDoProjeto, true);
    const sub = jiraFalso({}, { issuetype: { name: 'Codificação', hierarchyLevel: -1, subtask: true } });
    assert.strictEqual((await G.gravarCampo(pedido('solucao', 'x', G.versaoDe(null)), sub.chamar)).foraDoProjeto, true);
  });
});

describe('ler os campos da expedição', () => {
  test('épico: as tasks filhas, sem canceladas; traz as opções de versão', async () => {
    const chamar = async (caminho) => {
      if (caminho.endsWith('/versions')) return [{ id: '1', name: 'v1' }];
      if (caminho.startsWith('/rest/api/3/issue/')) return { key: 'JDCBBRB-360', fields: { issuetype: { hierarchyLevel: 1 } } };
      return {
        issues: [
          { key: 'JDCBBRB-363', fields: { summary: 'A', status: { name: 'Concluído' }, fixVersions: [{ id: '1', name: 'v1' }], [ID('dataPrevista')]: '2026-10-22' } },
          { key: 'JDCBBRB-364', fields: { summary: 'B', status: { name: 'Cancelado' } } }
        ]
      };
    };
    const r = await G.lerCampos('JDCBBRB-360', 'versoes,dataPrevista', chamar);
    assert.strictEqual(r.tipo, 'epico');
    assert.deepStrictEqual(r.tarefas.map((t) => [t.chave, t.campos.versoes.valor, t.campos.dataPrevista.valor]), [['JDCBBRB-363', ['1'], '2026-10-22']]);
    assert.deepStrictEqual(r.definicoes.dataPrevista, { nome: 'Data prevista para entrega', tipo: 'data' });
    assert.strictEqual(r.opcoes.versoes[0].nome, 'v1');
    assert.strictEqual((await G.lerCampos('CRED5-1', 'solucao', chamar)).status, 'fora-do-projeto');
    assert.strictEqual((await G.lerCampos('JDCBBRB-1', 'status', chamar)).status, 'campo-invalido');
  });
});

describe('rotas', () => {
  const app = require('../server');
  const { criarSessao, COOKIE_NAME } = require('../auth');
  let servidor, base;
  before(async () => { await new Promise((r) => { servidor = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${servidor.address().port}`; });
  after(() => servidor && servidor.close());
  const cookie = (email) => `${COOKIE_NAME}=${criarSessao({ email })}`;
  const put = (chave, corpo, email) => fetch(`${base}/api/jira/campo/${chave}`, {
    method: 'PUT', redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(email ? { Cookie: cookie(email) } : {}) },
    body: JSON.stringify(corpo)
  });
  const corpo = { campo: 'solucao', valor: 'x', versao: 'a'.repeat(32) };

  test('sem login: 401; BRB e TOTVS: 403 (nada chega ao Jira)', async () => {
    assert.strictEqual((await put('JDCBBRB-1', corpo)).status, 401);
    assert.strictEqual((await put('JDCBBRB-1', corpo, 'cliente@brb.com.br')).status, 403);
    assert.strictEqual((await put('JDCBBRB-1', corpo, 'fulano@totvs.com.br')).status, 403);
    const g = await fetch(`${base}/api/jira/campos?chave=JDCBBRB-1&campos=solucao`, { headers: { Cookie: cookie('fulano@totvs.com.br') } });
    assert.strictEqual(g.status, 403);
  });

  test('Dimensa com chave de outro projeto ou campo fora da lista: 400 antes de falar com o Jira', async () => {
    assert.strictEqual((await put('CRED5-1', corpo, 'fulano@dimensa.com.br')).status, 400);
    assert.strictEqual((await put('JDCBBRB-1', { ...corpo, campo: 'status' }, 'fulano@dimensa.com.br')).status, 400);
    const g = await fetch(`${base}/api/jira/campos?chave=CRED5-1&campos=solucao`, { headers: { Cookie: cookie('fulano@evertecinc.com.br') } });
    assert.strictEqual(g.status, 400);
  });

  test('texto longo cabe no corpo (8000 caracteres com acento e quebra de linha)', async () => {
    const valor = ('ação\n').repeat(1600); // 8000 caracteres
    const r = await put('CRED5-1', { ...corpo, valor }, 'fulano@dimensa.com.br');
    assert.strictEqual(r.status, 400, 'chega na validação (não é barrado por tamanho do corpo)');
    assert.match((await r.json()).erro, /projeto JDCBBRB/);
  });
});
