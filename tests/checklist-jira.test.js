// Itens do checklist que o Jira responde sozinho (checklistJira.js) e a aplicação deles
// sobre os itens da expedição (expedicoes.js). Sem rede: o Jira é uma função falsa com
// respostas no formato real (texto simples, documento ADF, épico, 404).

const { test, describe } = require('node:test');
const assert = require('node:assert');

const J = require('../checklistJira');
const { ITENS_PADRAO, aplicarVerificacao, somenteLeituraPeloJira, decorar, deLinhaItem } = require('../expedicoes');

const adf = (texto) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: texto ? [{ type: 'text', text: texto }] : [] }] });
const sub = (key, categoriaStatus, summary = 'Codificação - x', nome = 'x') => ({ key, fields: { summary, status: { name: nome, statusCategory: { key: categoriaStatus } } } });
const tudoPreenchido = () => ({
  description: adf('Descrição'), customfield_12864: adf('Solução'), customfield_12369: adf('Situação'),
  customfield_13096: adf('Docs'), customfield_12181: '2026-10-08', customfield_12456: '2026-10-07',
  components: [{ name: 'SATÉLITE BRBCFI WEB VI' }], fixVersions: [{ name: 'DJSBRB_6.4.2.0' }], customfield_12379: '2026-09-28',
  status: { name: 'Concluído' }, subtasks: [sub('A-1', 'done'), sub('A-2', 'done', 'Documentação - x', 'Fechado')]
});

describe('o que conta como "preenchido"', () => {
  test('texto simples e documento ADF: vazio, espaços e parágrafo vazio não contam; imagem e link contam', () => {
    for (const vazio of [null, undefined, '', '   ', adf(''), adf('   '), { type: 'doc', content: [] }, [], {}]) {
      assert.strictEqual(J.temConteudo(vazio), false, JSON.stringify(vazio));
    }
    for (const cheio of ['x', adf('texto'), { type: 'doc', content: [{ type: 'mediaSingle', content: [{ type: 'media', attrs: {} }] }] },
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url: 'https://x' } }] }] }, 0, { name: 'Opção' }]) {
      assert.strictEqual(J.temConteudo(cheio), true, JSON.stringify(cheio));
    }
  });
});

describe('regras: cada item aponta para o campo certo', () => {
  test('todo texto de regra existe nos itens padrão (se alguém renomear um item, o teste avisa)', () => {
    const itens = ITENS_PADRAO.map((i) => i.texto);
    assert.deepStrictEqual(J.TEXTOS_JIRA.filter((t) => !itens.includes(t)), []);
    assert.strictEqual(J.TEXTOS_JIRA.length, 10);
  });

  test('task com tudo preenchido: os 10 itens ok, sem motivo', () => {
    const r = J.avaliarTask(tudoPreenchido());
    assert.deepStrictEqual(Object.keys(r).sort(), [...J.TEXTOS_JIRA].sort());
    for (const [t, v] of Object.entries(r)) assert.deepStrictEqual([t, v.ok, v.motivo], [t, true, '']);
  });

  test('task vazia: tudo falta, cada item diz o que falta ("... no Jira")', () => {
    const r = J.avaliarTask({ status: { name: 'Em Desenvolvimento' }, subtasks: [] });
    assert.ok(Object.values(r).every((v) => !v.ok));
    assert.strictEqual(r['Descrição preenchida?'].motivo, 'Descrição vazia no Jira');
    assert.strictEqual(r['Solução preenchida?'].motivo, 'Solução vazia no Jira');
    assert.strictEqual(r['Situação / Requisito preenchido'].motivo, 'Situação/Requisito vazio no Jira');
    assert.strictEqual(r['Demais Documentações preenchidas'].motivo, 'Demais Documentações vazia no Jira');
    assert.strictEqual(r['Data interna acordada registrada? (boa prática)'].motivo, 'Data Interna Acordada vazia no Jira');
    assert.strictEqual(r['Todas as subtarefas concluídas'].motivo, 'sem subtarefas no Jira');
    assert.strictEqual(r['Status: Teste de aceitação concluído'].motivo, 'status "Em Desenvolvimento" no Jira');
    assert.strictEqual(r['O componente corresponde ao módulo da versão?'].motivo, 'Componentes vazio no Jira');
    assert.strictEqual(r['A issue tem a versão correta para a data de entrega?'].motivo, 'Versões corrigidas vazias e Data prevista para entrega vazia no Jira');
    assert.strictEqual(r['Documentos de Configuração preenchidos?'].motivo, 'sem subtarefa "Documentação" no Jira');
  });

  test('componente: campo Componentes do Jira preenchido', () => {
    const f = (c) => J.avaliarTask({ components: c })['O componente corresponde ao módulo da versão?'];
    assert.ok(f([{ name: 'SATÉLITE BRBCFI WEB VI' }]).ok);
    assert.strictEqual(f([]).ok, false);
    assert.strictEqual(f(undefined).ok, false);
  });

  test('versão para a data de entrega: precisa de "Versões corrigidas" E "Data prevista para entrega"; diz qual falta', () => {
    const f = (c) => J.avaliarTask(c)['A issue tem a versão correta para a data de entrega?'];
    assert.ok(f({ fixVersions: [{ name: 'DJSBRB_6.4.2.0' }], customfield_12379: '2026-09-28' }).ok);
    assert.strictEqual(f({ fixVersions: [{ name: 'DJSBRB_6.4.2.0' }] }).motivo, 'Data prevista para entrega vazia no Jira');
    assert.strictEqual(f({ customfield_12379: '2026-09-28', fixVersions: [] }).motivo, 'Versões corrigidas vazias no Jira');
  });

  test('documentação: subtarefa com título "Documentação..." concluída OU cancelada (categoria done); aberta derruba', () => {
    const f = (...s) => J.avaliarTask({ subtasks: s })['Documentos de Configuração preenchidos?'];
    assert.ok(f(sub('A-1', 'new'), sub('A-2', 'done', 'Documentação - DEV - x', 'Fechado')).ok, 'fechada; a outra subtarefa não importa');
    assert.ok(f(sub('A-2', 'done', 'Documentação - x', 'Cancelado')).ok, 'cancelada também vale');
    assert.ok(f(sub('A-2', 'done', 'DOCUMENTACAO - sem acento', 'Concluído')).ok, 'sem acento e maiúsculo');
    const aberta = f(sub('A-2', 'new', 'Documentação - x', 'Aberto'));
    assert.strictEqual(aberta.ok, false);
    assert.strictEqual(aberta.motivo, 'subtarefa Documentação em aberto (A-2) no Jira');
    assert.strictEqual(f(sub('A-3', 'done', 'Documentação - a'), sub('A-4', 'indeterminate', 'Documentação - b')).ok, false, 'havendo duas, as duas precisam estar finalizadas');
    assert.strictEqual(f(sub('A-1', 'done', 'Documento Técnico qualquer')).ok, false, 'é pelo título "Documentação", não pelo tipo');
  });

  test('Demais Documentações: vale qualquer um dos dois campos com esse nome', () => {
    const a = J.avaliarTask({ customfield_12493: 'só no campo de linha' })['Demais Documentações preenchidas'];
    const b = J.avaliarTask({ customfield_13096: adf('só no campo de texto longo') })['Demais Documentações preenchidas'];
    assert.ok(a.ok && b.ok);
  });

  test('subtarefas: todas "concluídas" (categoria done, inclusive canceladas) — uma aberta derruba e é citada', () => {
    const f = (...s) => J.avaliarTask({ subtasks: s })['Todas as subtarefas concluídas'];
    assert.ok(f(sub('A-1', 'done'), sub('A-2', 'done')).ok);
    const r = f(sub('A-1', 'done'), sub('A-2', 'indeterminate'), sub('A-3', 'new'));
    assert.strictEqual(r.ok, false);
    assert.match(r.motivo, /2 subtarefa\(s\) em aberto \(A-2, A-3\)/);
    assert.strictEqual(f().ok, false, 'sem subtarefas não vira "ok" por falta do que conferir');
  });

  test('teste de aceitação: vale a data de conclusão OU o status "Teste de Aceitação Concluído" ou posterior', () => {
    const f = (campos) => J.avaliarTask(campos)['Status: Teste de aceitação concluído'];
    assert.ok(f({ customfield_12456: '2026-10-07', status: { name: 'Em Desenvolvimento' } }).ok, 'pela data');
    for (const nome of ['Teste de Aceitação Concluído', 'TESTE DE ACEITACAO CONCLUIDO', 'Implantação', 'Concluído']) {
      assert.ok(f({ status: { name: nome } }).ok, nome);
    }
    for (const nome of ['Em Desenvolvimento', 'Aberto', 'Desenvolvimento Concluído', 'Reaberto', undefined]) {
      assert.strictEqual(f({ status: nome ? { name: nome } : null }).ok, false, String(nome));
    }
  });

  test('épico: o item só fica ok se TODAS as tasks cumprem; o detalhe mostra task por task', () => {
    const ok = tudoPreenchido();
    const parcial = { ...tudoPreenchido(), customfield_12864: null };
    const r = J.avaliarEpico([{ key: 'E-1', fields: ok }, { key: 'E-2', fields: parcial }, { key: 'E-3', fields: ok }]);
    assert.strictEqual(r['Descrição preenchida?'].ok, true);
    assert.strictEqual(r['Descrição preenchida?'].detalhe, 'E-1 ✓ · E-2 ✓ · E-3 ✓');
    assert.strictEqual(r['Solução preenchida?'].ok, false);
    assert.strictEqual(r['Solução preenchida?'].motivo, 'Solução: falta em E-2');
    assert.strictEqual(r['Solução preenchida?'].detalhe, 'E-1 ✓ · E-2 ✗ · E-3 ✓');
  });
});

describe('lerDoJira: o que pede e como interpreta', () => {
  const issueTask = (campos) => ({ fields: { issuetype: { name: 'Participativo', hierarchyLevel: 0 }, ...campos } });
  const fake = (rotas) => {
    const chamadas = [];
    const f = async (caminho) => {
      chamadas.push(caminho);
      for (const [padrao, resp] of rotas) {
        if (caminho.includes(padrao)) { if (resp instanceof Error) throw resp; return typeof resp === 'function' ? resp(caminho) : resp; }
      }
      throw new Error('rota inesperada ' + caminho);
    };
    f.chamadas = chamadas;
    return f;
  };

  test('task: lê só a issue e avalia; pede apenas os campos necessários', async () => {
    const chamar = fake([['/rest/api/3/issue/AAA-1', issueTask(tudoPreenchido())]]);
    const r = await J.lerDoJira('AAA-1', chamar);
    assert.strictEqual(r.status, 'ok'); assert.strictEqual(r.tipo, 'task');
    assert.ok(Object.values(r.itens).every((v) => v.ok));
    assert.strictEqual(chamar.chamadas.length, 1);
    assert.match(chamar.chamadas[0], /fields=summary,issuetype,status,description,subtasks,customfield_12864/);
    assert.match(chamar.chamadas[0], /,components,fixVersions,customfield_12379$/);
  });

  test('épico: busca as tasks filhas (sem subtarefas) e ignora canceladas e recusadas', async () => {
    const filho = (key, status, campos) => ({ key, fields: { status: { name: status }, issuetype: { name: 'Task' }, ...campos } });
    const chamar = fake([
      ['/rest/api/3/issue/EEE-1', { fields: { issuetype: { name: 'Epico', hierarchyLevel: 1 } } }],
      ['/rest/api/3/search/jql', { issues: [filho('F-1', 'Concluído', tudoPreenchido()), filho('F-2', 'Cancelado', {}), filho('F-3', 'Recusado', {})] }]
    ]);
    const r = await J.lerDoJira('EEE-1', chamar);
    assert.strictEqual(r.tipo, 'epico'); assert.strictEqual(r.filhos, 1);
    assert.ok(Object.values(r.itens).every((v) => v.ok), 'só a F-1 conta, e ela cumpre tudo');
    assert.match(decodeURIComponent(chamar.chamadas[1]), /parent = EEE-1 AND issuetype not in subTaskIssueTypes\(\)/);
  });

  test('épico sem nenhuma task válida: "sem-filhos" (e nada é marcado)', async () => {
    const chamar = fake([
      ['/rest/api/3/issue/EEE-2', { fields: { issuetype: { hierarchyLevel: 1 } } }],
      ['/rest/api/3/search/jql', { issues: [{ key: 'F-1', fields: { status: { name: 'Cancelado' }, issuetype: { name: 'Task' } } }] }]
    ]);
    assert.deepStrictEqual(await J.lerDoJira('EEE-2', chamar), { status: 'sem-filhos', tipo: 'epico', filhos: 0 });
  });

  test('tipos de task ignorados (lista configurável) não entram na conta do épico', async () => {
    J.TIPOS_IGNORADOS.push('avaliacao/estimativa');
    try {
      const filho = (key, tipo, campos) => ({ key, fields: { status: { name: 'Resolvido' }, issuetype: { name: tipo }, ...campos } });
      const chamar = fake([
        ['/rest/api/3/issue/EEE-3', { fields: { issuetype: { hierarchyLevel: 1 } } }],
        ['/rest/api/3/search/jql', { issues: [filho('F-1', 'Manutenção', tudoPreenchido()), filho('F-2', 'Avaliação/Estimativa', {})] }]
      ]);
      const r = await J.lerDoJira('EEE-3', chamar);
      assert.strictEqual(r.filhos, 1);
      assert.ok(Object.values(r.itens).every((v) => v.ok));
    } finally { J.TIPOS_IGNORADOS.length = 0; }
  });

  test('chave que o Jira não conhece (404) ou inválida (400) vira "nao-encontrada"; outro erro sobe', async () => {
    assert.deepStrictEqual(await J.lerDoJira('X-1', fake([['/issue/', new Error('Jira respondeu 404 (board ou sprint não encontrado) em /rest/api/3/issue/X-1')]])), { status: 'nao-encontrada' });
    assert.deepStrictEqual(await J.lerDoJira('X-1', fake([['/issue/', new Error('Jira respondeu 400 em /rest/api/3/issue/X-1')]])), { status: 'nao-encontrada' });
    for (const msg of ['Jira respondeu 401 (token inválido ou expirado) em /x', 'Jira respondeu 500 em /x', 'Jira não respondeu em 10000ms (/x)', 'fetch failed']) {
      await assert.rejects(() => J.lerDoJira('X-1', fake([['/issue/', new Error(msg)]])), (e) => e.message === msg);
    }
  });
});

describe('cache e indisponibilidade', () => {
  const ok = { status: 'ok', tipo: 'task', filhos: 0, itens: {} };

  test('cache curto: a segunda leitura não vai ao Jira; "forçar" vai; expira depois do prazo', async () => {
    let agora = 1000; let chamadas = 0;
    const cache = J.criarCache(5000, () => agora);
    const chamar = async () => { chamadas++; return { fields: { issuetype: { hierarchyLevel: 0 }, status: { name: 'Aberto' } } }; };
    await J.verificar('A-1', chamar, { cache }); await J.verificar('A-1', chamar, { cache });
    assert.strictEqual(chamadas, 1);
    await J.verificar('A-1', chamar, { cache, forcar: true });
    assert.strictEqual(chamadas, 2);
    agora += 5001;
    await J.verificar('A-1', chamar, { cache });
    assert.strictEqual(chamadas, 3);
  });

  test('Jira fora do ar: devolve a última leitura marcada como desatualizada; sem leitura anterior, "indisponivel"', async () => {
    const cache = J.criarCache(10, () => 0);
    const bom = async () => ({ fields: { issuetype: { hierarchyLevel: 0 }, status: { name: 'Aberto' } } });
    const ruim = async () => { throw new Error('fetch failed'); };
    const sem = await J.verificar('B-1', ruim, { cache });
    assert.strictEqual(sem.status, 'indisponivel'); assert.match(sem.erro, /fetch failed/);
    await J.verificar('B-2', bom, { cache });
    cache.limpar();
    cache.guardar('B-2', { ...ok, lidoEm: 'antes' });
    const velho = await J.verificar('B-2', ruim, { cache: J.criarCache(0, () => 0), forcar: true });
    assert.strictEqual(velho.status, 'indisponivel', 'cache vazio: sem o que mostrar');
    const c2 = J.criarCache(10, () => 100); c2.guardar('B-3', { ...ok, lidoEm: 'antes' });
    const dep = await J.verificar('B-3', ruim, { cache: c2, forcar: true });
    assert.strictEqual(dep.status, 'ok'); assert.strictEqual(dep.desatualizado, true); assert.strictEqual(dep.lidoEm, 'antes');
  });

  test('várias chaves: repetidas contam uma vez; em lotes; e o que passa do teto de tempo vira "indisponivel"', async () => {
    const vistas = [];
    const chamar = async (caminho) => {
      vistas.push(caminho);
      if (caminho.includes('LENTA-1')) await new Promise((r) => setTimeout(r, 300));
      return { fields: { issuetype: { hierarchyLevel: 0 }, status: { name: 'Aberto' } } };
    };
    const r = await J.verificarVarias(['A-1', 'A-1', 'A-2', 'LENTA-1'], chamar, { limite: 2, tetoMs: 60 });
    assert.strictEqual(vistas.filter((c) => c.includes('/A-1')).length, 1);
    assert.strictEqual(r['A-1'].status, 'ok'); assert.strictEqual(r['A-2'].status, 'ok');
    assert.strictEqual(r['LENTA-1'].status, 'indisponivel'); assert.strictEqual(r['LENTA-1'].erro, 'tempo esgotado');
  });
});

describe('aplicação sobre os itens da expedição', () => {
  const item = (texto, estado = 'pendente', extra = {}) => ({ id: texto.length, bloco: 'comitar', texto, padrao: true, estado, ...extra });
  const verif = (itens, extra = {}) => ({ status: 'ok', tipo: 'task', filhos: 0, itens, lidoEm: '2026-10-13T12:00:00Z', ...extra });
  const OK = { ok: true, motivo: '', detalhe: '' };
  const FALTA = (motivo) => ({ ok: false, motivo, detalhe: '' });

  test('campo preenchido no Jira: o item vem MARCADO e TRAVADO, mesmo que estivesse pendente', () => {
    const itens = [item('Solução preenchida?', 'pendente'), item('Descrição preenchida?', 'concluido')];
    const r = aplicarVerificacao(itens, verif({ 'Solução preenchida?': OK, 'Descrição preenchida?': OK }));
    assert.deepStrictEqual(r.map((i) => [i.estado, i.bloqueado, i.automatico, i.jira.ok]), [['concluido', true, true, true], ['concluido', true, true, true]]);
    assert.strictEqual(itens[0].estado, 'pendente', 'não altera o original');
  });

  test('campo vazio no Jira: o item continua LIVRE e com o estado que a pessoa gravou; o motivo vem só como informação', () => {
    const itens = [item('Solução preenchida?', 'pendente'), item('Descrição preenchida?', 'concluido')];
    const r = aplicarVerificacao(itens, verif({ 'Solução preenchida?': FALTA('Solução vazia no Jira'), 'Descrição preenchida?': FALTA('Descrição vazia no Jira') }));
    assert.deepStrictEqual(r.map((i) => [i.estado, i.bloqueado]), [['pendente', false], ['concluido', false]], 'marcado à mão continua marcado');
    assert.strictEqual(r[0].jira.motivo, 'Solução vazia no Jira');
    assert.strictEqual(r[0].automatico, true);
  });

  test('quando o Jira passa a ter o campo, o item que estava marcado à mão passa a travado; N/A só some se o Jira confirma', () => {
    const itens = [item('Solução preenchida?', 'concluido'), item('Descrição preenchida?', 'nao_aplicavel', { justificativa: 'não se aplica' })];
    const confirma = aplicarVerificacao(itens, verif({ 'Solução preenchida?': OK, 'Descrição preenchida?': OK }));
    assert.deepStrictEqual(confirma.map((i) => [i.estado, i.bloqueado]), [['concluido', true], ['concluido', true]]);
    const falta = aplicarVerificacao(itens, verif({ 'Solução preenchida?': FALTA('x'), 'Descrição preenchida?': FALTA('y') }));
    assert.deepStrictEqual(falta.map((i) => [i.estado, i.bloqueado]), [['concluido', false], ['nao_aplicavel', false]], 'N/A continua valendo enquanto o Jira não tem o campo');
  });

  test('item sem regra no Jira, item avulso e item removido ficam como estão', () => {
    const itens = [
      item('Release Note em linguagem de usuário', 'concluido'),
      { ...item('Solução preenchida?', 'concluido'), padrao: false },
      { ...item('Descrição preenchida?', 'pendente'), removido: true }
    ];
    const r = aplicarVerificacao(itens, verif({ 'Solução preenchida?': OK, 'Descrição preenchida?': OK }));
    assert.deepStrictEqual(r, itens);
  });

  test('chave que o Jira não acha, expedição sem chave ou Jira fora do ar: tudo manual, nada travado', () => {
    const itens = [item('Solução preenchida?', 'concluido'), item('Descrição preenchida?', 'pendente')];
    assert.deepStrictEqual(aplicarVerificacao(itens, null), itens);
    assert.deepStrictEqual(aplicarVerificacao(itens, { status: 'nao-encontrada' }), itens);
    assert.deepStrictEqual(aplicarVerificacao(itens, { status: 'indisponivel' }), itens);
  });

  test('épico sem tasks: nada conferido, nada travado (itens livres, com o motivo)', () => {
    const r = aplicarVerificacao([item('Solução preenchida?', 'pendente')], { status: 'sem-filhos', tipo: 'epico' });
    assert.strictEqual(r[0].bloqueado, false);
    assert.strictEqual(r[0].estado, 'pendente');
    assert.match(r[0].jira.motivo, /não tem tasks/);
  });

  test('só leitura: apenas item com regra cujo campo JÁ está preenchido no Jira; os demais ficam livres', () => {
    const solucao = item('Solução preenchida?');
    const v = verif({ 'Solução preenchida?': OK, 'Descrição preenchida?': FALTA('x') });
    assert.strictEqual(somenteLeituraPeloJira(solucao, v), true);
    assert.strictEqual(somenteLeituraPeloJira(item('Descrição preenchida?'), v), false, 'falta no Jira: livre');
    assert.strictEqual(somenteLeituraPeloJira(item('Solução preenchida?', 'nao_aplicavel'), v), true, 'confirmado no Jira: nem N/A nem desmarcar');
    assert.strictEqual(somenteLeituraPeloJira(solucao, { status: 'indisponivel' }), false);
    assert.strictEqual(somenteLeituraPeloJira(solucao, { status: 'nao-encontrada' }), false);
    assert.strictEqual(somenteLeituraPeloJira(solucao, { status: 'sem-filhos' }), false);
    assert.strictEqual(somenteLeituraPeloJira(solucao, null), false);
    assert.strictEqual(somenteLeituraPeloJira(item('Release Note em linguagem de usuário'), v), false);
    assert.strictEqual(somenteLeituraPeloJira({ ...solucao, padrao: false }, v), false);
  });

  test('o progresso conta o que o Jira confirmou mais o que a pessoa marcou à mão', () => {
    const itens = ITENS_PADRAO.map((i, n) => deLinhaItem({ id: n + 1, bloco: i.bloco, texto: i.texto, padrao: true, estado: i.texto === 'Branch: VERSÃO FIX → master | VERSÃO RELEASE → Developer?' ? 'concluido' : 'pendente' }));
    const v = verif(Object.fromEntries(J.TEXTOS_JIRA.map((t, n) => [t, n < 5 ? OK : FALTA('falta')])));
    const e = decorar({ artefatoJira: 'A-1', dataExpedicao: null, itens }, null, '2026-10-13', v);
    assert.deepStrictEqual(e.progresso, { total: 17, concluidos: 6, naoAplicaveis: 0, pendentes: 11 }, '5 do Jira + 1 marcado à mão');
    assert.deepStrictEqual(e.jira, { status: 'ok', tipo: 'task', filhos: 0, lidoEm: '2026-10-13T12:00:00Z', desatualizado: false });
    const sem = decorar({ artefatoJira: '', dataExpedicao: null, itens }, null, '2026-10-13', null);
    assert.strictEqual(sem.jira.status, 'sem-chave');
    assert.strictEqual(sem.progresso.concluidos, 1);
  });
});
