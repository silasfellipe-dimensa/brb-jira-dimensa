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

async function chamarJira(caminho) {
  const { email, token } = credenciais();
  const auth = Buffer.from(email + ':' + token).toString('base64');

  const resp = await fetch(SITE + caminho, {
    headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' }
  });

  if (!resp.ok) {
    let dica = '';
    if (resp.status === 401) dica = ' (token inválido ou expirado)';
    if (resp.status === 403) dica = ' (a conta não tem permissão)';
    if (resp.status === 404) dica = ' (board ou sprint não encontrado)';
    throw new Error('Jira respondeu ' + resp.status + dica + ' em ' + caminho);
  }

  return resp.json();
}

async function buscarBoard() {
  const cfg = await chamarJira(`/rest/agile/1.0/board/${BOARD_ID}/configuration`);

  const statusParaColuna = {};
  const ordemColunas = [];
  for (const col of cfg.columnConfig.columns) {
    if (COLUNAS_OCULTAS.includes(col.name)) continue;
    ordemColunas.push(col.name);
    for (const st of col.statuses || []) {
      statusParaColuna[String(st.id)] = col.name;
    }
  }

  const sprints = await chamarJira(`/rest/agile/1.0/board/${BOARD_ID}/sprint?state=active`);
  if (!sprints.values || !sprints.values.length) {
    throw new Error(`Nenhum sprint ativo no board ${BOARD_ID}.`);
  }
  const sprint = sprints.values[0];

  let issues = [];
  let inicio = 0;
  let total = 1;
  while (inicio < total) {
    const pagina = await chamarJira(
      `/rest/agile/1.0/board/${BOARD_ID}/sprint/${sprint.id}/issue` +
      `?fields=summary,status,assignee&maxResults=100&startAt=${inicio}`
    );
    issues = issues.concat(pagina.issues);
    total = pagina.total;
    inicio += pagina.maxResults;
  }

  const pessoas = {};
  function idPessoa(assignee) {
    if (!assignee || !MOSTRAR_RESPONSAVEL) return null;
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
      .map((it) => ({
        titulo: it.fields.summary,
        pessoa: idPessoa(it.fields.assignee)
      }));
    return { nome, cor: CORES[nome] || 'concluido', cards };
  });

  return {
    vazio: false,
    sprint: sprint.name,
    atualizadoEm: new Date().toISOString(),
    mostrarResponsavel: MOSTRAR_RESPONSAVEL,
    pessoas,
    colunas
  };
}

module.exports = { buscarBoard };
