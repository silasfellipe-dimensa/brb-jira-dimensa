const jwt = require('jsonwebtoken');

const SESSION_SECRET = process.env.SESSION_SECRET;
const COOKIE_NAME = 'sessao';
const SESSAO_DIAS = 7;

const dominiosPermitidos = (process.env.ALLOWED_DOMAINS || '')
  .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

const emailsPermitidos = (process.env.ALLOWED_EMAILS || '')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

/** Confere se o e-mail pode acessar. Chamada tanto no cadastro quanto no
 * login, de proposito - ninguem entra so por ter passado no cadastro. */
function emailPermitido(email) {
  const e = email.toLowerCase();
  if (emailsPermitidos.includes(e)) return true;
  const dominio = e.split('@')[1] || '';
  return dominiosPermitidos.includes(dominio);
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

module.exports = {
  COOKIE_NAME,
  SESSAO_DIAS,
  emailPermitido,
  criarSessao,
  lerSessao,
  exigirSessaoPagina,
  exigirSessaoApi
};
