// Busca o board do Jira e monta o mesmo formato que o front-end espera.
// Portado do Codigo.gs (Apps Script) - mesma logica, agora em Node.

const SITE = 'https://mobile2you.atlassian.net';
const BOARD_ID = 2587;

const COLUNAS_OCULTAS = ['BACKLOG', 'PLANEJADO'];
const MOSTRAR_RESPONSAVEL = true;

const CORES = {
  'Em andamento': 'andamento',
  'DEV CONCLUÍDO': 'dev',
  'TESTE': 'teste',
  'AGUARDANDO TERCEIROS': 'terceiros',
  'Itens concluídos': 'concluido'
};

function credenciais() {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_TOKEN;
  if (!email || !token) {
    throw new Error('Faltam JIRA_EMAIL e/ou JIRA_TOKEN nas variáveis de ambiente.');
  }
  return { email, token };
}

// Sem timeout, uma lentidao do Jira vira indisponibilidade nossa: a funcao
// fica presa esperando ate o limite da plataforma.
const TIMEOUT_JIRA_MS = 10_000;

// Teto de paginas na busca de issues (100 issues por pagina).
const MAX_PAGINAS = 20;

async function chamarJira(caminho, opcoes = {}) {
  const { email, token } = credenciais();
  const auth = Buffer.from(email + ':' + token).toString('base64');
  const metodo = opcoes.metodo || 'GET';

  let resp;
  try {
    resp = await fetch(SITE + caminho, {
      method: metodo,
      headers: {
        Authorization: 'Basic ' + auth,
        Accept: 'application/json',
        ...(opcoes.corpo ? { 'Content-Type': 'application/json' } : {})
      },
      body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_JIRA_MS)
    });
  } catch (erro) {
    if (erro.name === 'TimeoutError' || erro.name === 'AbortError') {
      throw new Error(`Jira não respondeu em ${TIMEOUT_JIRA_MS}ms (${caminho})`);
    }
    throw erro;
  }

  if (!resp.ok) {
    let dica = '';
    if (resp.status === 401) dica = ' (token inválido ou expirado)';
    if (resp.status === 403) dica = ' (a conta não tem permissão)';
    if (resp.status === 404) dica = ' (board ou sprint não encontrado)';
    throw new Error('Jira respondeu ' + resp.status + dica + ' em ' + caminho);
  }

  return resp.json();
}


/** Le a configuracao de colunas do board e devolve a ordem visivel e o
 * mapa status -> coluna. Funcao pura: recebe a resposta do Jira, nao a
 * busca - e o que permite testar o agrupamento sem tocar na rede. */
function mapearColunas(cfg) {
  const statusParaColuna = {};
  const ordemColunas = [];
  const colunas = (cfg && cfg.columnConfig && cfg.columnConfig.columns) || [];

  for (const col of colunas) {
    if (COLUNAS_OCULTAS.includes(col.name)) continue;
    ordemColunas.push(col.name);
    for (const st of col.statuses || []) {
      statusParaColuna[String(st.id)] = col.name;
    }
  }
  return { statusParaColuna, ordemColunas };
}

/** Subtarefa e ruido operacional para quem le o board (Codificacao, Code
 * Review, Atualizacao de Ambiente...). Ela nunca vira card: entra so no
 * detalhe do epico e na contagem de progresso. */
function ehSubtarefa(issue) {
  const t = issue.fields.issuetype;
  return !!(t && t.subtask);
}

/** O epico chega em fields.epic (API Agile). NAO usar fields.parent: no
 * board 2587, 43 de 61 issues tem como pai uma task, nao um epico - quem
 * confia no parent acaba criando "epico" que e task. E NAO usar epic.name:
 * ele vem preenchido como "BRB" em varios epicos reais; o texto util e o
 * summary, que ja chega no formato "20260525007 - Nome da demanda". */
function epicoDe(issue) {
  const e = issue.fields.epic;
  if (!e || !e.key) return null;
  return { key: e.key, titulo: e.summary || e.name || e.key };
}

/** Concluida = chegou na ultima coluna do board ("Itens concluidos").
 *
 * De proposito NAO usamos a categoria "done" do Jira: no board 2587 o status
 * "Teste de Aceitacao Concluido" e categoria done mas vive na coluna
 * AGUARDANDO TERCEIROS. Pela categoria, um epico parado ali aparecia como
 * "6/6 concluidas" - numero que contradiz a coluna em que o card esta. Quem
 * le o board le a coluna, entao a coluna e quem manda. */
function ehConcluida(coluna, ordemColunas) {
  return coluna === ordemColunas[ordemColunas.length - 1];
}

/** Fechamento formal no Jira (resolutiondate) - diferente de "chegou na
 * coluna final". Uma task pode estar na ultima coluna do board (trabalho
 * pronto) sem que alguem tenha rodado a transicao que fecha a issue de fato.
 * E essa segunda coisa (fechamento) que libera producao, por isso os dois
 * sinais sao guardados separados: coluna manda pra progresso, fechamento
 * manda pra "entrega valida pra ir a producao". */
function statusFechamento(fields) {
  if (!fields) return { fechado: false, dataFechamento: null };
  const categoriaDone = !!(fields.status && fields.status.statusCategory &&
    fields.status.statusCategory.key === 'done');
  const dataFechamento = fields.resolutiondate ||
    (categoriaDone ? fields.statuscategorychangedate : null) || null;
  return { fechado: !!dataFechamento, dataFechamento };
}

function sprintsDaIssue(issue) {
  const campos = issue && issue.fields ? issue.fields : {};
  const candidatos = [];
  // customfield_10019 é o campo "Sprint" de verdade nesta instância do Jira
  // (customfield_10020 é o Rank, usado só pra ordenar o board - guardar
  // sprint ali era ler o campo errado, perdendo o historico de quase todo
  // item que ja saiu da sprint ativa). Vem primeiro porque e o unico que
  // traz o HISTORICO completo (todas as sprints por que a issue passou);
  // 'sprint'/'sprints' ficam so como fallback, pra instancia onde o campo
  // customizado tenha outro ID.
  for (const chave of ['customfield_10019', 'sprint', 'sprints']) {
    const valor = campos[chave];
    if (Array.isArray(valor)) candidatos.push(...valor);
    else if (valor) candidatos.push(valor);
  }
  return candidatos.map((s) => {
    if (typeof s === 'string') {
      const nome = s.match(/name=([^,\]]+)/);
      return { nome: nome ? nome[1] : s };
    }
    return {
      id: s.id || null,
      nome: s.name || s.nome || null,
      inicio: s.startDate || s.startDateIso || null,
      fim: s.endDate || s.endDateIso || null,
      estado: s.state || null
    };
  }).filter((s) => s.nome || s.id);
}

/** Agrupa issues por epico (ou por task avulsa, quando nao tem epico) - a
 * mesma unidade que o board usa pra formar um card. Pura e compartilhada:
 * `montarColunas` usa pra desenhar o board, `montarEntregas` usa pra decidir
 * o que conta como "entregue" no historico. Um numero so de agrupamento em
 * todo o app, pra board e dashboard nunca divergirem por causa disso. */
function agruparPorEpico(issues, statusParaColuna, ordemColunas, mostrarResponsavel) {
  const pessoas = {};

  function idPessoa(assignee) {
    if (!assignee || !mostrarResponsavel) return null;
    const id = assignee.accountId;
    if (!pessoas[id]) {
      pessoas[id] = {
        nome: assignee.displayName,
        avatar: (assignee.avatarUrls && assignee.avatarUrls['48x48']) || ''
      };
    }
    return id;
  }

  // So o que o board mostra: fora backlog, planejado e status sem coluna.
  const visiveis = [];
  for (const it of issues) {
    const coluna = statusParaColuna[String(it.fields.status.id)];
    if (!coluna || !ordemColunas.includes(coluna)) continue;
    visiveis.push({ issue: it, coluna });
  }

  // Subtarefa herda o epico da task pai (ela mesma nao carrega fields.epic).
  const epicoPorChave = {};
  for (const { issue } of visiveis) {
    const ep = epicoDe(issue);
    if (ep && issue.key) epicoPorChave[issue.key] = ep;
  }

  const grupos = new Map();
  // Task sem epico tambem vira "grupo", indexado pela propria chave - assim
  // uma subtarefa dela encontra onde se encaixar (ver 2a passada abaixo),
  // em vez de ficar orfa so por o pai nao ter epico.
  const gruposTarefa = new Map();

  function grupo(chave, titulo) {
    if (!grupos.has(chave)) {
      grupos.set(chave, { chave, titulo, tarefas: [] });
    }
    return grupos.get(chave);
  }

  // 1a passada: so tasks de nivel 0 (nao-subtarefa), que definem os grupos.
  let semChave = 0;
  for (const { issue, coluna } of visiveis) {
    if (ehSubtarefa(issue)) continue;
    const ep = epicoDe(issue);
    const fechamento = statusFechamento(issue.fields);

    const tarefa = {
      chave: issue.key || null,
      titulo: issue.fields.summary,
      coluna,
      subtarefa: false,
      concluida: ehConcluida(coluna, ordemColunas),
      pessoa: idPessoa(issue.fields.assignee),
      resolvidoEm: issue.fields.resolutiondate || issue.fields.statuscategorychangedate || null,
      fechado: fechamento.fechado,
      dataFechamento: fechamento.dataFechamento
    };

    if (ep) {
      grupo(ep.key, ep.titulo).tarefas.push(tarefa);
    } else {
      // Task solta: vira card com o proprio nome, mas continua sendo um
      // "grupo" para poder receber subtarefas na 2a passada. Sem chave (caso
      // raro), usa um identificador interno so para nao colidir no Map -
      // ela so nao recebe subtarefa depois, ja que a subtarefa aponta para
      // um parent.key que nao existiria de qualquer forma.
      const chaveGrupo = issue.key || `__sem-chave-${semChave++}`;
      gruposTarefa.set(chaveGrupo, { chave: chaveGrupo, titulo: tarefa.titulo, tarefas: [tarefa] });
    }
  }

  // 2a passada: subtarefas, que so existem dentro de uma task ou epico -
  // nunca sozinhas. Vao para o epico da task pai, ou para a propria task pai
  // se ela for avulsa. So fica de fora quem nao tem pai visivel no board.
  for (const { issue, coluna } of visiveis) {
    if (!ehSubtarefa(issue)) continue;
    const pai = issue.fields.parent;

    const tarefa = {
      chave: issue.key || null,
      titulo: issue.fields.summary,
      coluna,
      subtarefa: true,
      concluida: ehConcluida(coluna, ordemColunas),
      pessoa: idPessoa(issue.fields.assignee),
      resolvidoEm: issue.fields.resolutiondate || issue.fields.statuscategorychangedate || null
    };

    const epDoPai = pai && epicoPorChave[pai.key];
    if (epDoPai) {
      grupo(epDoPai.key, epDoPai.titulo).tarefas.push(tarefa);
    } else if (pai && gruposTarefa.has(pai.key)) {
      gruposTarefa.get(pai.key).tarefas.push(tarefa);
    }
    // Sem epico e sem task-pai visivel no board: subtarefa orfa, fica de
    // fora - sozinha ela nao tem contexto nenhum para quem le o board.
  }

  return { grupos, gruposTarefa, pessoas };
}

/** Entrega = unidade FECHADA por completo: epico com todas as tasks/
 * subtasks concluidas, ou task avulsa (com ou sem subtasks) toda concluida.
 * Mesma unidade e mesma regra de "tudo concluido" que decide se o card
 * aparece na coluna final do board - e o que garante board e historico
 * batendo no mesmo numero.
 *
 * Data/sprint da entrega: se a unidade ja foi FECHADA de verdade no Jira
 * (resolutiondate), usa essa data. Sem fechamento formal ainda, cai para a
 * data da ultima tarefa concluida.
 *
 * O alerta `pendenteFechamento` so faz sentido pra TASK AVULSA: fechar a
 * task manualmente e passo obrigatorio antes de ir a producao, entao sem
 * isso falta algo. EPICO e diferente - na pratica o time so fecha as tasks/
 * subtasks, o epico raramente ou nunca e movido pra um status fechado (o
 * board tambem nunca olha o status do epico em si, so dos filhos) - por
 * isso o epico nunca liga esse alerta, mesmo sem estar formalmente fechado.
 *
 * `statusEpicosPorChave` vem de fora (fetch a parte no Jira, so pros epicos
 * envolvidos) porque o epico normalmente nao aparece na lista de issues do
 * sprint - so os filhos dele aparecem. */
function montarEntregas(ordemColunas, statusParaColuna, issues, sprint, mostrarResponsavel, statusEpicosPorChave) {
  const statusEpicos = statusEpicosPorChave || {};
  const { grupos, gruposTarefa } = agruparPorEpico(issues, statusParaColuna, ordemColunas, mostrarResponsavel);
  const issuesPorChave = new Map(issues.filter((i) => i.key).map((i) => [i.key, i]));

  const entregas = [];
  for (const g of grupos.values()) {
    const d = descreverGrupo(g, g.chave, { issuesPorChave, statusEpicos, sprint });
    if (d.entregue) entregas.push(d);
  }
  for (const g of gruposTarefa.values()) {
    const d = descreverGrupo(g, null, { issuesPorChave, statusEpicos, sprint });
    if (d.entregue) entregas.push(d);
  }
  return entregas;
}

/** Descreve um grupo (epico ou task avulsa) por completo - entregue ou nao.
 * Extraido de `montarEntregas` para tambem servir o planejamento (que
 * precisa ver o grupo mesmo quando NAO esta entregue, coisa que
 * `montarEntregas` descarta de proposito). As sao/mesmas regras de data,
 * sprint e alerta de fechamento em ambos os usos - garante que "planejado"
 * e "entregue" nunca contem historias diferentes sobre o mesmo grupo. */
function descreverGrupo(g, epico, ctx) {
  const { issuesPorChave, statusEpicos, sprint } = ctx;
  const total = g.tarefas.length;
  const concluidas = g.tarefas.filter((t) => t.concluida).length;
  const entregue = total > 0 && concluidas === total;

  const statusFecho = epico ? (statusEpicos[epico] || { fechado: false, dataFechamento: null })
    : (g.tarefas.find((t) => !t.subtarefa) || { fechado: false, dataFechamento: null });

  const datasConclusaoFilhos = g.tarefas.map((t) => t.resolvidoEm).filter(Boolean);
  const dataMaisRecente = datasConclusaoFilhos.length
    ? datasConclusaoFilhos.reduce((a, b) => (new Date(a) > new Date(b) ? a : b))
    : null;

  // So task avulsa liga o alerta: fechar a task e passo obrigatorio antes
  // de producao. Fechar o epico em si nao e - o time so fecha as tasks/
  // subtasks, entao a falta de fechamento do epico e esperada, nao um erro.
  const pendenteFechamento = entregue && !epico && !statusFecho.fechado;
  const resolvidoEm = entregue ? (statusFecho.fechado ? statusFecho.dataFechamento : dataMaisRecente) : null;

  // Sprint de origem/conclusao: olha os sprints de TODAS as issues do
  // grupo (o epico em si nao carrega sprint), pega a mais antiga como
  // origem e a que cobre a data de conclusao como conclusao. A origem
  // independe de estar entregue - um grupo ainda aberto tambem "nasceu"
  // numa sprint, e e disso que o planejamento precisa.
  let todosSprints = [];
  for (const t of g.tarefas) {
    const issueOriginal = t.chave && issuesPorChave.get(t.chave);
    if (issueOriginal) todosSprints.push(...sprintsDaIssue(issueOriginal));
  }
  // A mais antiga de fato, nao so a primeira da lista: com varias tarefas no
  // grupo, cada uma contribui seu proprio historico de sprints, entao a
  // ordem de concatenacao nao segue a ordem cronologica sozinha.
  const origem = todosSprints.slice()
    .sort((a, b) => new Date(a.inicio || 8640000000000000) - new Date(b.inicio || 8640000000000000))[0] || null;
  const dataConclusao = resolvidoEm ? new Date(resolvidoEm) : null;
  const sprintComConclusao = dataConclusao && todosSprints
    .filter((s) => s.inicio && s.fim &&
      dataConclusao >= new Date(s.inicio) && dataConclusao <= new Date(s.fim))
    .sort((a, b) => new Date(b.inicio) - new Date(a.inicio))[0];
  const sprintFinal = entregue ? (sprintComConclusao || sprint) : null;

  // Responsavel do registro: o de uma task nao-subtarefa que tenha
  // assignee (a subtarefa e detalhe, nao quem "dono" da entrega).
  const principalTarefa = g.tarefas.find((t) => !t.subtarefa && t.pessoa) ||
    g.tarefas.find((t) => t.pessoa) || null;
  const issuePrincipal = principalTarefa && principalTarefa.chave && issuesPorChave.get(principalTarefa.chave);
  const assigneePrincipal = issuePrincipal && issuePrincipal.fields.assignee;

  return {
    chave: g.chave,
    titulo: g.titulo,
    tipo: epico ? 'epico' : 'tarefa avulsa',
    entregue,
    resolvidoEm,
    pendenteFechamento,
    sprintConclusao: sprintFinal ? (sprintFinal.name || sprintFinal.nome || null) : null,
    sprintConclusaoId: sprintFinal ? sprintFinal.id : null,
    sprintOrigem: origem ? origem.nome : null,
    sprintOrigemId: origem ? origem.id : null,
    total,
    concluidas,
    pessoa: assigneePrincipal ? assigneePrincipal.displayName : null,
    avatarUrl: assigneePrincipal
      ? (assigneePrincipal.avatarUrls && assigneePrincipal.avatarUrls['48x48']) || '' : '',
    tarefas: g.tarefas.map((t) => ({ chave: t.chave, titulo: t.titulo, subtarefa: t.subtarefa, concluida: t.concluida }))
  };
}

/** Planejamento = todo grupo (epico/task avulsa) que "nasceu" numa sprint
 * (sprintOrigem), entregue ou nao - o contraponto necessario para responder
 * "o que era pra sair dessa sprint, saiu?". Diferente de `montarEntregas`,
 * aqui nada e descartado por nao estar concluido.
 *
 * Recebe as issues de TODAS as sprints ja combinadas (nao uma por vez):
 * um grupo cujos filhos foram divididos entre duas sprints so tem o total
 * certo se olharmos todo mundo junto - contar so o pedaco de uma sprint
 * faria um epico ainda aberto parecer "100% concluido" por acidente. */
function montarPlanejamento(ordemColunas, statusParaColuna, todasIssues, mostrarResponsavel, statusEpicosPorChave) {
  const statusEpicos = statusEpicosPorChave || {};
  const { grupos, gruposTarefa } = agruparPorEpico(todasIssues, statusParaColuna, ordemColunas, mostrarResponsavel);
  const issuesPorChave = new Map(todasIssues.filter((i) => i.key).map((i) => [i.key, i]));

  const planejamento = [];
  for (const g of grupos.values()) {
    planejamento.push(descreverGrupo(g, g.chave, { issuesPorChave, statusEpicos, sprint: null }));
  }
  for (const g of gruposTarefa.values()) {
    planejamento.push(descreverGrupo(g, null, { issuesPorChave, statusEpicos, sprint: null }));
  }
  // So faz sentido planejamento de quem tem sprint de origem conhecida.
  return planejamento.filter((p) => p.sprintOrigemId != null);
}


/** Distribui as issues nas colunas, agrupando por epico. Pura, de proposito.
 *
 * Regras, todas conferidas contra o board real:
 * - um card por EPICO, nao por task;
 * - o epico fica na coluna MENOS avancada entre as tasks dele, entao ele nao
 *   anda enquanto sobrar trabalho atras e so chega em "Itens concluidos"
 *   quando tudo terminou;
 * - task sem epico continua aparecendo com o proprio nome, para nao sumir
 *   trabalho real do board;
 * - subtarefa nao vira card, mas entra no detalhe e no progresso. */
function montarColunas(ordemColunas, statusParaColuna, issues, mostrarResponsavel) {
  const { grupos, gruposTarefa, pessoas } = agruparPorEpico(issues, statusParaColuna, ordemColunas, mostrarResponsavel);

  const cards = [];

  function montarCardDeGrupo(g, epico) {
    // Posicao pelas tasks de verdade; so cai nas subtarefas se nao houver
    // nenhuma task de nivel 0 visivel para aquele epico/task.
    const base = g.tarefas.filter((t) => !t.subtarefa);
    const referencia = base.length ? base : g.tarefas;

    let indice = ordemColunas.length - 1;
    for (const t of referencia) {
      const i = ordemColunas.indexOf(t.coluna);
      if (i !== -1 && i < indice) indice = i;
    }

    // Responsavel do card: o de uma task nao concluida, que e onde esta o
    // trabalho agora. Sem nenhuma, usa a primeira que tiver responsavel.
    const ativas = referencia.filter((t) => !t.concluida && t.pessoa);
    const principal = ativas[0] || referencia.find((t) => t.pessoa) || null;

    return {
      titulo: g.titulo,
      epico,
      coluna: ordemColunas[indice],
      pessoa: principal ? principal.pessoa : null,
      tarefas: g.tarefas,
      total: g.tarefas.length,
      concluidas: g.tarefas.filter((t) => t.concluida).length
    };
  }

  for (const g of grupos.values()) cards.push(montarCardDeGrupo(g, g.chave));
  for (const g of gruposTarefa.values()) cards.push(montarCardDeGrupo(g, null));

  const colunas = ordemColunas.map((nome) => ({
    nome,
    cor: CORES[nome] || 'concluido',
    cards: cards.filter((c) => c.coluna === nome)
  }));

  return { colunas, pessoas };
}

/** Tamanho do sprint dia a dia, do início até hoje.
 *
 * O ponto de partida é quanto o sprint já tinha ao começar; cada item criado
 * depois empurra a linha para cima no dia em que nasceu. É uma aproximação
 * consciente: item que existia antes e foi PUXADO para o sprint no meio do
 * caminho entra na base, porque a data de entrada no sprint só existe no
 * changelog, que custaria uma chamada por issue. A curva erra para baixo,
 * nunca para cima - o crescimento real é igual ou maior que o desenhado. */
function serieEscopo(issues, novos, inicio, agora) {
  if (!inicio) return [];
  const DIA = 86400000;
  const base = issues.length - novos.length;

  const porDia = {};
  for (const i of novos) {
    const dia = new Date(i.fields.created).toISOString().slice(0, 10);
    porDia[dia] = (porDia[dia] || 0) + 1;
  }

  // Compara por data (string), nao por milissegundo: somar 24h a partir da
  // meia-noite do inicio ultrapassa "hoje" quando agora e de manha, e a serie
  // ganhava um dia no futuro.
  const serie = [];
  const hoje = agora.toISOString().slice(0, 10);
  let total = base;
  for (let t = inicio.getTime(); serie.length < 120; t += DIA) {
    const dia = new Date(t).toISOString().slice(0, 10);
    if (dia > hoje) break;
    total += (porDia[dia] || 0);
    serie.push({ dia, total, entraram: porDia[dia] || 0 });
  }
  return serie;
}

/** Métricas do sprint. Pura: recebe as issues e o sprint, não busca nada.
 *
 * Só usa campo que o board 2587 preenche de verdade. Ficaram de fora, por
 * verificação e não por esquecimento: story points (0% preenchido), due date
 * (0%), estimativa (0%) e priority (100% preenchido, mas 100% "Medium" - não
 * discrimina nada).
 *
 * E NÃO usa `updated` para medir parada: nesse board ele é mexido por robô de
 * apontamento de horas e por operação de sprint. O JDCBBRB-137 marcava
 * "atualizado há 10 dias" com a última mudança real em 21/06. Para idade vale
 * `created`; para tempo na fase atual, `statuscategorychangedate`. */
function montarMetricas(ordemColunas, statusParaColuna, issues, sprint, agora, mostrarResponsavel) {
  const DIA = 86400000;
  const dias = (de, ate) => Math.floor((ate - new Date(de)) / DIA);
  const colunaFinal = ordemColunas[ordemColunas.length - 1];

  const visiveis = [];
  for (const it of issues) {
    const coluna = statusParaColuna[String(it.fields.status.id)];
    if (!coluna || !ordemColunas.includes(coluna)) continue;
    visiveis.push({ issue: it, coluna });
  }

  const abertos = visiveis.filter((v) => v.coluna !== colunaFinal);
  const prontos = visiveis.filter((v) => v.coluna === colunaFinal);

  // ---- relogio do sprint ----
  const inicio = sprint && sprint.startDate ? new Date(sprint.startDate) : null;
  const fim = sprint && sprint.endDate ? new Date(sprint.endDate) : null;
  const relogio = inicio && fim ? {
    inicio: sprint.startDate,
    fim: sprint.endDate,
    totalDias: dias(inicio, fim),
    corridos: Math.max(0, dias(inicio, agora)),
    restantes: Math.max(0, dias(agora, fim))
  } : null;

  // ---- escopo que entrou com o sprint em andamento ----
  const novos = inicio ? issues.filter((i) => new Date(i.fields.created) > inicio) : [];

  // ---- fila por coluna ----
  const wip = ordemColunas.map((nome) => ({
    coluna: nome,
    qtd: visiveis.filter((v) => v.coluna === nome).length
  }));

  // ---- envelhecimento dos itens em aberto ----
  const aging = abertos.map(({ issue, coluna }) => ({
    chave: issue.key,
    titulo: issue.fields.summary,
    coluna,
    subtarefa: !!(issue.fields.issuetype && issue.fields.issuetype.subtask),
    epico: issue.fields.epic ? issue.fields.epic.summary : null,
    diasAberto: dias(issue.fields.created, agora),
    diasNaFase: issue.fields.statuscategorychangedate
      ? dias(issue.fields.statuscategorychangedate, agora) : null,
    pessoa: mostrarResponsavel && issue.fields.assignee
      ? issue.fields.assignee.displayName : null
  }))
    // Ordena pelo tempo NA FASE, não pela idade: um item criado há 3 meses que
    // entrou em progresso ontem não é urgente; um criado semana passada e
    // travado há 10 dias é.
    .sort((a, b) => {
      const ta = a.diasNaFase === null ? a.diasAberto : a.diasNaFase;
      const tb = b.diasNaFase === null ? b.diasAberto : b.diasNaFase;
      return tb - ta;
    });

  // ---- vazao por semana (segunda a domingo) ----
  const porSemana = {};
  for (const i of issues) {
    if (!i.fields.resolutiondate) continue;
    const d = new Date(i.fields.resolutiondate);
    const seg = new Date(d);
    seg.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const chave = seg.toISOString().slice(0, 10);
    porSemana[chave] = (porSemana[chave] || 0) + 1;
  }
  const vazao = Object.keys(porSemana).sort().map((semana) => ({ semana, qtd: porSemana[semana] }));

  // ---- previsao por vazao, unico caminho possivel sem story points ----
  // Descarta a semana corrente: ela esta incompleta e puxaria a media para baixo.
  const fechadas = vazao.slice(0, -1);
  const base = fechadas.length ? fechadas : vazao;
  const media = base.length ? base.reduce((s, x) => s + x.qtd, 0) / base.length : 0;
  const semanas = relogio ? relogio.restantes / 7 : 0;
  const devemFechar = Math.min(abertos.length, Math.round(media * semanas));
  const previsao = {
    vazaoMedia: Number(media.toFixed(1)),
    semanasRestantes: Number(semanas.toFixed(1)),
    devemFechar,
    escorregam: Math.max(0, abertos.length - devemFechar)
  };

  // ---- entregas: contraponto ao aging/terceiros, que so mostram problema ----
  // So demanda (nao subtarefa): a subtarefa "Code Review" concluida nao e uma
  // entrega para quem olha de fora, e inflaria a lista com ruido interno -
  // mesmo raciocinio que separou demanda de desdobramento no escopo novo.
  const entregues = prontos
    .filter(({ issue }) => !ehSubtarefa(issue))
    .map(({ issue }) => ({
      chave: issue.key,
      titulo: issue.fields.summary,
      epico: issue.fields.epic ? issue.fields.epic.summary : null,
      resolvidoEm: issue.fields.resolutiondate || issue.fields.statuscategorychangedate || null,
      pessoa: mostrarResponsavel && issue.fields.assignee ? issue.fields.assignee.displayName : null
    }))
    .sort((a, b) => {
      // Sem data vai para o fim, nunca para o topo: nao ha como afirmar que
      // um item sem data e o mais recente.
      if (!a.resolvidoEm && !b.resolvidoEm) return 0;
      if (!a.resolvidoEm) return 1;
      if (!b.resolvidoEm) return -1;
      return new Date(b.resolvidoEm) - new Date(a.resolvidoEm);
    });

  // ---- carga por pessoa: so interna, nunca na tela do cliente ----
  const porPessoa = {};
  if (mostrarResponsavel) {
    for (const { issue } of abertos) {
      const nome = issue.fields.assignee ? issue.fields.assignee.displayName : '(sem responsável)';
      porPessoa[nome] = (porPessoa[nome] || 0) + 1;
    }
  }
  const carga = Object.keys(porPessoa)
    .map((nome) => ({ pessoa: nome, qtd: porPessoa[nome] }))
    .sort((a, b) => b.qtd - a.qtd);

  return {
    relogio,
    itens: { total: visiveis.length, concluidos: prontos.length, abertos: abertos.length },
    escopoNovo: (() => {
      // Separar e essencial para o numero nao mentir. No sprint Setembro, 22
      // itens nasceram depois do inicio - mas 16 sao Codificacao, Code Review,
      // Documento Tecnico e afins, criados ao DETALHAR uma demanda que ja
      // estava no sprint. Chamar os 22 de "escopo novo" transforma 6 demandas
      // negociadas em um alarme de 25%.
      const demandas = novos.filter((i) => !ehSubtarefa(i));
      const desdobramentos = novos.length - demandas.length;
      const baseDemandas = issues.filter((i) => !ehSubtarefa(i)).length - demandas.length;
      return {
        qtd: novos.length,
        pct: issues.length ? Math.round((novos.length / issues.length) * 100) : 0,
        base: issues.length - novos.length,
        demandas: demandas.length,
        desdobramentos,
        // Percentual sobre demandas, nao sobre tudo: e o numero que responde
        // "quanto de trabalho novo foi pactuado depois de comecar".
        pctDemandas: (baseDemandas + demandas.length)
          ? Math.round((demandas.length / (baseDemandas + demandas.length)) * 100) : 0,
        serie: serieEscopo(issues, novos, inicio, agora),
        itens: novos
          .slice()
          .sort((a, b) => new Date(b.fields.created) - new Date(a.fields.created))
          .map((i) => ({
            chave: i.key,
            titulo: i.fields.summary,
            criadoEm: i.fields.created,
            subtarefa: ehSubtarefa(i),
            tipo: i.fields.issuetype ? i.fields.issuetype.name : null
          }))
      };
    })(),
    wip,
    aging,
    entregues,
    vazao,
    previsao,
    carga
  };
}

/** Status de fechamento dos epicos, buscado a parte: o epico normalmente
 * nao aparece entre as issues do sprint (so os filhos aparecem), entao sem
 * isto nunca saberiamos se ele foi formalmente fechado no Jira. */
async function buscarStatusEpicos(chaves) {
  const unicas = Array.from(new Set(chaves.filter(Boolean)));
  if (!unicas.length) return {};
  const resultado = {};
  const LOTE = 100; // limite pratico de tamanho de JQL numa chamada
  for (let i = 0; i < unicas.length; i += LOTE) {
    const lote = unicas.slice(i, i + LOTE);
    const jql = `key in (${lote.join(',')})`;
    // GET /rest/api/2/search e /3/search foram desativados pelo Jira Cloud
    // (410 Gone) - a busca por JQL agora e so via POST em /search/jql.
    const resposta = await chamarJira('/rest/api/3/search/jql', {
      metodo: 'POST',
      corpo: { jql, fields: ['status', 'resolutiondate', 'statuscategorychangedate'], maxResults: LOTE }
    });
    for (const issue of resposta.issues || []) {
      resultado[issue.key] = statusFechamento(issue.fields);
    }
  }
  return resultado;
}

async function buscarBoard() {
  const cfg = await chamarJira(`/rest/agile/1.0/board/${BOARD_ID}/configuration`);
  const { statusParaColuna, ordemColunas } = mapearColunas(cfg);

  const sprints = await chamarJira(`/rest/agile/1.0/board/${BOARD_ID}/sprint?state=active`);
  if (!sprints.values || !sprints.values.length) {
    throw new Error(`Nenhum sprint ativo no board ${BOARD_ID}.`);
  }
  const sprint = sprints.values[0];

  // O laco e dirigido pelo "total" que vem da resposta do Jira. Sem teto,
  // uma resposta anomala (total gigante, maxResults zerado) vira laco
  // infinito. O teto e generoso para o tamanho real do board (~300 issues)
  // e ainda assim finito.
  let issues = [];
  let inicio = 0;
  let total = 1;
  let paginas = 0;
  while (inicio < total && paginas < MAX_PAGINAS) {
    paginas++;
    const pagina = await chamarJira(
      `/rest/agile/1.0/board/${BOARD_ID}/sprint/${sprint.id}/issue` +
      `?fields=summary,status,assignee,issuetype,parent,epic,created,sprint,customfield_10019,` +
      `resolutiondate,statuscategorychangedate&maxResults=100&startAt=${inicio}`
    );
    if (!Array.isArray(pagina.issues) || pagina.issues.length === 0) break;
    issues = issues.concat(pagina.issues);
    total = Number(pagina.total) || issues.length;
    // Avanca pelo que realmente veio: se o Jira devolvesse maxResults=0,
    // o cursor nunca andaria e o laco so pararia no teto de paginas.
    inicio += pagina.issues.length;
  }

  const { colunas, pessoas } = montarColunas(
    ordemColunas, statusParaColuna, issues, MOSTRAR_RESPONSAVEL
  );

  const metricas = montarMetricas(
    ordemColunas, statusParaColuna, issues, sprint, new Date(), MOSTRAR_RESPONSAVEL
  );

  const chavesEpicos = new Set();
  for (const issue of issues) {
    const ep = epicoDe(issue);
    if (ep) chavesEpicos.add(ep.key);
  }
  const statusEpicos = await buscarStatusEpicos(Array.from(chavesEpicos));

  const entregas = montarEntregas(
    ordemColunas, statusParaColuna, issues, sprint, MOSTRAR_RESPONSAVEL, statusEpicos
  );

  return {
    metricas,
    vazio: false,
    sprint: sprint.name,
    sprintId: sprint.id,
    atualizadoEm: new Date().toISOString(),
    mostrarResponsavel: MOSTRAR_RESPONSAVEL,
    pessoas,
    colunas,
    entregas
  };
}

/** Busca entregas E planejamento de todas as sprints (ativa + fechadas).
 * Devolve os dois juntos porque compartilham a mesma busca de issues e de
 * status de epicos - fazer separado dobraria as chamadas ao Jira. */
async function buscarEntregasHistoricas() {
  const cfg = await chamarJira(`/rest/agile/1.0/board/${BOARD_ID}/configuration`);
  const { statusParaColuna, ordemColunas } = mapearColunas(cfg);
  const sprints = [];
  for (const estado of ['active', 'closed']) {
    const resposta = await chamarJira(
      `/rest/agile/1.0/board/${BOARD_ID}/sprint?state=${estado}&maxResults=100`
    );
    sprints.push(...(resposta.values || []));
  }
  const unicas = new Map();
  for (const sprint of sprints) unicas.set(String(sprint.id), sprint);

  // Junta as issues de todas as sprints antes de montar entregas: assim a
  // busca de status dos epicos e feita uma vez so (nao um round-trip por
  // sprint), mesmo epico repetindo entre sprints diferentes.
  const issuesPorSprint = new Map();
  for (const sprint of unicas.values()) {
    // Acumula TODAS as paginas antes de montar as entregas: subtarefa e
    // task-pai podem cair em paginas diferentes, e contar subtarefas por
    // pagina isolada sub-contaria o "X/Y" de quem tem varias.
    let issuesDoSprint = [];
    let inicio = 0;
    let total = 1;
    let paginas = 0;
    while (inicio < total && paginas < MAX_PAGINAS) {
      paginas++;
      const pagina = await chamarJira(
        `/rest/agile/1.0/board/${BOARD_ID}/sprint/${sprint.id}/issue` +
        `?fields=summary,status,assignee,issuetype,parent,epic,created,sprint,customfield_10019,` +
        `resolutiondate,statuscategorychangedate&maxResults=100&startAt=${inicio}`
      );
      if (!Array.isArray(pagina.issues) || !pagina.issues.length) break;
      issuesDoSprint = issuesDoSprint.concat(pagina.issues);
      total = Number(pagina.total) || inicio + pagina.issues.length;
      inicio += pagina.issues.length;
    }
    issuesPorSprint.set(sprint.id, issuesDoSprint);
  }

  const chavesEpicos = new Set();
  for (const issuesDoSprint of issuesPorSprint.values()) {
    for (const issue of issuesDoSprint) {
      const ep = epicoDe(issue);
      if (ep) chavesEpicos.add(ep.key);
    }
  }
  const statusEpicos = await buscarStatusEpicos(Array.from(chavesEpicos));

  // Planejamento precisa ver TODOS os filhos de um grupo juntos, mesmo que
  // tenham passado por sprints diferentes - por isso combina (com dedup por
  // chave, ja que a mesma issue pode aparecer em mais de uma sprint) em vez
  // de processar sprint por sprint.
  const issuesUnicas = new Map();
  for (const issuesDoSprint of issuesPorSprint.values()) {
    for (const issue of issuesDoSprint) {
      if (issue.key) issuesUnicas.set(issue.key, issue);
    }
  }
  const planejamento = montarPlanejamento(
    ordemColunas, statusParaColuna, Array.from(issuesUnicas.values()), MOSTRAR_RESPONSAVEL, statusEpicos
  );

  // Entregas = subconjunto do planejamento, nao um calculo a parte. Antes
  // rodava montarEntregas() sprint por sprint, cada chamada so enxergando as
  // issues DAQUELA sprint - um epico com uma tarefa na sprint ativa e outra
  // numa sprint anterior aparecia "100% concluido" contando so a metade que
  // aquela chamada via. planejamento ja resolve isso (ve o grupo inteiro,
  // combinado); usar o mesmo resultado aqui garante que as duas telas nunca
  // mais divirjam sobre o que foi ou nao entregue (bug real, sessao
  // 2026-09-21: JDCBBRB-298 aparecia entregue com uma tarefa-irma ainda
  // aberta em outra sprint).
  const entregas = planejamento.filter((p) => p.entregue);

  return { entregas, planejamento };
}

module.exports = {
  buscarBoard, mapearColunas, montarColunas, montarMetricas, epicoDe, ehSubtarefa,
  sprintsDaIssue, montarEntregas, montarPlanejamento, buscarEntregasHistoricas, agruparPorEpico, statusFechamento
};
