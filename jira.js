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

/** Distribui as issues nas colunas. Pura, pelo mesmo motivo acima. */
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

  const colunas = ordemColunas.map((nome) => {
    const cards = issues
      .filter((it) => statusParaColuna[String(it.fields.status.id)] === nome)
      .map((it) => ({ titulo: it.fields.summary, pessoa: idPessoa(it.fields.assignee) }));
    return { nome, cor: CORES[nome] || 'concluido', cards };
  });

  return { colunas, pessoas };
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
      `?fields=summary,status,assignee&maxResults=100&startAt=${inicio}`
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

  return {
    vazio: false,
    sprint: sprint.name,
    atualizadoEm: new Date().toISOString(),
    mostrarResponsavel: MOSTRAR_RESPONSAVEL,
    pessoas,
    colunas
  };
}

module.exports = { buscarBoard, mapearColunas, montarColunas };
