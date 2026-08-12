require('dotenv').config({ path: '.env.local' });

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const { buscarBoard } = require('./jira');
const { cadastrar, entrar, lerSnapshot, gravarSnapshot } = require('./supabase');
const {
  COOKIE_NAME,
  SESSAO_DIAS,
  emailPermitido,
  segredoConfere,
  criarSessao,
  exigirSessaoPagina,
  exigirSessaoApi,
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
    "style-src 'self' 'unsafe-inline'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "connect-src 'self'; " +
    "frame-ancestors 'none'; " +
    "base-uri 'none'; " +
    "form-action 'self'"
  );
  // Sem dados do board em cache de proxy/navegador compartilhado.
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

async function executarAtualizacao(usuario) {
  const dados = await buscarBoard();
  await gravarSnapshot(dados);
  console.log(`[${new Date().toLocaleTimeString('pt-BR')}] Board atualizado por ${usuario}. Sprint: ${dados.sprint}`);
  return dados;
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

app.get('/api/cron-atualizar', async (req, res) => {
  const auth = req.headers.authorization || '';
  if (!segredoConfere(auth, `Bearer ${process.env.CRON_SECRET}`)) {
    return res.status(401).json({ erro: 'Não autorizado.' });
  }

  try {
    const dados = await executarAtualizacao('cron diário');
    res.json({ ok: true, sprint: dados.sprint });
  } catch (erro) {
    console.error('Falha na atualização automática (cron):', erro.message);
    res.status(500).json({ erro: erro.message });
  }
});

// ---- paginas e API protegidas por sessao de usuario ----

app.get('/', exigirSessaoPagina, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/api/eu', exigirSessaoApi, (req, res) => {
  res.json(req.usuario);
});

app.get('/api/dados', exigirSessaoApi, async (req, res) => {
  res.json(await lerSnapshot());
});

app.post('/api/atualizar', exigirSessaoApi, async (req, res) => {
  try {
    const dados = await executarAtualizacao(req.usuario.email);
    res.json(dados);
  } catch (erro) {
    console.error('Falha ao atualizar:', erro.message);
    res.status(500).json({ erro: erro.message });
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
