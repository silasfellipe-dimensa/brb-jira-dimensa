// Evidências de teste: leitor do .mhtml do Zephyr (static/leitor-zephyr.js),
// regras do servidor (evidencias.js) e controle de acesso das rotas.
//
// O relatório usado aqui é SINTÉTICO, montado com a mesma estrutura do HTML
// do Zephyr Essential (tabelas ktm-*, aui-lozenge, CodeMirror) - nenhum dado
// de cliente entra no repositório. Nada sai para a rede: o Supabase aponta
// para 127.0.0.1:1 e as rotas testadas param antes do banco.

process.env.ALLOWED_DOMAINS = 'dimensa.com.br,totvs.com.br,brb.com.br,evertecinc.com.br';
process.env.ALLOWED_EMAILS = '';
process.env.SESSION_SECRET = 'segredo-de-teste-nao-usado-em-producao';
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_ANON_KEY = 'chave-de-teste';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'chave-de-servico-de-teste';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../static/leitor-zephyr');
const E = require('../evidencias');

// ---------- relatório sintético ----------

const IMG1 = 'https://cloudfront.exemplo/tenant/x/project/1/aaa-1.png';
const IMG_SEM_ARQUIVO = 'https://cloudfront.exemplo/tenant/x/project/1/bbb-2.png';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

const lozenge = (t) => `<span class="aui-lozenge ng-binding" title="${t}" style="color: rgb(255, 255, 255);">${t}</span>`;
const linhaCm = (html) => `<pre class=" CodeMirror-line " role="presentation"><span role="presentation">${html}</span></pre>`;

function caso({ chave, status, nome, resultado, script, imagens = [], issues = '-' }) {
  return `
<table class="ktm-test-result-table ng-scope" ng-repeat-start="testResult in x"><tbody>
<tr><td class="ktm-thin-column ktm-title-cell">Chave</td><td><a href="#/v2/testCase/${chave}">${chave}</a></td>
<td class="ktm-thin-column ktm-title-cell">Status</td><td>${lozenge(status)}</td>
<td class="ktm-thin-column ktm-title-cell">Nome</td><td colspan="2">${nome} </td></tr>
<tr><td class="ktm-thin-column ktm-title-cell">Objetivo</td><td colspan="5"><span>-</span></td></tr>
<tr><td class="ktm-thin-column ktm-title-cell">Precondição</td><td colspan="5"><span>-</span></td></tr>
<tr><td class="ktm-thin-column ktm-title-cell">Cobertura (problemas)</td><td colspan="5"><a href="https://x/browse/PROJ-201"> PROJ-201 </a></td></tr>
<tr><td class="ktm-thin-column ktm-title-cell">Data de término</td><td>01/Sep/26 3:57 pm</td>
<td class="ktm-thin-column ktm-title-cell">Tempo Estimado</td><td>00:00:00</td><td class="ktm-thin-column ktm-title-cell">Tempo</td><td>00:00:00</td></tr>
<tr><td class="ktm-thin-column ktm-title-cell">Atribuído a</td><td>ana.qa</td>
<td class="ktm-thin-column ktm-title-cell">Ambiente</td><td>-</td><td class="ktm-thin-column ktm-title-cell">Tipo</td><td><span>Execução manual</span></td></tr>
<tr><td class="ktm-thin-column ktm-title-cell">Executado por</td><td>ana.qa</td></tr>
<tr><td class="ktm-thin-column ktm-title-cell">Issues</td><td colspan="5">${issues}</td></tr>
</tbody></table>
<table class="ktm-test-script-result-table ng-scope"><tbody>
<tr><td colspan="6" class="ktm-title-cell ktm-align-center">Script de Teste</td></tr>
<tr><td class="ktm-title-cell ng-binding" rowspan="4"> 1 </td><td class="ktm-title-cell">Status</td><td colspan="4">${lozenge(status)}</td></tr>
<tr><td class="ktm-title-cell" style="width: 180px">Detalhes</td><td colspan="4"><div class="CodeMirror">
<div class="CodeMirror-measure"><pre class="CodeMirror-line-like"><span>xxxxxxxxxx</span></pre></div>
<div class="CodeMirror-code">${script.map(linhaCm).join('')}${linhaCm('<span cm-text="">​</span>')}</div></div></td></tr>
<tr><td class="ktm-title-cell" style="width: 180px">Resultado</td><td colspan="4"><div><span class="ktm-richtext">${imagens.map((u) => (u ? `<img src="${u}" style="width:300px">` : '<img style="width:300px">')).join('')}<br>${resultado}</span></div></td></tr>
<tr><td class="ktm-title-cell" style="width: 180px">Issues</td><td colspan="4"><span>-</span></td></tr>
</tbody></table>`;
}

const RELATORIO = `<html><body><!-- comentário do Angular -->
<div class="ktm-section-name">Ciclo de Teste</div>
<table><tbody>
<tr><td class="ktm-title-cell">Chave</td><td><a href="#/v2/testCycle/PROJ-R9"> PROJ-R9 </a></td><td class="ktm-title-cell">Nome</td><td colspan="3">Simular Opera&ccedil;&atilde;o V2</td></tr>
<tr><td class="ktm-title-cell">Descrição</td><td colspan="5"><span>Simular Operação V2</span></td></tr>
<tr><td class="ktm-title-cell">Data planejada de início</td><td>01/Sep/26 3:49 pm</td><td class="ktm-title-cell">Data planejada de fim</td><td>02/Sep/26 12:05 am</td><td class="ktm-title-cell">Iteração</td><td>no iteration</td></tr>
<tr><td class="ktm-title-cell">Status</td><td>${lozenge('Concluído')}</td><td class="ktm-title-cell">Versão de lançamento</td><td colspan="3">-</td></tr>
</tbody></table>
<div class="ktm-section-name">Resultados de Teste</div>
${caso({ chave: 'PROJ-T151', status: 'Sucesso', nome: 'Taxa dentro do intervalo', resultado: '15:57', imagens: [IMG1],
    script: ['<span class="cm-keyword">Given</span> que existe um plano', '<span class="cm-keyword">And</span> a taxa <span class="cm-string">"Mínima"</span> é 5.0%'] })}
${caso({ chave: 'PROJ-T156', status: 'Falha', nome: 'Taxa inválida', resultado: '17:16 - Não apresenta mensagem de erro', imagens: [IMG_SEM_ARQUIVO, ''],
    script: ['<span class="cm-keyword">When</span> eu informo "abc"'] })}
</body></html>`;

function qp(texto) {
  // quoted-printable do jeito do Chrome: bytes não-ASCII e "=" escapados, linhas de 76 com "=" no fim
  const bytes = Buffer.from(texto, 'utf8');
  let s = '';
  for (const b of bytes) s += (b > 126 || b === 61) ? '=' + b.toString(16).toUpperCase().padStart(2, '0') : String.fromCharCode(b);
  return s.replace(/(.{1,72}(?:=[0-9A-F]{2})?)/g, '$1=\r\n');
}

function mhtml() {
  const B = '----MultipartBoundary--teste123----';
  return [
    'From: <Saved by Blink>',
    'Subject: Zephyr Essential',
    'MIME-Version: 1.0',
    `Content-Type: multipart/related;\r\n\ttype="text/html";\r\n\tboundary="${B}"`,
    '',
    '',
    `--${B}`,
    'Content-Type: text/html',
    'Content-ID: <frame-0@mhtml.blink>',
    'Content-Transfer-Encoding: quoted-printable',
    'Content-Location: https://jira.exemplo/pagina',
    '',
    qp('<html><body>página do Jira em volta</body></html>'),
    `--${B}`,
    'Content-Type: text/html',
    'Content-Transfer-Encoding: quoted-printable',
    'Content-Location: https://frame.exemplo/relatorio',
    '',
    qp(RELATORIO),
    `--${B}`,
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    `Content-Location: ${IMG1}`,
    '',
    PNG.toString('base64'),
    `--${B}--`,
    ''
  ].join('\r\n');
}

// ---------- leitor ----------

describe('leitor do .mhtml do Zephyr', () => {
  const r = L.lerArquivo(mhtml());

  test('acha o relatório dentro do arquivo e lê o ciclo', () => {
    assert.strictEqual(r.ok, true, r.erro);
    assert.deepStrictEqual(r.relatorio.ciclo, {
      chave: 'PROJ-R9', nome: 'Simular Operação V2', descricao: 'Simular Operação V2', status: 'Concluído',
      inicioPlanejado: '2026-09-01T15:49', fimPlanejado: '2026-09-02T00:05', versao: '', iteracao: ''
    });
  });

  test('lê os casos com status, executor, data e cobertura', () => {
    const [a, b] = r.relatorio.casos;
    assert.strictEqual(r.relatorio.casos.length, 2);
    assert.strictEqual(a.chave, 'PROJ-T151');
    assert.strictEqual(a.status, 'sucesso');
    assert.strictEqual(a.nome, 'Taxa dentro do intervalo');
    assert.strictEqual(a.executadoPor, 'ana.qa');
    assert.strictEqual(a.dataTermino, '2026-09-01T15:57');
    assert.deepStrictEqual(a.cobertura, ['PROJ-201']);
    assert.strictEqual(a.ambiente, '', 'o "-" do Zephyr vira vazio');
    assert.strictEqual(a.objetivo, '');
    assert.strictEqual(b.status, 'falha');
  });

  test('script Gherkin linha a linha, sem a régua do editor ("xxxxxxxxxx") nem linha vazia no fim', () => {
    const p = r.relatorio.casos[0].passos[0];
    assert.deepStrictEqual(p.script, ['Given que existe um plano', 'And a taxa "Mínima" é 5.0%']);
    assert.strictEqual(p.status, 'sucesso');
    assert.strictEqual(p.resultado, '15:57');
  });

  test('a imagem do resultado vira ref, com os bytes do próprio arquivo', () => {
    assert.deepStrictEqual(r.relatorio.casos[0].passos[0].imagens, [{ ref: 'img1' }]);
    assert.deepStrictEqual(Object.keys(r.imagens), ['img1']);
    assert.strictEqual(r.imagens.img1.tipo, 'image/png');
    assert.ok(Buffer.from(r.imagens.img1.base64, 'base64').equals(PNG));
  });

  test('imagem que não veio no arquivo e imagem quebrada viram aviso, não figura vazia', () => {
    assert.deepStrictEqual(r.relatorio.casos[1].passos[0].imagens, []);
    assert.ok(r.relatorio.avisos.some((a) => /PROJ-T156.*imagem sem arquivo/.test(a)));
    assert.ok(r.relatorio.avisos.some((a) => /PROJ-T156.*não veio no arquivo/.test(a)));
  });

  test('arquivo que não é .mhtml, ou .mhtml sem o relatório, dá erro claro', () => {
    assert.match(L.lerArquivo('<html>oi</html>').erro, /arquivo único/);
    const semRelatorio = mhtml().replace(/ktm-test-result-table/g, 'outra-coisa');
    assert.strictEqual(L.lerArquivo(semRelatorio).ok, false);
  });

  test('relatório sem a chave do ciclo dá erro (layout do Zephyr mudou)', () => {
    const r2 = L.lerRelatorio(RELATORIO.replace(/PROJ-R9/g, 'sem-chave'));
    assert.strictEqual(r2.ok, false);
    assert.match(r2.erro, /ciclo/);
  });

  test('datas do Zephyr: 12 am é meia-noite, 12 pm é meio-dia, sem hora fica só a data', () => {
    assert.strictEqual(L.dataZephyr('01/Sep/26 3:57 pm'), '2026-09-01T15:57');
    assert.strictEqual(L.dataZephyr('02/Sep/26 12:05 am'), '2026-09-02T00:05');
    assert.strictEqual(L.dataZephyr('02/Sep/26 12:05 pm'), '2026-09-02T12:05');
    assert.strictEqual(L.dataZephyr('15/Dez/2026'), '2026-12-15');
    assert.strictEqual(L.dataZephyr('-'), '');
  });

  test('status em português e inglês', () => {
    assert.strictEqual(L.codigoStatus('Sucesso'), 'sucesso');
    assert.strictEqual(L.codigoStatus('Pass'), 'sucesso');
    assert.strictEqual(L.codigoStatus('Falha'), 'falha');
    assert.strictEqual(L.codigoStatus('Bloqueado'), 'bloqueado');
    assert.strictEqual(L.codigoStatus('Não executado'), 'nao_executado');
    assert.strictEqual(L.codigoStatus('Algo novo'), 'outro');
  });

  test('resultado geral: falha manda, depois bloqueio, depois pendência', () => {
    const c = (...st) => st.map((status) => ({ status }));
    assert.strictEqual(L.resultadoGeral(c('sucesso', 'sucesso')), 'aprovado');
    assert.strictEqual(L.resultadoGeral(c('sucesso', 'bloqueado', 'falha')), 'reprovado');
    assert.strictEqual(L.resultadoGeral(c('sucesso', 'bloqueado')), 'bloqueado');
    assert.strictEqual(L.resultadoGeral(c('sucesso', 'nao_executado')), 'incompleto');
    assert.strictEqual(L.resultadoGeral([]), 'sem_casos');
  });

  test('ACS no começo do título da task', () => {
    assert.strictEqual(L.acsDoTitulo('20260630006  - Alterar serviço'), '20260630006');
    assert.strictEqual(L.acsDoTitulo('Alterar serviço 20260630006'), '');
    assert.strictEqual(L.acsDoTitulo('202606300061 - doze dígitos'), '');
  });
});

// ---------- regras do servidor ----------

describe('evidencias.js: o servidor não confia no JSON do navegador', () => {
  const lido = L.lerArquivo(mhtml()).relatorio;

  test('cria a linha com título, task coberta e resultado calculados do relatório', () => {
    const n = E.normalizarNovaEvidencia({ relatorio: lido, arquivoNome: 'r9.mhtml' });
    assert.strictEqual(n.ok, true, n.erro);
    assert.strictEqual(n.linha.titulo, 'Simular Operação V2');
    assert.strictEqual(n.linha.jira, 'PROJ-201');
    assert.strictEqual(n.linha.ciclo_chave, 'PROJ-R9');
    assert.strictEqual(n.linha.resultado, 'reprovado');
    assert.strictEqual(n.linha.total_casos, 2);
    assert.strictEqual(n.linha.total_imagens, 1);
    assert.deepStrictEqual([...n.refs], ['img1']);
  });

  test('resultado mandado pelo navegador é ignorado (recalculado dos casos)', () => {
    const n = E.normalizarNovaEvidencia({ relatorio: lido, resultado: 'aprovado' });
    assert.strictEqual(n.linha.resultado, 'reprovado');
  });

  test('campo estranho, status inventado e ref repetida não passam', () => {
    const sujo = JSON.parse(JSON.stringify(lido));
    sujo.casos[0].status = '<script>';
    sujo.casos[0].extra = 'x';
    sujo.casos[0].passos[0].imagens.push({ ref: 'img1' }, { ref: '../../etc' });
    const n = E.normalizarNovaEvidencia({ relatorio: sujo });
    const c = n.linha.dados.casos[0];
    assert.strictEqual(c.status, 'outro');
    assert.strictEqual(c.extra, undefined);
    assert.deepStrictEqual(c.passos[0].imagens.map((i) => i.ref), ['img1']);
  });

  test('sem chave de ciclo válida ou sem casos: recusa', () => {
    assert.strictEqual(E.normalizarNovaEvidencia({ relatorio: { ...lido, ciclo: { chave: 'R9' } } }).ok, false);
    assert.strictEqual(E.normalizarNovaEvidencia({ relatorio: { ...lido, casos: [] } }).ok, false);
    assert.strictEqual(E.normalizarNovaEvidencia({}).ok, false);
  });

  test('ACS e task do Jira: formato conferido, vazio é permitido', () => {
    assert.strictEqual(E.normalizarCampos({ acs: '2026063000' }).ok, false);
    assert.strictEqual(E.normalizarCampos({ jira: 'nao é chave' }).ok, false);
    assert.deepStrictEqual(E.normalizarCampos({ acs: '', jira: '' }).registro, { acs: '', jira: '' });
    assert.deepStrictEqual(E.normalizarCampos({ acs: '20260630006', jira: 'jdcbbrb-201' }).registro, { acs: '20260630006', jira: 'JDCBBRB-201' });
    assert.strictEqual(E.normalizarCampos({ titulo: 42 }).ok, false);
    assert.strictEqual(E.normalizarCampos({}, { exigirAlgum: true }).ok, false);
  });

  test('imagem: tipo pelos bytes, nunca pelo cabeçalho', () => {
    assert.deepStrictEqual(E.tipoDaImagem(PNG), { tipo: 'image/png', ext: 'png' });
    assert.deepStrictEqual(E.tipoDaImagem(Buffer.from('ffd8ffe000104a4649460001', 'hex')), { tipo: 'image/jpeg', ext: 'jpg' });
    assert.strictEqual(E.tipoDaImagem(Buffer.from('<svg onload=alert(1)>....')), null);
    assert.strictEqual(E.tipoDaImagem(null), null);
  });

  test('ref de imagem e id: só o formato esperado', () => {
    assert.strictEqual(E.refImagem('img12'), 'img12');
    assert.strictEqual(E.refImagem('../img1'), null);
    assert.strictEqual(E.idEvidencia('12'), 12);
    assert.strictEqual(E.idEvidencia('1; drop'), null);
    assert.deepStrictEqual([...E.refsDoRelatorio(E.normalizarNovaEvidencia({ relatorio: lido }).linha.dados)], ['img1']);
  });
});

// ---------- rotas ----------

describe('task do Jira: busca enquanto digita e o que vem dela', () => {
  test('chave inteira, só o número ou título; curto demais não busca', () => {
    assert.deepStrictEqual(E.termoBuscaTask('jdcbbrb-0201'), { termo: 'jdcbbrb-0201', chave: 'JDCBBRB-201' });
    assert.deepStrictEqual(E.termoBuscaTask('201'), { termo: '201', chave: 'JDCBBRB-201' });
    assert.strictEqual(E.termoBuscaTask('20260630006').chave, '', 'ACS (11 dígitos) não vira chave');
    assert.strictEqual(E.termoBuscaTask('simular taxa').chave, '');
    assert.strictEqual(E.termoBuscaTask('a'), null);
    assert.strictEqual(E.termoBuscaTask('  '), null);
    assert.strictEqual(E.termoBuscaTask(undefined), null);
  });

  test('JQL: só no projeto do BRB, sem aspas nem operadores vindos do campo', () => {
    const jql = E.jqlBuscaTask(E.termoBuscaTask('simular" OR project = X ~ (taxa)'));
    assert.match(jql, /^project = JDCBBRB AND summary ~ "[^"]*\*" ORDER BY updated DESC$/);
    assert.ok(!/[()~=]/.test(jql.split('"')[1]), 'nada de JQL dentro das aspas');
    assert.match(E.jqlBuscaTask(E.termoBuscaTask('simul')), /summary ~ "simul\*"/);
    assert.strictEqual(E.jqlBuscaTask(E.termoBuscaTask('--')), '', 'só pontuação não busca');
  });

  test('sugestões: a chave exata primeiro, depois as com ACS, sem repetir, no máximo 10', () => {
    const i = (key, summary, tipo) => ({ key, fields: { summary, issuetype: { name: tipo || 'Epico' } } });
    const achadas = [i('JDCBBRB-5', 'Codificação'), i('JDCBBRB-201', '20260630006 - Simular'), i('JDCBBRB-7', '20260101001 - Outra')];
    const r = E.sugestoesTask(i('JDCBBRB-9', 'Exata'), achadas.concat([i('JDCBBRB-201', 'repetida')]));
    assert.deepStrictEqual(r.map((t) => t.chave), ['JDCBBRB-9', 'JDCBBRB-201', 'JDCBBRB-7', 'JDCBBRB-5']);
    assert.deepStrictEqual(r[1], { chave: 'JDCBBRB-201', titulo: '20260630006 - Simular', tipo: 'Epico', acs: '20260630006' });
    const muitas = Array.from({ length: 15 }, (_, n) => i('JDCBBRB-' + (n + 1), 't'));
    assert.strictEqual(E.sugestoesTask(null, muitas).length, E.MAX_SUGESTOES);
    assert.deepStrictEqual(E.sugestoesTask(null, null), []);
  });

  test('versão: nomes das "Versões corrigidas", sem repetir, de uma ou várias issues', () => {
    const v = (...nomes) => ({ fields: { fixVersions: nomes.map((name) => ({ name })) } });
    assert.strictEqual(E.versoesDe([v('DJSBRB_6.4.1.0')]), 'DJSBRB_6.4.1.0');
    assert.strictEqual(E.versoesDe([v('DJSCF_6.8.1.4'), v('DJSBRB_6.4.2.0', 'DJSCF_6.8.1.4'), {}]), 'DJSCF_6.8.1.4, DJSBRB_6.4.2.0');
    assert.strictEqual(E.versoesDe([v(), null]), '');
  });
});

describe('rotas de evidências: todos veem, só a equipe mexe', () => {
  const app = require('../server');
  const { criarSessao, COOKIE_NAME } = require('../auth');
  let servidor;
  let base;
  before(async () => {
    await new Promise((ok) => { servidor = app.listen(0, '127.0.0.1', ok); });
    base = `http://127.0.0.1:${servidor.address().port}`;
  });
  after(() => servidor && servidor.close());
  const cookie = (email) => `${COOKIE_NAME}=${criarSessao({ email })}`;
  const pedir = (caminho, opcoes = {}) => fetch(base + caminho, { redirect: 'manual', ...opcoes });

  test('sem login: a tela manda para o login e a API responde 401', async () => {
    assert.strictEqual((await pedir('/evidencias')).status, 302);
    assert.strictEqual((await pedir('/api/evidencias')).status, 401);
    assert.strictEqual((await pedir('/api/evidencias/1/imagens/img1')).status, 401);
  });

  test('o BRB abre a tela', async () => {
    const r = await pedir('/evidencias', { headers: { Cookie: cookie('cliente@brb.com.br') } });
    assert.strictEqual(r.status, 200);
    assert.match(await r.text(), /<nav data-menu="evidencias">/);
  });

  test('o BRB não cria, não edita, não exclui, não envia imagem e não consulta o Jira', async () => {
    const h = { Cookie: cookie('cliente@brb.com.br'), 'Content-Type': 'application/json' };
    assert.strictEqual((await pedir('/api/evidencias', { method: 'POST', headers: h, body: '{}' })).status, 403);
    assert.strictEqual((await pedir('/api/evidencias/1', { method: 'PATCH', headers: h, body: '{"titulo":"x"}' })).status, 403);
    assert.strictEqual((await pedir('/api/evidencias/1', { method: 'DELETE', headers: h })).status, 403);
    assert.strictEqual((await pedir('/api/evidencias/1/imagens/img1', { method: 'PUT', headers: { Cookie: h.Cookie, 'Content-Type': 'image/png' }, body: PNG })).status, 403);
    assert.strictEqual((await pedir('/api/evidencias/jira/PROJ-201', { headers: h })).status, 403);
    assert.strictEqual((await pedir('/api/evidencias/jira?q=simular', { headers: h })).status, 403);
  });

  test('a equipe: pedido inválido é recusado antes do banco', async () => {
    const h = { Cookie: cookie('qa@dimensa.com.br'), 'Content-Type': 'application/json' };
    assert.strictEqual((await pedir('/api/evidencias', { method: 'POST', headers: h, body: '{"relatorio":{}}' })).status, 400);
    assert.strictEqual((await pedir('/api/evidencias/abc', { method: 'PATCH', headers: h, body: '{"titulo":"x"}' })).status, 400);
    assert.strictEqual((await pedir('/api/evidencias/1', { method: 'PATCH', headers: h, body: '{"acs":"123"}' })).status, 400);
    assert.strictEqual((await pedir('/api/evidencias/jira/nao-e-chave', { headers: h })).status, 400);
    const naoImagem = await pedir('/api/evidencias/1/imagens/img1', { method: 'PUT', headers: { Cookie: h.Cookie, 'Content-Type': 'image/png' }, body: '<svg></svg>' });
    assert.strictEqual(naoImagem.status, 400);
    assert.strictEqual((await pedir('/api/evidencias/1/imagens/..%2Fx', { headers: { Cookie: h.Cookie } })).status, 400);
  });

  test('o leitor e a logo são públicos (código e imagem, sem dado)', async () => {
    const js = await pedir('/leitor-zephyr.js');
    assert.strictEqual(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.strictEqual((await pedir('/logo-evertec.png')).status, 200);
  });
});

describe('menu e tela', () => {
  test('Evidências no menu para todos (não é só da equipe), depois de Expedições', () => {
    const codigo = fs.readFileSync(path.join(__dirname, '..', 'static', 'menu.js'), 'utf8');
    const item = /\{ id: 'evidencias'[^}]*\}/.exec(codigo);
    assert.ok(item, 'item no menu');
    assert.ok(!/soEquipe/.test(item[0]));
    assert.ok(codigo.indexOf("{ id: 'expedicoes'") < codigo.indexOf("{ id: 'evidencias'"));
    assert.ok(codigo.indexOf("{ id: 'evidencias'") < codigo.indexOf("{ id: 'dashboard'"));
  });

  test('a tela carrega o leitor e usa o menu único', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'paginas', 'evidencias.html'), 'utf8');
    assert.ok(html.includes('<script src="/leitor-zephyr.js"></script>'));
    assert.ok(html.includes('<script src="/menu.js"></script>'));
    assert.ok(html.indexOf('<nav data-menu="evidencias">') < html.indexOf('</header>'));
  });
});
