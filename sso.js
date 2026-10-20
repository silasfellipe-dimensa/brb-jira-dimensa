/* Login único entre Portal, Kanban e Qualidade - "passe" de uso único.
 *
 * ESTE ARQUIVO É IGUAL NOS TRÊS PROJETOS (brb-jira-dimensa, hub, qualidade).
 * Mudou aqui, copie para os outros dois - um teste em cada projeto confere.
 *
 * Por que passe e não cookie compartilhado: os três ficam em *.vercel.app, e
 * o navegador não deixa um subdomínio de vercel.app ler cookie de outro (é
 * sufixo público). Então quem já está logado num sistema e clica para outro
 * leva um passe na URL, e o destino cria a PRÓPRIA sessão, como num login.
 *
 * O passe é um JWT assinado com SSO_SECRET (o mesmo valor nos três, e
 * diferente do SESSION_SECRET de cada um):
 *   - aud: o sistema de destino - passe do Kanban não abre o Qualidade;
 *   - iss: quem emitiu (outro sistema da lista, nunca o próprio destino);
 *   - exp: 60 s - só o tempo do redirecionamento;
 *   - jti: id aleatório que o destino QUEIMA no banco ao usar (uso único),
 *     então copiar a URL do histórico do navegador não serve de nada.
 * O destino ainda confere a própria lista de acesso (ALLOWED_DOMAINS...) antes
 * de criar a sessão: o passe diz QUEM é, não que pode entrar.
 *
 * Sem SSO_SECRET (ou curto demais), está desligado: os links voltam a ser os
 * de antes e cada sistema pede login, como sempre foi. Falha fechada. */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const SISTEMAS = ['portal', 'kanban', 'qualidade'];
const VALIDADE_S = 60;

function segredo() {
  const s = process.env.SSO_SECRET || '';
  return s.length >= 32 ? s : null;
}

function ssoAtivo() {
  return !!segredo();
}

/** Passe para `email` entrar em `destino`, emitido por `origem`. */
function emitirPasse(email, destino, origem) {
  const s = segredo();
  if (!s || !SISTEMAS.includes(destino) || !SISTEMAS.includes(origem) || destino === origem) return null;
  return jwt.sign({ email: String(email).trim().toLowerCase() }, s, {
    algorithm: 'HS256', audience: destino, issuer: origem,
    expiresIn: VALIDADE_S, jwtid: crypto.randomUUID()
  });
}

/** Confere o passe para ESTE sistema. Devolve { email, jti, exp } ou null. */
function lerPasse(passe, eu) {
  const s = segredo();
  if (!s || typeof passe !== 'string' || passe.length > 2000) return null;
  try {
    const d = jwt.verify(passe, s, { algorithms: ['HS256'], audience: eu, maxAge: VALIDADE_S + 's' });
    if (!SISTEMAS.includes(d.iss) || d.iss === eu) return null;
    if (typeof d.email !== 'string' || !d.email.includes('@') || typeof d.jti !== 'string') return null;
    return { email: d.email, jti: d.jti, exp: d.exp };
  } catch (e) {
    return null;
  }
}

/** Só caminho DENTRO do próprio sistema ("/demandas"). Qualquer outra coisa -
 * endereço completo, "//outro.site", "/\\outro.site", vazio - vira "/". */
function caminhoSeguro(destino) {
  const p = typeof destino === 'string' ? destino : '';
  if (!p.startsWith('/') || p.startsWith('//') || p.startsWith('/\\') || p.length > 300) return '/';
  if (/[\u0000-\u001f\\]/.test(p)) return '/';
  return p;
}

/** Endereço do /sso do destino, com o passe e a página de chegada. */
function urlDeEntrada(base, passe, destino) {
  const u = new URL(String(base));
  u.pathname = u.pathname.replace(/\/+$/, '') + '/sso';
  u.search = '';
  u.hash = '';
  u.searchParams.set('passe', passe);
  const c = caminhoSeguro(destino);
  if (c !== '/') u.searchParams.set('destino', c);
  return u.href;
}

module.exports = { SISTEMAS, VALIDADE_S, ssoAtivo, emitirPasse, lerPasse, caminhoSeguro, urlDeEntrada };
