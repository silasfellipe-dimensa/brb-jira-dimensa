const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const SESSION_SECRET = process.env.SESSION_SECRET;

/** Comparacao de string em tempo constante, para o segredo do cron.
 * Um "===" comum vaza, pelo tempo de resposta, quantos caracteres iniciais
 * o atacante acertou - o que permite descobrir o segredo por tentativa. */
function segredoConfere(recebido, esperado) {
  if (!recebido || !esperado) return false;
  const a = Buffer.from(String(recebido));
  const b = Buffer.from(String(esperado));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
const COOKIE_NAME = 'sessao';
const SESSAO_DIAS = 7;

const dominiosPermitidos = (process.env.ALLOWED_DOMAINS || '')
  .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

const emailsPermitidos = (process.env.ALLOWED_EMAILS || '')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

// Por e-mail exato, nunca por dominio - dominio inteiro deixaria qualquer
// colega de @dimensa.com.br ou @evertecinc.com.br entrar no admin, nao so
// quem esta nesta lista.
const emailsAdmin = (process.env.ADMIN_EMAILS || '')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

/** Confere se o e-mail pode acessar. Chamada tanto no cadastro quanto no
 * login, de proposito - ninguem entra so por ter passado no cadastro. */
function emailPermitido(email) {
  const e = email.toLowerCase();
  if (emailsPermitidos.includes(e)) return true;
  const dominio = e.split('@')[1] || '';
  return dominiosPermitidos.includes(dominio);
}

function souAdmin(email) {
  return !!email && emailsAdmin.includes(String(email).toLowerCase());
}

// Quem edita a tela de Demandas e Pontos de Função: só quem é da equipe, ou
// seja, dos domínios abaixo. Quem entra por outro domínio liberado (BRB,
// TOTVS) só visualiza - não edita, não inclui, não remove. É por domínio, e
// só por domínio, de propósito: nem ADMIN_EMAILS nem uma lista de e-mails
// abre exceção, para "BRB só visualiza" valer sempre, sem depender de
// ninguém ter configurado a lista certa.
const dominiosEditores = (process.env.EDITOR_DOMAINS || 'dimensa.com.br,evertecinc.com.br')
  .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

function souEditor(email) {
  // Compara o domínio INTEIRO (nunca "termina com"): "x@dimensa.com.br.invasor.com"
  // e "x@naodimensa.com.br" não podem passar.
  const partes = String(email || '').trim().toLowerCase().split('@');
  return partes.length === 2 && partes[0] !== '' && dominiosEditores.includes(partes[1]);
}

function criarSessao(usuario) {
  return jwt.sign(usuario, SESSION_SECRET, { expiresIn: `${SESSAO_DIAS}d` });
}

function lerSessao(token) {
  try {
    return jwt.verify(token, SESSION_SECRET);
  } catch (e) {
    return null;
  }
}

/** Middleware: bloqueia paginas HTML sem sessao valida, mandando pro /login. */
function exigirSessaoPagina(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  const usuario = token && lerSessao(token);
  if (!usuario) return res.redirect('/login.html');
  req.usuario = usuario;
  next();
}

/** Middleware: bloqueia chamadas de API sem sessao valida, com 401 json. */
function exigirSessaoApi(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  const usuario = token && lerSessao(token);
  if (!usuario) return res.status(401).json({ erro: 'Sessão expirada ou inexistente. Faça login novamente.' });
  req.usuario = usuario;
  next();
}

/** Middlewares de admin: sempre APOS exigirSessaoPagina/exigirSessaoApi na
 * cadeia de rotas, entao req.usuario ja existe aqui. 403, nao 404 - esconder
 * a rota so atrasa quem tenta, e loga errado como "nao encontrado" em vez de
 * "sem permissao" quando alguem investigar depois. */
function exigirAdminPagina(req, res, next) {
  if (!souAdmin(req.usuario && req.usuario.email)) {
    return res.status(403).send('Sua conta não tem acesso a esta página.');
  }
  next();
}

function exigirAdminApi(req, res, next) {
  if (!souAdmin(req.usuario && req.usuario.email)) {
    return res.status(403).json({ erro: 'Sua conta não tem acesso a este recurso.' });
  }
  next();
}

/** A página de edição não é esconder, é encaminhar: quem não edita vai para a
 * visualização (que mostra o mesmo dado), em vez de dar de cara com um erro. */
function exigirEditorPagina(req, res, next) {
  if (!souEditor(req.usuario && req.usuario.email)) return res.redirect('/demandas');
  next();
}

/** Telas só da equipe (Dimensa/Evertec): quem não é da equipe nem as vê, então
 * volta para o board em vez de cair numa tela de erro. */
function exigirEquipePagina(req, res, next) {
  if (!souEditor(req.usuario && req.usuario.email)) return res.redirect('/');
  next();
}

function exigirEditorApi(req, res, next) {
  if (!souEditor(req.usuario && req.usuario.email)) {
    return res.status(403).json({ erro: 'Somente a equipe pode editar esta tela.' });
  }
  next();
}

/** Limite de tentativas por IP, para nao deixar a senha ser adivinhada
 * por forca bruta. Em memoria: numa funcao serverless cada instancia tem
 * a sua contagem, entao isso atrasa um ataque, nao o impede por completo.
 * Barreira definitiva seria um contador compartilhado (ex: no Supabase). */
const tentativas = new Map();
const JANELA_MS = 15 * 60 * 1000;
const MAX_TENTATIVAS = 10;

function limitarTentativas(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'desconhecido';
  const agora = Date.now();

  const registro = tentativas.get(ip);
  if (registro && agora - registro.desde < JANELA_MS) {
    if (registro.contagem >= MAX_TENTATIVAS) {
      console.warn(`Excesso de tentativas de ${ip} - bloqueado temporariamente.`);
      return res.status(429).json({ erro: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' });
    }
    registro.contagem++;
  } else {
    tentativas.set(ip, { contagem: 1, desde: agora });
  }

  // Limpeza preguicosa, para o Map nao crescer sem limite.
  if (tentativas.size > 5000) {
    for (const [chave, valor] of tentativas) {
      if (agora - valor.desde > JANELA_MS) tentativas.delete(chave);
    }
  }

  next();
}

module.exports = {
  COOKIE_NAME,
  SESSAO_DIAS,
  emailPermitido,
  segredoConfere,
  criarSessao,
  lerSessao,
  exigirSessaoPagina,
  exigirSessaoApi,
  souAdmin,
  souEditor,
  exigirAdminPagina,
  exigirAdminApi,
  exigirEditorApi,
  exigirEditorPagina,
  exigirEquipePagina,
  limitarTentativas
};
