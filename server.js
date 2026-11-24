require('dotenv').config({ path: '.env.local' });

const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const { buscarBoard, buscarEntregasHistoricas, chamarJira } = require('./jira');
const {
  cadastrar, entrar, lerSnapshot, gravarSnapshot, gravarHistorico, lerHistorico,
  gravarEntregas, lerEntregas, listarSprintsEntregas, listarMesesEntregas, gravarPlanejamento,
  lerPlanejamentoSprint, lerCarryOverEntregue, listarPlanejamentoPorSprint, listarItensPlanejamento,
  listarItensCarryOver, registrarAcesso, registrarVisitaDoDia, queimarPasse, listarAcessos, listarUsuarios, confirmarUsuarioManualmente,
  listarDemandas, criarDemanda, atualizarDemanda, removerDemanda, listarHistoricoDemandas,
  lerExpedicao, listarChavesExpedicoes, listarExpedicoes, criarExpedicao, atualizarExpedicao, removerExpedicao,
  contarExpedicoesExcluidas, listarExpedicoesExcluidas, restaurarExpedicao,
  criarItemExpedicao, atualizarItemExpedicao, atualizarObservacaoItem, removerItemExpedicao, registrarGravacaoJira,
  listarSolicitacoesAcs, lerEstadoColetaAcs, gravarCargaAcs, registrarFalhaColetaAcs, pedirAtualizacaoAcs
} = require('./supabase');
const { normalizarCarga, normalizarErroColetor, situacaoColeta, deveColetar, conferirAssinatura } = require('./acs');
const { podeGravarJira, lerCampos, validarPedido, gravarCampo } = require('./gravarJira');
const {
  normalizarCampos, idDemanda, interpretarMes, interpretarListaMeses, mesesDisponiveis,
  filtrarPorMeses, resumirMeses
} = require('./demandas');
const {
  chaveJira, normalizarExpedicao, normalizarItemNovo, normalizarEstadoItem, normalizarObservacao, itensDoQuadro, montarOpcoes,
  decorar, hojeBrasilia, idExpedicao, planoParaDemandas, planoParaExpedicao, recadoSincronia, recusaPeloJira,
  normalizarMotivoExclusao
} = require('./expedicoes');
const { criarCache, verificar, verificarVarias } = require('./checklistJira');
const { normalizarTermo, pesquisar, MAX_TEXTO, MAX_TERMOS, limparTermo, extrairTermos, pesquisarAmplo } = require('./pesquisa');
const { ssoAtivo, emitirPasse, lerPasse, caminhoSeguro, urlDeEntrada } = require('./sso');
const {
  COOKIE_NAME,
  SESSAO_DIAS,
  emailPermitido,
  cronAutorizado,
  criarSessao,
  exigirSessaoPagina,
  exigirSessaoApi,
  exigirAdminPagina,
  exigirAdminApi,
  exigirEditorApi,
  exigirEditorPagina,
  exigirEquipePagina,
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
// Exceção: a gravação no Jira recebe a Solução (até 4000 caracteres, que com
// acento e quebra de linha passa de 10kb).
const jsonPadrao = express.json({ limit: '10kb' });
const jsonJira = express.json({ limit: '32kb' });
// Coletor do ACS: a lista de solicitações é grande (dezenas de kb), e o corpo
// cru é guardado porque a assinatura do pedido é calculada sobre ele.
const jsonColetor = express.json({ limit: '1mb', verify: (req, res, buf) => { req.corpoCru = buf; } });
function leitorDeCorpo(caminho) {
  if (caminho.startsWith('/api/acs/coletor/')) return jsonColetor;
  return caminho.startsWith('/api/jira/') ? jsonJira : jsonPadrao;
}
app.use((req, res, next) => leitorDeCorpo(req.path)(req, res, next));
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
  if (req.path === '/' || req.path.endsWith('.html') || ['/dashboard', '/admin', '/demandas', '/demandas/editar', '/demandas/historico', '/expedicoes', '/pesquisa'].includes(req.path)) {
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

// Caixas de diálogo compartilhadas pelas telas (pública, sem dado nenhum). Na Vercel
// o arquivo sai direto da pasta static; esta rota serve o mesmo no ambiente local.
app.get('/dialogo.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('application/javascript').sendFile(path.join(__dirname, 'static', 'dialogo.js'));
});

// Menu do topo, igual em todas as telas (público, sem dado nenhum: quem vê o
// quê ele pergunta a /api/eu). Mesmo esquema do /dialogo.js acima.
app.get('/menu.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('application/javascript').sendFile(path.join(__dirname, 'static', 'menu.js'));
});

// Painel "Buscar no Jira" (botão flutuante). Público como o menu: sem dado
// nenhum; o menu.js só o carrega para a equipe e a API barra o resto.
app.get('/busca.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('application/javascript').sendFile(path.join(__dirname, 'static', 'busca.js'));
});

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.post('/auth/cadastro', limitarTentativas, async (req, res) => {
  const { email, senha } = req.body;

  // Só texto: o corpo é JSON e pode trazer objeto, lista ou número.
  if (!email || !senha || typeof email !== 'string' || typeof senha !== 'string') {
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
    await registrarAcesso(email, 'cadastro'); // best-effort: falha só loga, nao trava o cadastro
    res.json({ ok: true });
  } catch (erro) {
    console.error(`Falha no cadastro de ${email}:`, erro.message);
    res.status(400).json({ erro: erro.message });
  }
});

/** Cookie de sessão - o mesmo no login com senha e no login único (/sso). */
function abrirSessao(res, email) {
  res.cookie(COOKIE_NAME, criarSessao({ email }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSAO_DIAS * 24 * 60 * 60 * 1000
  });
}

/* ---- login único (sso.js) ----
 * Chegada: quem vem do Portal (ou do Qualidade) já logado traz um passe de
 * uso único. Confere passe, confere a NOSSA lista de acesso, queima o passe
 * e abre a sessão como no login. Qualquer falha cai no login normal - nunca
 * entra "meio logado". Pública por natureza: é ela que cria a sessão.
 * Sem limitarTentativas de propósito: o passe é assinado (não há o que
 * adivinhar), e o time todo sai pelo mesmo IP do escritório - 10 cliques em
 * 15 min travariam gente legítima. */
app.get('/sso', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const dados = lerPasse(req.query.passe, 'kanban');
  if (!dados) return res.redirect(303, '/login.html?sso=expirado');
  if (!emailPermitido(dados.email)) {
    console.warn(`[sso] passe recusado: domínio ${dados.email.split('@')[1]} sem acesso ao Kanban`);
    return res.redirect(303, '/login.html?sso=sem-acesso');
  }
  if (!(await queimarPasse(dados.jti, 'kanban'))) return res.redirect(303, '/login.html?sso=expirado');
  abrirSessao(res, dados.email);
  await registrarAcesso(dados.email, 'login-unico');
  console.log(`Login único: ${dados.email}`);
  res.redirect(303, caminhoSeguro(req.query.destino));
});

/* Saída para o Qualidade levando o passe: o item "Qualidade" do menu aponta
 * para cá. Mesma regra de quem vê o item (veQualidade). Login único
 * desligado (sem SSO_SECRET): segue para o endereço puro, como antes. */
app.get('/ir/qualidade', exigirSessaoPagina, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const base = process.env.QUALIDADE_URL;
  if (!base || !veQualidade(req.usuario.email)) return res.redirect('/');
  const passe = ssoAtivo() ? emitirPasse(req.usuario.email, 'qualidade', 'kanban') : null;
  res.redirect(passe ? urlDeEntrada(base, passe, '/') : base);
});

app.post('/auth/entrar', limitarTentativas, async (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha || typeof email !== 'string' || typeof senha !== 'string') {
    return res.status(400).json({ erro: 'Informe e-mail e senha.' });
  }

  try {
    const usuarioSupabase = await entrar(email, senha);

    // 2a checagem de dominio: de novo, agora no login.
    if (!emailPermitido(usuarioSupabase.email)) {
      console.warn(`Login recusado para ${usuarioSupabase.email} (fora da lista permitida).`);
      return res.status(403).json({ erro: 'Esse e-mail não tem acesso liberado a este board.' });
    }

    abrirSessao(res, usuarioSupabase.email);

    console.log(`Login: ${usuarioSupabase.email}`);
    await registrarAcesso(usuarioSupabase.email, 'login'); // best-effort: falha só loga, nao trava o login
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
  if (!cronAutorizado(auth, process.env.CRON_SECRET)) {
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

// O BRB não usa o Portal (lá ele é mandado direto de volta para o Kanban):
// sem o endereço, o menu nem mostra o atalho.
function usaPortal(email) {
  const partes = String(email || '').trim().toLowerCase().split('@');
  return partes.length === 2 && partes[1] !== 'brb.com.br';
}

// Quem vê o Qualidade no menu: os mesmos domínios que o Portal usa para o
// cartão dele (DOMINIOS_QUALIDADE do hub), que coincidem com o que o próprio
// Qualidade aceita. Se o Qualidade mudar quem libera, as duas listas acompanham.
// Sem QUALIDADE_URL configurada, o item simplesmente não aparece.
const DOMINIOS_QUALIDADE = ['dimensa.com.br', 'brb.com.br', 'evertecinc.com.br'];

function veQualidade(email) {
  const partes = String(email || '').trim().toLowerCase().split('@');
  return partes.length === 2 && DOMINIOS_QUALIDADE.includes(partes[1]);
}

// Toda tela pede /api/eu ao abrir (o menu do topo): é o ponto que marca a
// "visita do dia" no histórico de acessos - uma linha por pessoa por dia.
app.get('/api/eu', exigirSessaoApi, async (req, res) => {
  await registrarVisitaDoDia(req.usuario.email, hojeBrasilia());
  res.json({
    ...req.usuario,
    hubUrl: (process.env.HUB_URL && usaPortal(req.usuario.email)) ? process.env.HUB_URL : null,
    qualidadeUrl: (process.env.QUALIDADE_URL && veQualidade(req.usuario.email)) ? process.env.QUALIDADE_URL : null,
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

/** Demandas: as solicitações em andamento no ACS do BRB (acs.js). Só a equipe
 * (Dimensa/Evertec) vê - a lista traz nome de gestor e dado interno do banco.
 *
 * O servidor não alcança o ACS (rede interna do BRB, login Windows): quem
 * busca é o coletor (coletor/coletor-acs.ps1), que manda a lista para
 * /api/acs/coletor/carga. A tela só lê o que está gravado. */
app.get('/demandas', exigirSessaoPagina, exigirEquipePagina, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'demandas-acs.html'));
});

const MSG_SEM_TABELA_ACS = 'As demandas do ACS ainda não foram ativadas no banco (falta rodar supabase-acs.sql).';

function coletaParaTela(estado, agora) {
  return {
    ultimaOk: estado.ultimaOk,
    ...situacaoColeta(estado.ultimaOk, agora),
    ultimaFalha: estado.ultimaFalha,
    pedido: estado.pedido
  };
}

app.get('/api/acs', exigirSessaoApi, exigirEditorApi, async (req, res) => {
  const [lista, estado] = await Promise.all([listarSolicitacoesAcs(), lerEstadoColetaAcs()]);
  if (lista.semTabela || estado.semTabela) return res.status(503).json({ erro: MSG_SEM_TABELA_ACS, semTabela: true });
  if (!lista.ok || !estado.ok) return res.status(503).json({ erro: 'Não foi possível carregar as demandas agora.' });
  res.json({ hoje: hojeBrasilia(), solicitacoes: lista.solicitacoes, coleta: coletaParaTela(estado, new Date()) });
});

// Botão "Atualizar": não busca nada na hora (o servidor não alcança o ACS),
// só deixa o pedido para o coletor atender na próxima vez que perguntar.
app.post('/api/acs/atualizar', exigirSessaoApi, exigirEditorApi, async (req, res) => {
  const r = await pedirAtualizacaoAcs(req.usuario.email);
  if (r.semTabela) return res.status(503).json({ erro: MSG_SEM_TABELA_ACS, semTabela: true });
  if (!r.ok) return res.status(500).json({ erro: 'Não foi possível registrar o pedido de atualização.' });
  if (!r.jaPedido) console.log(`[acs] ${req.usuario.email} pediu atualização`);
  res.status(r.jaPedido ? 200 : 201).json({ pedido: r.pedido, jaPedido: r.jaPedido });
});

/* ---- coletor do ACS (não exige sessão - exige a assinatura do coletor) ----
 * Não autentica por cookie, então não há CSRF: o navegador nunca monta estes
 * cabeçalhos sozinho. Sem ACS_COLETOR_SEGREDO no ambiente, tudo responde 401. */
function exigirColetor(req, res, next) {
  const confere = conferirAssinatura({
    segredo: process.env.ACS_COLETOR_SEGREDO,
    timestamp: req.get('x-coletor-timestamp'),
    assinatura: req.get('x-coletor-assinatura'),
    metodo: req.method,
    caminho: req.path,
    corpo: req.corpoCru,
    agora: Date.now()
  });
  if (!confere) return res.status(401).json({ erro: 'Não autorizado.' });
  next();
}

// "Tenho que coletar agora?" A regra (8h de dia útil, ou pedido do botão) fica
// no servidor: muda sem precisar mexer na máquina do coletor.
app.get('/api/acs/coletor/tarefa', exigirColetor, async (req, res) => {
  const estado = await lerEstadoColetaAcs();
  if (!estado.ok) return res.status(503).json({ erro: estado.semTabela ? MSG_SEM_TABELA_ACS : 'Banco indisponível.' });
  res.json(deveColetar({
    agora: new Date(),
    ultimaOk: estado.ultimaOk,
    ultimaFalha: estado.ultimaFalha && estado.ultimaFalha.quando,
    pedidoPendente: !!estado.pedido
  }));
});

// Corpo: { solicitacoes: [...] } quando o ACS respondeu, ou { erro: "..." }
// quando o coletor não conseguiu (a falha fica registrada e aparece na tela).
app.post('/api/acs/coletor/carga', exigirColetor, async (req, res) => {
  const falha = normalizarErroColetor(req.body);
  if (falha) {
    console.warn(`[acs] o coletor avisou que não conseguiu coletar: ${falha}`);
    const r = await registrarFalhaColetaAcs(falha);
    return res.status(r.ok ? 200 : 503).json({ ok: r.ok, registrado: 'falha' });
  }
  const n = normalizarCarga(req.body);
  if (!n.ok) {
    console.warn(`[acs] carga recusada: ${n.erro}`);
    await registrarFalhaColetaAcs(n.erro);
    return res.status(400).json({ erro: n.erro });
  }
  const r = await gravarCargaAcs(n.linhas);
  if (!r.ok) return res.status(503).json({ erro: r.semTabela ? MSG_SEM_TABELA_ACS : 'Não foi possível gravar a carga.' });
  console.log(`[acs] carga gravada: ${r.quantidade} solicitações em andamento`);
  res.json({ ok: true, quantidade: r.quantidade });
});

/** Demandas e Pontos de Função (tela anterior): continua em /demandas/editar,
 * só para editor. Expedições e Pesquisa ainda leem estes dados. Cada gravação
 * é por campo (PATCH) e carrega quem mexeu e quando. */

app.get('/demandas/editar', exigirSessaoPagina, exigirEditorPagina, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'demandas.html'));
});

/** Historico completo de alteracoes (quem, quando, o que mudou). So editor:
 * mostra e-mails da equipe e valores de cobranca, e inclui o que foi removido. */
app.get('/demandas/historico', exigirSessaoPagina, exigirEditorPagina, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'demandas-historico.html'));
});

app.get('/api/demandas/historico', exigirSessaoApi, exigirEditorApi, async (req, res) => {
  let demandaId = null;
  if (req.query.demanda !== undefined) {
    demandaId = idDemanda(req.query.demanda);
    if (!demandaId) return res.status(400).json({ erro: 'Identificador inválido.' });
  }
  let mes = null;
  if (req.query.mes !== undefined) {
    const m = interpretarMes(req.query.mes);
    if (!m.ok) return res.status(400).json({ erro: m.erro });
    mes = m.valor;
  }
  const r = await listarHistoricoDemandas({ demandaId, mes, limite: req.query.limite });
  if (r.semTabela) {
    return res.status(503).json({ erro: 'O histórico ainda não foi ativado no banco (falta rodar supabase-demandas-historico.sql).', semTabela: true });
  }
  if (!r.ok) return res.status(503).json({ erro: 'Não foi possível carregar o histórico agora.' });
  res.json({ eventos: r.eventos });
});

/** ?meses=2026-09,2026-10 filtra; sem o parâmetro devolve todos os meses.
 * O resumo (por mês e consolidado) sai daqui, calculado numa função testada,
 * para a tela não reimplementar a regra do consolidado.
 * Só a equipe: a única tela que lê isto (/demandas/editar) já é só dela, e a
 * resposta traz pontos de função (cobrança), observações e e-mails. */
app.get('/api/demandas', exigirSessaoApi, exigirEditorApi, async (req, res) => {
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
  const sincronia = n.registro.previsao_expedicao ? await sincronizarParaExpedicao(r.demanda, req.usuario.email) : null;
  res.json({ demanda: r.demanda, sincronia });
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

/** Expedições: checklist do time para expedições (usado na reunião diária). Controle interno -
 * só Dimensa/Evertec veem e marcam; BRB e TOTVS nem abrem (página volta para o
 * board, API responde 403). O responsável vem sempre do card no Jira. */
/** Data de expedição: Expedições -> Demandas. Nunca derruba a gravação principal. */
async function sincronizarParaDemandas(expedicao, email) {
  try {
    const [ex, dem] = await Promise.all([listarChavesExpedicoes(), listarDemandas()]);
    if (!ex.ok || !dem.ok) return null; // sem como conferir: segue sem sincronizar
    const plano = planoParaDemandas(expedicao, ex.expedicoes, dem.demandas);
    let gravou = true;
    if (plano.acao === 'atualizar') {
      gravou = (await atualizarDemanda(plano.demandaId, { previsao_expedicao: plano.data }, email)).ok;
      if (gravou) console.log(`[sincronia] ${email}: expedição #${expedicao.id} -> demanda #${plano.demandaId} (${plano.mes}) previsão ${plano.data}`);
    }
    return recadoSincronia('demandas', plano, gravou);
  } catch (erro) {
    console.error('[sincronia] expedição -> demandas falhou:', erro.message);
    return { destino: 'demandas', status: 'erro', texto: 'A data foi salva aqui, mas não consegui atualizá-la em Demandas.' };
  }
}

/** Data de expedição: Demandas -> Expedições. */
async function sincronizarParaExpedicao(demanda, email) {
  try {
    const [ex, dem] = await Promise.all([listarChavesExpedicoes(), listarDemandas()]);
    if (!ex.ok || !dem.ok) return null; // tabela de expedições ainda não existe, ou banco fora
    const plano = planoParaExpedicao(demanda, dem.demandas, ex.expedicoes);
    let gravou = true;
    if (plano.acao === 'atualizar') {
      gravou = (await atualizarExpedicao(plano.expedicaoId, { data_expedicao: plano.data }, email)).ok;
      if (gravou) console.log(`[sincronia] ${email}: demanda #${demanda.id} -> expedição #${plano.expedicaoId} data ${plano.data}`);
    }
    return recadoSincronia('expedicoes', plano, gravou);
  } catch (erro) {
    console.error('[sincronia] demandas -> expedição falhou:', erro.message);
    return { destino: 'expedicoes', status: 'erro', texto: 'A data foi salva aqui, mas não consegui atualizá-la em Expedições.' };
  }
}

// O Jira responde parte do checklist (checklistJira.js). Cache curto em memória; o botão
// "Atualizar" (na tela) passa por cima dele.
const cacheJira = criarCache();
async function verificacaoJira(expedicao, forcar) {
  const chave = chaveJira(expedicao.artefatoJira);
  if (!chave) return null;
  return verificar(chave, chamarJira, { cache: cacheJira, forcar: !!forcar });
}
async function decorarExpedicao(e, snapshot, forcar) {
  return decorar(e, snapshot, hojeBrasilia(), await verificacaoJira(e, forcar));
}

const MSG_SEM_TABELA_EXPEDICOES = 'As expedições ainda não foram ativadas no banco (falta rodar supabase-expedicoes.sql).';

app.get('/expedicoes', exigirSessaoPagina, exigirEquipePagina, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'expedicoes.html'));
});

app.get('/api/expedicoes', exigirSessaoApi, exigirEditorApi, async (req, res) => {
  const [r, excluidas] = await Promise.all([listarExpedicoes(), contarExpedicoesExcluidas()]);
  if (r.semTabela) {
    return res.status(503).json({ erro: MSG_SEM_TABELA_EXPEDICOES, semTabela: true });
  }
  if (!r.ok) return res.status(503).json({ erro: 'Não foi possível carregar as expedições agora.' });
  const snapshot = await lerSnapshot();
  // ?atualizarJira=1 (botão "Atualizar") passa por cima do cache
  const forcar = req.query.atualizarJira === '1';
  const chaves = r.expedicoes.map((e) => chaveJira(e.artefatoJira)).filter(Boolean);
  const lidas = await verificarVarias(chaves, chamarJira, { cache: cacheJira, forcar });
  const hoje = hojeBrasilia();
  res.json({
    hoje,
    podeGravarJira: podeGravarJira(req.usuario.email),
    excluidas, // só a quantidade (null = não consegui contar); a lista vem de /api/expedicoes/excluidas
    expedicoes: r.expedicoes.map((e) => decorar(e, snapshot, hoje, lidas[chaveJira(e.artefatoJira)] || null))
  });
});

// Filtro "Excluídas": quem excluiu, quando e por quê (mais recentes primeiro).
app.get('/api/expedicoes/excluidas', exigirSessaoApi, exigirEditorApi, async (req, res) => {
  const r = await listarExpedicoesExcluidas();
  if (!r.ok) return res.status(503).json({ erro: 'Não foi possível carregar as expedições excluídas agora.' });
  res.json({ expedicoes: r.expedicoes });
});

app.post('/api/expedicoes/:id/restaurar', exigirSessaoApi, exigirEditorApi, async (req, res) => {
  const id = idExpedicao(req.params.id);
  if (!id) return res.status(400).json({ erro: 'Identificador inválido.' });
  const r = await restaurarExpedicao(id, req.usuario.email);
  if (r.naoEncontrada) return res.status(404).json({ erro: 'Expedição não encontrada entre as excluídas (pode já ter sido restaurada).' });
  if (!r.ok || !r.expedicao) return res.status(500).json({ erro: 'Não foi possível restaurar.' });
  console.log(`[expedicoes] ${req.usuario.email} restaurou a expedição #${id}`);
  res.json({ expedicao: await decorarExpedicao(r.expedicao, await lerSnapshot(), true) });
});

/** Autocomplete: o que está no quadro Kanban, com ACS e data já cadastrados em
 * Demandas quando a chave bate. */
app.get('/api/expedicoes/opcoes', exigirSessaoApi, exigirEditorApi, async (req, res) => {
  const [snapshot, demandas] = await Promise.all([lerSnapshot(), listarDemandas()]);
  res.json({ opcoes: montarOpcoes(snapshot, demandas.ok ? demandas.demandas : []) });
});

app.post('/api/expedicoes', exigirSessaoApi, exigirEditorApi, async (req, res) => {
  const n = normalizarExpedicao(req.body, { criando: true });
  if (!n.ok) return res.status(400).json({ erro: n.erro });
  const snapshot = await lerSnapshot();
  const doQuadro = itensDoQuadro(snapshot).get(chaveJira(n.registro.artefato_jira));
  if (doQuadro && doQuadro.responsavel) n.registro.responsavel = doQuadro.responsavel;
  const r = await criarExpedicao(req.usuario.email, n.registro);
  if (r.semTabela) return res.status(503).json({ erro: MSG_SEM_TABELA_EXPEDICOES, semTabela: true });
  if (!r.ok) return res.status(500).json({ erro: 'Não foi possível criar a expedição.' });
  console.log(`[expedicoes] ${req.usuario.email} criou a expedição #${r.expedicao.id}`);
  const sincronia = r.expedicao.dataExpedicao ? await sincronizarParaDemandas(r.expedicao, req.usuario.email) : null;
  res.status(201).json({ expedicao: await decorarExpedicao(r.expedicao, snapshot, true), sincronia });
});

app.patch('/api/expedicoes/:id', exigirSessaoApi, exigirEditorApi, async (req, res) => {
  const id = idExpedicao(req.params.id);
  if (!id) return res.status(400).json({ erro: 'Identificador inválido.' });
  const n = normalizarExpedicao(req.body);
  if (!n.ok) return res.status(400).json({ erro: n.erro });
  const snapshot = await lerSnapshot();
  if (n.registro.artefato_jira) {
    const doQuadro = itensDoQuadro(snapshot).get(chaveJira(n.registro.artefato_jira));
    if (doQuadro && doQuadro.responsavel) n.registro.responsavel = doQuadro.responsavel;
  }
  const r = await atualizarExpedicao(id, n.registro, req.usuario.email);
  if (r.semColuna) return res.status(503).json({ erro: 'O campo PF ainda não foi ativado no banco (falta rodar supabase-expedicoes-campos.sql).', semTabela: true });
  if (r.naoEncontrada) return res.status(404).json({ erro: 'Expedição não encontrada (pode ter sido removida).' });
  if (!r.ok) return res.status(500).json({ erro: 'Não foi possível salvar.' });
  // só uma data PREENCHIDA propaga; apagar nunca (ver sincronia em expedicoes.js)
  const sincronia = n.registro.data_expedicao ? await sincronizarParaDemandas(r.expedicao, req.usuario.email) : null;
  res.json({ expedicao: await decorarExpedicao(r.expedicao, snapshot, n.registro.artefato_jira !== undefined), sincronia });
});

app.delete('/api/expedicoes/:id', exigirSessaoApi, exigirEditorApi, async (req, res) => {
  const id = idExpedicao(req.params.id);
  if (!id) return res.status(400).json({ erro: 'Identificador inválido.' });
  let atual;
  try { atual = await lerExpedicao(id); } catch (erro) {
    console.error('[expedicoes] não consegui ler a expedição antes de excluir:', erro.message);
    return res.status(500).json({ erro: 'Não foi possível remover.' });
  }
  if (!atual) return res.status(404).json({ erro: 'Expedição não encontrada (pode já ter sido removida).' });
  // motivo obrigatório (menos na expedição em branco)
  const m = normalizarMotivoExclusao(atual, req.body && req.body.motivo);
  if (!m.ok) return res.status(400).json({ erro: m.erro });
  const r = await removerExpedicao(id, req.usuario.email, m.motivo);
  if (r.semColunaMotivo) return res.status(503).json({ erro: 'O motivo da exclusão ainda não foi ativado no banco (falta rodar supabase-expedicoes-exclusao.sql). Nada foi excluído.', semTabela: true });
  if (r.naoEncontrada) return res.status(404).json({ erro: 'Expedição não encontrada (pode já ter sido removida).' });
  if (!r.ok) return res.status(500).json({ erro: 'Não foi possível remover.' });
  console.log(`[expedicoes] ${req.usuario.email} removeu a expedição #${id}${m.motivo ? ` (motivo: ${m.motivo.slice(0, 80)})` : ''}`);
  res.json({ ok: true });
});

app.post('/api/expedicoes/:id/itens', exigirSessaoApi, exigirEditorApi, async (req, res) => {
  const id = idExpedicao(req.params.id);
  if (!id) return res.status(400).json({ erro: 'Identificador inválido.' });
  const n = normalizarItemNovo(req.body);
  if (!n.ok) return res.status(400).json({ erro: n.erro });
  const r = await criarItemExpedicao(id, n.bloco, n.texto, req.usuario.email);
  if (r.naoEncontrada) return res.status(404).json({ erro: 'Expedição não encontrada (pode ter sido removida).' });
  if (!r.ok) return res.status(500).json({ erro: 'Não foi possível adicionar o item.' });
  res.status(201).json({ expedicao: await decorarExpedicao(r.expedicao, await lerSnapshot()) });
});

app.patch('/api/expedicoes/:id/itens/:itemId', exigirSessaoApi, exigirEditorApi, async (req, res) => {
  const id = idExpedicao(req.params.id);
  const itemId = idExpedicao(req.params.itemId);
  if (!id || !itemId) return res.status(400).json({ erro: 'Identificador inválido.' });
  const n = normalizarEstadoItem(req.body);
  if (!n.ok) return res.status(400).json({ erro: n.erro });
  // Item que o Jira confirma fica marcado e travado: não se desmarca nem se dispensa
  // aqui. Item que ainda não cumpre no Jira não se marca à mão (só "Não aplicável").
  try {
    const atual = await lerExpedicao(id);
    const item = atual && atual.itens.find((i) => i.id === itemId);
    const recusa = item ? recusaPeloJira(item, await verificacaoJira(atual), n.estado) : '';
    if (recusa) return res.status(400).json({ erro: recusa });
  } catch (erro) {
    // sem como conferir agora: segue, e a gravação abaixo trata a falha do banco
    console.error('[expedicoes] não consegui conferir o item no Jira:', erro.message);
  }
  const r = await atualizarItemExpedicao(id, itemId, n.estado, n.justificativa, req.usuario.email);
  if (r.naoEncontrada) return res.status(404).json({ erro: 'Item não encontrado (pode ter sido removido).' });
  if (!r.ok) return res.status(500).json({ erro: 'Não foi possível salvar.' });
  res.json({ expedicao: await decorarExpedicao(r.expedicao, await lerSnapshot()) });
});

app.patch('/api/expedicoes/:id/itens/:itemId/observacao', exigirSessaoApi, exigirEditorApi, async (req, res) => {
  const id = idExpedicao(req.params.id);
  const itemId = idExpedicao(req.params.itemId);
  if (!id || !itemId) return res.status(400).json({ erro: 'Identificador inválido.' });
  const n = normalizarObservacao(req.body);
  if (!n.ok) return res.status(400).json({ erro: n.erro });
  const r = await atualizarObservacaoItem(id, itemId, n.observacao, req.usuario.email);
  if (r.semColuna) return res.status(503).json({ erro: 'As observações ainda não foram ativadas no banco (falta rodar supabase-expedicoes-observacao.sql).', semTabela: true });
  if (r.naoEncontrada) return res.status(404).json({ erro: 'Item não encontrado (pode ter sido removido).' });
  if (!r.ok) return res.status(500).json({ erro: 'Não foi possível salvar a observação.' });
  res.json({ expedicao: await decorarExpedicao(r.expedicao, await lerSnapshot()) });
});

/* ---------- gravação no Jira (gravarJira.js): os campos do checklist ----------
 * Só @dimensa e @evertecinc (lista fixa em gravarJira.js, não segue EDITOR_DOMAINS).
 * No Jira sai só a alteração do campo, em nome da conta do token; quem gravou
 * fica na tabela jira_gravacoes. */
function exigirGravadorJira(req, res, next) {
  if (!podeGravarJira(req.usuario && req.usuario.email)) {
    return res.status(403).json({ erro: 'Só a equipe Dimensa e Evertec pode gravar no Jira.' });
  }
  next();
}

// Os campos pedidos (?campos=versoes,dataPrevista) da task, ou das tasks filhas do épico.
app.get('/api/jira/campos', exigirSessaoApi, exigirEditorApi, exigirGravadorJira, async (req, res) => {
  try {
    const r = await lerCampos(req.query.chave, req.query.campos, chamarJira);
    if (r.status === 'fora-do-projeto') return res.status(400).json({ erro: 'Só issues do projeto JDCBBRB podem ser editadas daqui.' });
    if (r.status === 'campo-invalido') return res.status(400).json({ erro: 'Campo que não pode ser gravado daqui.' });
    if (r.status === 'nao-encontrada') return res.status(404).json({ erro: 'O Jira não encontrou essa chave.' });
    res.json(r);
  } catch (erro) {
    console.error('[jira-gravar] não consegui ler os campos:', erro.message);
    res.status(503).json({ erro: 'Não consegui ler o Jira agora. Tente de novo.' });
  }
});

// Grava UM campo de UMA task. Corpo: { campo, valor, versao, expedicaoId }.
app.put('/api/jira/campo/:chave', exigirSessaoApi, exigirEditorApi, exigirGravadorJira, async (req, res) => {
  const pedido = validarPedido(req.params.chave, req.body);
  if (!pedido.ok) return res.status(400).json({ erro: pedido.erro });
  let r;
  try {
    r = await gravarCampo(pedido, chamarJira);
  } catch (erro) {
    console.error(`[jira-gravar] ${req.usuario.email} não conseguiu gravar ${pedido.campo} de ${pedido.chave}:`, erro.message);
    return res.status(502).json({ erro: 'O Jira não aceitou a gravação agora. Nada foi alterado; tente de novo ou edite no Jira.' });
  }
  if (!r.ok) {
    const status = r.conflito || r.formatada ? 409 : r.naoEncontrada ? 404 : 400;
    return res.status(status).json({ erro: r.erro, conflito: !!r.conflito, formatada: !!r.formatada, atual: r.atual || null });
  }
  let registro = { ok: true };
  if (!r.semMudanca) {
    console.log(`[jira-gravar] ${req.usuario.email} gravou ${r.nome} de ${pedido.chave}`);
    registro = await registrarGravacaoJira({ email: req.usuario.email, issue: pedido.chave, campo: r.nome, anterior: r.anterior, novo: r.novo });
    if (!registro.ok) console.error(`[jira-gravar] gravou no Jira, mas o registro falhou (${pedido.chave}):`, registro.erro);
    // o checklist tem que ver o valor novo já
    cacheJira.limpar();
  }
  // devolve o cartão da expedição atualizado, quando a tela disse qual é
  let expedicao = null;
  const id = idExpedicao(req.body.expedicaoId);
  if (id) {
    try {
      const e = await lerExpedicao(id);
      if (e) expedicao = await decorarExpedicao(e, await lerSnapshot(), true);
    } catch (erro) { console.error('[jira-gravar] não consegui reler a expedição:', erro.message); }
  }
  res.json({
    ok: true, semMudanca: !!r.semMudanca, expedicao,
    aviso: registro.ok ? '' : registro.semTabela
      ? 'Gravado no Jira, mas o registro de quem gravou ainda não está ativo (falta rodar supabase-jira-gravacoes.sql).'
      : 'Gravado no Jira, mas não consegui guardar o registro de quem gravou.'
  });
});

app.delete('/api/expedicoes/:id/itens/:itemId', exigirSessaoApi, exigirEditorApi, async (req, res) => {
  const id = idExpedicao(req.params.id);
  const itemId = idExpedicao(req.params.itemId);
  if (!id || !itemId) return res.status(400).json({ erro: 'Identificador inválido.' });
  const r = await removerItemExpedicao(id, itemId, req.usuario.email);
  if (r.padrao) return res.status(400).json({ erro: 'Item padrão não pode ser removido: marque como "não aplicável" e explique o motivo.' });
  if (r.naoEncontrada) return res.status(404).json({ erro: 'Item não encontrado (pode já ter sido removido).' });
  if (!r.ok) return res.status(500).json({ erro: 'Não foi possível remover o item.' });
  res.json({ expedicao: await decorarExpedicao(r.expedicao, await lerSnapshot()) });
});

/** Pesquisa por número do chamado (ACS ou TTB), pela task ou por um termo: o
 * Jira (título, descrição, comentários) e a nossa base (Demandas, Expedições)
 * numa lista só. Só leitura. Controle interno, como Expedições: só
 * Dimensa/Evertec (o resultado inclui tasks de outros times e projetos). */
app.get('/pesquisa', exigirSessaoPagina, exigirEquipePagina, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'pesquisa.html'));
});

app.get('/api/pesquisa', exigirSessaoApi, exigirEditorApi, async (req, res) => {
  const n = normalizarTermo(req.query.q);
  if (!n.ok) return res.status(400).json({ erro: n.erro });
  const [dem, exp] = await Promise.all([listarDemandas(), listarExpedicoes()]);
  const r = await pesquisar(n, {
    chamar: chamarJira,
    demandas: dem.ok ? dem.demandas : [],
    expedicoes: exp.ok ? exp.expedicoes : []
  });
  r.baseIndisponivel = !dem.ok || !exp.ok;
  if (r.jira.status !== 'ok') console.error('[pesquisa] Jira não respondeu:', r.jira.erro);
  delete r.jira.erro; // detalhe interno fica no log
  res.json(r);
});

/** Pesquisa ampla: a mensagem do cliente vira termos (tabela, procedure,
 * versão) e cada um é buscado no Jira. POST porque o texto é longo e não deve
 * ir para a URL (nem para o log de acesso). `termos`, quando vem, é a lista que a
 * pessoa ajustou na tela (removeu algum). */
app.post('/api/pesquisa/ampla', exigirSessaoApi, exigirEditorApi, async (req, res) => {
  const corpo = req.body || {};
  const texto = typeof corpo.texto === 'string' ? corpo.texto : '';
  if (texto.length > MAX_TEXTO) return res.status(400).json({ erro: `Use no máximo ${MAX_TEXTO} caracteres.` });
  const extraido = extrairTermos(texto);
  const termos = Array.isArray(corpo.termos)
    ? [...new Set(corpo.termos.map(limparTermo).filter(Boolean))].slice(0, MAX_TERMOS)
    : extraido.termos;
  if (!termos.length && !extraido.numeros.length) {
    return res.status(400).json({ erro: 'Não achei nomes técnicos na mensagem (tabela, procedure, versão, número do chamado). Cole a mensagem do cliente inteira ou use a pesquisa exata.' });
  }
  const [dem, exp] = await Promise.all([listarDemandas(), listarExpedicoes()]);
  const r = await pesquisarAmplo({ termos, numeros: extraido.numeros }, {
    chamar: chamarJira,
    demandas: dem.ok ? dem.demandas : [],
    expedicoes: exp.ok ? exp.expedicoes : []
  });
  r.numeros = extraido.numeros;
  r.baseIndisponivel = !dem.ok || !exp.ok;
  if (r.jira.status !== 'ok') console.error('[pesquisa ampla] Jira:', r.jira.status, r.jira.erro);
  delete r.jira.erro;
  for (const e of r.exatas) delete e.jira.erro;
  res.json(r);
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
  await registrarAcesso(resultado.email, 'confirmado-manualmente');
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
