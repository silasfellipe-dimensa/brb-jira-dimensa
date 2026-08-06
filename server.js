require('dotenv').config({ path: '.env.local' });

const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const { buscarBoard } = require('./jira');
const { cadastrar, entrar } = require('./supabase');
const {
  COOKIE_NAME,
  SESSAO_DIAS,
  emailPermitido,
  criarSessao,
  exigirSessaoPagina,
  exigirSessaoApi
} = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const DATA_DIR = path.join(__dirname, 'data');
const SNAPSHOT_PATH = path.join(DATA_DIR, 'snapshot.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function lerSnapshot() {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    return { vazio: true, erro: 'Ainda não foi feita nenhuma carga. Clique em "Atualizar agora".', colunas: [], pessoas: {} };
  }
  return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
}

function gravarSnapshot(dados) {
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(dados, null, 2));
}

app.use(express.json());
app.use(cookieParser());

// ---- login / cadastro (nao exige sessao) ----

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.post('/auth/cadastro', async (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ erro: 'Informe e-mail e senha.' });
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

app.post('/auth/entrar', async (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ erro: 'Informe e-mail e senha.' });
  }

  try {
    const usuarioSupabase = await entrar(email, senha);

    // 2a checagem de dominio: de novo, agora no login. Nao confia so no
    // que passou no cadastro - se por algum motivo existir uma conta no
    // Supabase com e-mail fora da lista, barra aqui mesmo assim.
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

// ---- paginas e API protegidas ----

app.get('/', exigirSessaoPagina, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/api/eu', exigirSessaoApi, (req, res) => {
  res.json(req.usuario);
});

app.get('/api/dados', exigirSessaoApi, (req, res) => {
  res.json(lerSnapshot());
});

app.post('/api/atualizar', exigirSessaoApi, async (req, res) => {
  try {
    const dados = await buscarBoard();
    gravarSnapshot(dados);
    console.log(`[${new Date().toLocaleTimeString('pt-BR')}] Board atualizado por ${req.usuario.email}. Sprint: ${dados.sprint}`);
    res.json(dados);
  } catch (erro) {
    console.error('Falha ao atualizar:', erro.message);
    res.status(500).json({ erro: erro.message });
  }
});

app.listen(PORT, () => {
  console.log(`Kanban BRB rodando em http://localhost:${PORT}`);
});
