require('dotenv').config({ path: '.env.local' });

const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const { buscarBoard, buscarEntregasHistoricas } = require('./jira');
const {
  cadastrar, entrar, lerSnapshot, gravarSnapshot, gravarHistorico, lerHistorico,
  gravarEntregas, lerEntregas, listarSprintsEntregas, listarMesesEntregas, gravarPlanejamento,
  lerPlanejamentoSprint, lerCarryOverEntregue, listarPlanejamentoPorSprint, listarItensPlanejamento,
  listarItensCarryOver, registrarAcesso, listarAcessos, listarUsuarios, confirmarUsuarioManualmente,
  listarDemandas, criarDemanda, atualizarDemanda, removerDemanda
} = require('./supabase');
const {
  normalizarCampos, idDemanda, interpretarMes, interpretarListaMeses, mesesDisponiveis,
  filtrarPorMeses, resumirMeses
} = require('./demandas');
const {
  COOKIE_NAME,
  SESSAO_DIAS,
  emailPermitido,
  segredoConfere,
  criarSessao,
  exigirSessaoPagina,
  exigirSessaoApi,
  exigirAdminPagina,
  exigirAdminApi,
  exigirEditorApi,
  exigirEditorPagina,
  souAdmin,
  souEditor,
  limitarTentativas
} = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'paginas');
const SENHA_MINIMA = 8;

// Corpo pequeno de proposito: as rotas so recebem e-mail e senha, entao
// nao ha motivo para aceitar payload grande (evita abuso de memoria).
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  // 'unsafe-inline' e necessario porque o CSS e o JS das paginas sao
  // inline. connect-src 'self' impede que a pagina mande dados para
  // qualquer outro servidor caso algum script seja injetado.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "img-src 'self' data: https:; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "script-src 'self' 'unsafe-inline'; " +
    "connect-src 'self'; " +
    "frame-ancestors 'none'; " +
    "base-uri 'none'; " +
    "form-action 'self'"
  );
  // Sem dados do board em cache de proxy/navegador compartilhado.
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');

  // As páginas são HTML com o CSS e o JS embutidos: quando o app é atualizado,
  // o arquivo muda por inteiro e não há hash no nome para o navegador perceber.
  // Sem isto ele reaproveita a versão antiga e o deploy "não aparece" - o que
  // já custou vários hard refresh. no-cache não proíbe guardar, obriga a
  // revalidar: com o ETag do Express, resposta igual continua saindo 304.
  if (req.path === '/' || req.path.endsWith('.html') || ['/dashboard', '/admin', '/demandas', '/demandas/editar'].includes(req.path)) {
    res.setHeader('Cache-Control', 'no-cache');
  }

  next();
});

async function executarAtualizacao(usuario) {
  const dados = await buscarBoard();

  // dados.entregas (de buscarBoard) só enxerga a sprint ativa - um épico com
  // uma tarefa na sprint ativa e outra numa sprint anterior aparecia "100%
  // concluído" contando só a metade visível ali (bug real, sessão
  // 2026-09-21: JDCBBRB-298 marcado entregue com uma tarefa-irmã ainda
  // aberta em outra sprint). buscarEntregasHistoricas vê sprint ativa +
  // fechadas juntas e por isso é a fonte certa tanto pra entregas quanto
  // pro planejamento (Planejado x Entregue) - sobrescreve dados.entregas
  // ANTES de gravar o snapshot, porque é dali que a aba Entrega lê os
  // cards "Entregas por semana" e "Entregue recentemente".
  // Best-effort: se o Jira falhar aqui, o board segue com o que buscarBoard
  // já tinha, só sem a correção desta rodada.
  try {
    const { entregas, planejamento } = await buscarEntregasHistoricas();
    dados.entregas = entregas;
    await gravarPlanejamento(planejamento);
  } catch (erro) {
    console.error('[entregas/planejamento] falha ao atualizar (board segue normal):', erro.message);
  }

  await gravarSnapshot(dados);
  await gravarEntregas(dados.entregas);

  // Foto do dia para o histórico. Só o resumo - contagem por coluna é o que os
  // gráficos de fluxo precisam, e mantém a tabela pequena. Se falhar, o board
  // segue: gravarHistorico registra o erro e devolve false, sem lançar.
  const m = dados.metricas;
  if (m) {
    const colunas = {};
    m.wip.forEach((w) => { colunas[w.coluna] = w.qtd; });
    await gravarHistorico({
      sprint: dados.sprint,
      colunas,
      total: m.itens.total,
      concluidos: m.itens.concluidos,
      abertos: m.itens.abertos
    });
  }

  console.log(`[${new Date().toLocaleTimeString('pt-BR')}] Board atualizado por ${usuario}. Sprint: ${dados.sprint}`);
  return dados;
}

/** Responde erro sem vazar detalhe interno.
 *
 * O motivo real (status do Jira, caminho da API, mensagem do Postgres) vai
 * so para o log do servidor, correlacionado por requestId. O cliente recebe
 * mensagem generica + o mesmo requestId, para conseguir reportar o problema
 * sem que a resposta entregue o funcionamento interno a quem estiver
 * sondando. */
function erroGenerico(res, status, erro, contexto) {
  const requestId = crypto.randomUUID();
  console.error(`[${requestId}] ${contexto}:`, erro && erro.stack ? erro.stack : erro);
  return res.status(status).json({
    erro: 'Não foi possível concluir a operação. Tente novamente em instantes.',
    requestId
  });
}

// ---- login / cadastro (nao exige sessao) ----

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.post('/auth/cadastro', limitarTentativas, async (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ erro: 'Informe e-mail e senha.' });
  }

  // Minimo checado aqui, no servidor: o minlength do formulario e so
  // conveniencia e pode ser contornado. O padrao do Supabase e 6, que e
  // fraco demais para um board com dado de cliente.
  if (senha.length < SENHA_MINIMA) {
    return res.status(400).json({ erro: `A senha precisa ter pelo menos ${SENHA_MINIMA} caracteres.` });
  }

  // 1a checagem de dominio: antes de sequer falar com o Supabase.
  if (!emailPermitido(email)) {
    console.warn(`Cadastro recusado para ${email} (fora da lista permitida).`);
    return res.status(403).json({ erro: 'Esse e-mail não tem acesso liberado a este board.' });
  }

  try {
    await cadastrar(email, senha);
    console.log(`Cadastro iniciado: ${email} (aguardando confirmação por e-mail)`);
    registrarAcesso(email, 'cadastro'); // best-effort, nao trava o cadastro
    res.json({ ok: true });
  } catch (erro) {
    console.error(`Falha no cadastro de ${email}:`, erro.message);
    res.status(400).json({ erro: erro.message });
  }
});

app.post('/auth/entrar', limitarTentativas, async (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ erro: 'Informe e-mail e senha.' });
  }

  try {
    const usuarioSupabase = await entrar(email, senha);

    // 2a checagem de dominio: de novo, agora no login.
    if (!emailPermitido(usuarioSupabase.email)) {
      console.warn(`Login recusado para ${usuarioSupabase.email} (fora da lista permitida).`);
      return res.status(403).json({ erro: 'Esse e-mail não tem acesso liberado a este board.' });
    }

    const token = criarSessao({ email: usuarioSupabase.email });
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: SESSAO_DIAS * 24 * 60 * 60 * 1000
    });

    console.log(`Login: ${usuarioSupabase.email}`);
    registrarAcesso(usuarioSupabase.email, 'login'); // best-effort, nao trava o login
    res.json({ ok: true });
  } catch (erro) {
    console.error(`Falha no login de ${email}:`, erro.message);
    res.status(401).json({ erro: erro.message });
  }
});

app.post('/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// ---- cron diario (nao exige sessao de usuario - exige o segredo do cron) ----

// Excecao consciente: esta rota MUTA estado (grava o snapshot) via GET, o que
// normalmente e proibido. O motivo e que o Vercel Cron so dispara GET. Nao ha
// risco de CSRF aqui porque a rota nao autentica por cookie: exige o header
// Authorization com o CRON_SECRET, que o navegador nunca envia sozinho.
app.get('/api/cron-atualizar', async (req, res) => {
  const auth = req.headers.authorization || '';
  if (!segredoConfere(auth, `Bearer ${process.env.CRON_SECRET}`)) {
    return res.status(401).json({ erro: 'Não autorizado.' });
  }

  try {
    const dados = await executarAtualizacao('cron diário');
    res.json({ ok: true, sprint: dados.sprint });
  } catch (erro) {
    return erroGenerico(res, 500, erro, 'Falha na atualização automática (cron)');
  }
});

// ---- paginas e API protegidas por sessao de usuario ----

app.get('/', exigirSessaoPagina, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/api/eu', exigirSessaoApi, (req, res) => {
  res.json({
    ...req.usuario,
    hubUrl: process.env.HUB_URL || null,
    admin: souAdmin(req.usuario.email),
    editor: souEditor(req.usuario.email)
  });
});

app.get('/api/dados', exigirSessaoApi, async (req, res) => {
  res.json(await lerSnapshot());
});

app.get('/dashboard', exigirSessaoPagina, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'));
});

/** Demandas e Pontos de Função: qualquer pessoa logada vê, só editor altera.
 * Duas rotas, uma página: /demandas só mostra (mesmo para editor, para poder
 * apresentar sem risco de mexer num valor), /demandas/editar é onde se
 * preenche. Cada gravação é por campo (PATCH) e carrega quem mexeu e quando. */
app.get('/demandas', exigirSessaoPagina, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'demandas.html'));
});

app.get('/demandas/editar', exigirSessaoPagina, exigirEditorPagina, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'demandas.html'));
});

/** ?meses=2026-09,2026-10 filtra; sem o parâmetro devolve todos os meses.
 * O resumo (por mês e consolidado) sai daqui, calculado numa função testada,
 * para a tela não reimplementar a regra do consolidado. */
app.get('/api/demandas', exigirSessaoApi, async (req, res) => {
  let meses = null;
  if (req.query.meses !== undefined) {
    const p = interpretarListaMeses(req.query.meses);
    if (!p.ok) return res.status(400).json({ erro: p.erro });
    meses = p.valor;
  }
  const r = await listarDemandas();
  if (!r.ok) return res.status(503).json({ erro: 'Não foi possível carregar as demandas agora.' });
  const disponiveis = mesesDisponiveis(r.demandas);
  res.json({
    demandas: filtrarPorMeses(r.demandas, meses),
    mesesDisponiveis: disponiveis,
    resumo: resumirMeses(r.demandas, meses || disponiveis),
    editor: souEditor(req.usuario.email)
  });
});

app.post('/api/demandas', exigirSessaoApi, exigirEditorApi, async (req, res) => {
  const m = interpretarMes(req.body && req.body.mes);
  if (!m.ok) return res.status(400).json({ erro: m.erro });
  const r = await criarDemanda(req.usuario.email, m.valor);
  if (!r.ok) return res.status(500).json({ erro: 'Não foi possível criar a linha.' });
  console.log(`[demandas] ${req.usuario.email} criou a linha #${r.demanda.id} em ${m.valor}`);
  res.status(201).json({ demanda: r.demanda });
});

app.patch('/api/demandas/:id', exigirSessaoApi, exigirEditorApi, async (req, res) => {
  const id = idDemanda(req.params.id);
  if (!id) return res.status(400).json({ erro: 'Identificador inválido.' });
  const n = normalizarCampos(req.body);
  if (!n.ok) return res.status(400).json({ erro: n.erro });
  const r = await atualizarDemanda(id, n.registro, req.usuario.email);
  if (r.naoEncontrada) return res.status(404).json({ erro: 'Linha não encontrada (pode ter sido removida).' });
  if (!r.ok) return res.status(500).json({ erro: 'Não foi possível salvar.' });
  console.log(`[demandas] ${req.usuario.email} alterou #${id}: ${Object.keys(n.registro).join(', ')}`);
  res.json({ demanda: r.demanda });
});

app.delete('/api/demandas/:id', exigirSessaoApi, exigirEditorApi, async (req, res) => {
  const id = idDemanda(req.params.id);
  if (!id) return res.status(400).json({ erro: 'Identificador inválido.' });
  const r = await removerDemanda(id, req.usuario.email);
  if (r.naoEncontrada) return res.status(404).json({ erro: 'Linha não encontrada (pode já ter sido removida).' });
  if (!r.ok) return res.status(500).json({ erro: 'Não foi possível remover.' });
  console.log(`[demandas] ${req.usuario.email} removeu #${id}`);
  res.json({ ok: true });
});

app.get('/admin', exigirSessaoPagina, exigirAdminPagina, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

/** Quem está cadastrado (Supabase Auth) e o histórico de acessos - só pra
 * quem está em ADMIN_EMAILS (ver auth.js). */
app.get('/api/admin/usuarios', exigirSessaoApi, exigirAdminApi, async (req, res) => {
  res.json({ usuarios: await listarUsuarios() });
});

app.get('/api/admin/acessos', exigirSessaoApi, exigirAdminApi, async (req, res) => {
  res.json({ acessos: await listarAcessos(200) });
});

/** Confirma o e-mail de alguém sem esperar o link chegar - existe porque o
 * envio pode falhar (rate limit do Supabase, filtro corporativo do
 * destinatário) sem nenhum aviso pro usuário. POST porque muda estado. */
app.post('/api/admin/usuarios/:id/confirmar', exigirSessaoApi, exigirAdminApi, async (req, res) => {
  const resultado = await confirmarUsuarioManualmente(req.params.id);
  if (!resultado.ok) return res.status(400).json({ erro: 'Não foi possível confirmar esse usuário.' });
  console.log(`[admin] ${req.usuario.email} confirmou manualmente: ${resultado.email}`);
  registrarAcesso(resultado.email, 'confirmado-manualmente');
  res.json({ ok: true });
});

/** Métricas do sprint + série histórica para os gráficos de fluxo.
 *
 * As métricas saem do snapshot, calculadas na carga - não refazemos conta a
 * cada visita, nem chamamos o Jira aqui. O histórico é lido à parte porque
 * mora em outra tabela, uma linha por dia. */
app.get('/api/metricas', exigirSessaoApi, async (req, res) => {
  const snapshot = await lerSnapshot();
  const historico = await lerHistorico(60);
  res.json({
    sprint: snapshot.sprint || null,
    sprintId: snapshot.sprintId || null,
    atualizadoEm: snapshot.atualizadoEm || null,
    metricas: snapshot.metricas || null,
    historico
  });
});

app.get('/api/entregas', exigirSessaoApi, async (req, res) => {
  const { sprint, mes, inicio, fim } = req.query;
  if (mes && !/^\d{4}-\d{2}$/.test(mes)) {
    return res.status(400).json({ erro: 'Mês inválido. Use o formato AAAA-MM.' });
  }
  if (inicio && !/^\d{4}-\d{2}-\d{2}$/.test(inicio)) {
    return res.status(400).json({ erro: 'Data inicial inválida. Use o formato AAAA-MM-DD.' });
  }
  if (fim && !/^\d{4}-\d{2}-\d{2}$/.test(fim)) {
    return res.status(400).json({ erro: 'Data final inválida. Use o formato AAAA-MM-DD.' });
  }
  const entregas = await lerEntregas({
    sprint: sprint || undefined,
    mes: mes || undefined,
    inicio: inicio || undefined,
    fim: fim ? `${fim}T23:59:59.999Z` : undefined
  });
  res.json({ entregas });
});

app.get('/api/entregas/sprints', exigirSessaoApi, async (req, res) => {
  res.json({
    sprints: await listarSprintsEntregas(),
    meses: await listarMesesEntregas()
  });
});

/** Planejado x Entregue de UMA sprint: quantos itens nasceram nela
 * (sprintId = sprint de ORIGEM) e o que aconteceu com cada um - entregue no
 * prazo, entregue atrasado (saiu so numa sprint posterior) ou ainda aberto
 * hoje. `carryOverEntregue` é o contraponto: quanto do que saiu NESSA
 * sprint na verdade veio de atraso de sprints anteriores. */
app.get('/api/planejamento', exigirSessaoApi, async (req, res) => {
  const sprintId = Number(req.query.sprintId);
  if (!req.query.sprintId || Number.isNaN(sprintId)) {
    return res.status(400).json({ erro: 'sprintId é obrigatório e deve ser numérico.' });
  }
  const planejamento = await lerPlanejamentoSprint(sprintId);
  const carryOverEntregue = await lerCarryOverEntregue(sprintId);
  res.json({ planejamento, carryOverEntregue });
});

/** Serie historica (uma sprint por ponto) para o grafico comparativo. */
app.get('/api/planejamento/serie', exigirSessaoApi, async (req, res) => {
  const serie = await listarPlanejamentoPorSprint();
  serie.sort((a, b) => (a.sprintOrigemId || 0) - (b.sprintOrigemId || 0));
  res.json({ serie });
});

/** Detalhe item a item de UMA sprint - o que o clique na barra do grafico
 * historico abre: quais épicos/tasks avulsas nasceram ali, entregue ou não,
 * no prazo ou atrasado. `carryOver` é o complemento: itens nascidos em
 * sprint ANTERIOR mas entregues durante esta - sem isso, quem clica achava
 * que só saiu o que nasceu ali (bug reportado: "setembro teve mais de 3
 * entregues", e tinha - 7 eram carry-over de agosto/julho). */
app.get('/api/planejamento/itens', exigirSessaoApi, async (req, res) => {
  const sprintId = Number(req.query.sprintId);
  if (!req.query.sprintId || Number.isNaN(sprintId)) {
    return res.status(400).json({ erro: 'sprintId é obrigatório e deve ser numérico.' });
  }
  const [itens, carryOver] = await Promise.all([
    listarItensPlanejamento(sprintId),
    listarItensCarryOver(sprintId)
  ]);
  res.json({ itens, carryOver });
});

// Muta estado, entao e POST (nunca GET). A protecao anti-CSRF aqui e o
// cookie de sessao com SameSite=Lax: o navegador nao envia o cookie em POST
// vindo de outro site, entao um formulario hostil em outro dominio nao
// consegue disparar esta rota em nome de quem esta logado.
app.post('/api/atualizar', exigirSessaoApi, async (req, res) => {
  try {
    const dados = await executarAtualizacao(req.usuario.email);
    res.json(dados);
  } catch (erro) {
    return erroGenerico(res, 500, erro, 'Falha ao atualizar o board');
  }
});

// Local: `node server.js` roda o servidor de verdade.
// Vercel: importa `app` como funcao serverless, sem chamar listen().
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Kanban BRB rodando em http://localhost:${PORT}`);
  });
}

module.exports = app;
