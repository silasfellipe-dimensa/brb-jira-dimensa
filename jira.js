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

async function chamarJira(caminho) {
  const { email, token } = credenciais();
  const auth = Buffer.from(email + ':' + token).toString('base64');

  let resp;
  try {
    resp = await fetch(SITE + caminho, {
      headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' },
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
  const avulsos = [];

  function grupo(chave, titulo) {
    if (!grupos.has(chave)) {
      grupos.set(chave, { chave, titulo, tarefas: [] });
    }
    return grupos.get(chave);
  }

  for (const { issue, coluna } of visiveis) {
    const sub = ehSubtarefa(issue);
    let ep = epicoDe(issue);

    if (!ep && sub) {
      const pai = issue.fields.parent;
      if (pai && epicoPorChave[pai.key]) ep = epicoPorChave[pai.key];
    }

    const tarefa = {
      chave: issue.key || null,
      titulo: issue.fields.summary,
      coluna,
      subtarefa: sub,
      concluida: ehConcluida(coluna, ordemColunas),
      pessoa: idPessoa(issue.fields.assignee)
    };

    if (ep) {
      grupo(ep.key, ep.titulo).tarefas.push(tarefa);
    } else if (!sub) {
      // Task solta: vira card com o proprio nome.
      avulsos.push(tarefa);
    } else {
      // Subtarefa orfa (o pai dela nao esta visivel no board). Sem epico e
      // sem pai a que se juntar, ela viraria ruido - fica de fora.
      continue;
    }
  }

  const cards = [];

  for (const g of grupos.values()) {
    // Posicao pelas tasks de verdade; so cai nas subtarefas se nao houver
    // nenhuma task de nivel 0 visivel para aquele epico.
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

    cards.push({
      titulo: g.titulo,
      epico: g.chave,
      coluna: ordemColunas[indice],
      pessoa: principal ? principal.pessoa : null,
      tarefas: g.tarefas,
      total: g.tarefas.length,
      concluidas: g.tarefas.filter((t) => t.concluida).length
    });
  }

  for (const t of avulsos) {
    cards.push({
      titulo: t.titulo,
      epico: null,
      coluna: t.coluna,
      pessoa: t.pessoa,
      tarefas: [t],
      total: 1,
      concluidas: t.concluida ? 1 : 0
    });
  }

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
    vazao,
    previsao,
    carga
  };
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
      `?fields=summary,status,assignee,issuetype,parent,epic,created,` +
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

  return {
    metricas,
    vazio: false,
    sprint: sprint.name,
    atualizadoEm: new Date().toISOString(),
    mostrarResponsavel: MOSTRAR_RESPONSAVEL,
    pessoas,
    colunas
  };
}

module.exports = {
  buscarBoard, mapearColunas, montarColunas, montarMetricas, epicoDe, ehSubtarefa
};
