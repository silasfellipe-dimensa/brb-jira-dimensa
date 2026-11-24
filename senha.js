// Link para a pessoa criar uma senha nova (botão "Link de senha" do /admin).
// Regras puras aqui, sem banco e sem rede, para serem testadas isoladamente.
//
// Por que existe: não há servidor de e-mail, então o "esqueci a senha" comum
// (link enviado por e-mail) não funciona. Quem gera o link é o admin, e ele o
// entrega à pessoa por um canal em que sabe com quem está falando (Teams).
// Quem tem o link define a senha - por isso ele é de um uso só, vence, e gerar
// um novo cancela o anterior.
//
// Como funciona:
//   - o admin gera: sorteamos um código (32 bytes) e guardamos só o HASH dele
//     e a validade nos metadados da conta no Supabase (app_metadata, que só o
//     servidor altera). Nenhuma tabela nova;
//   - o link leva o código no FRAGMENTO (#...), que o navegador não manda ao
//     servidor: não aparece em log de acesso;
//   - abrir o link só mostra o formulário. O código é gasto no envio da senha
//     nova - então a pré-visualização de link do Teams/Outlook não o consome.

const crypto = require('crypto');

const VALIDADE_HORAS = 24;
const CHAVE_META = 'redefinir_senha';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODIGO_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes em base64url

const hashDe = (codigo) => crypto.createHash('sha256').update(String(codigo)).digest('hex');

/** Id de usuário do Supabase (UUID) em minúsculas, ou null. */
function idUsuario(valor) {
  return typeof valor === 'string' && UUID_RE.test(valor) ? valor.toLowerCase() : null;
}

/** Código no formato que geramos, ou null (nem vai ao banco o que não tem a cara certa). */
function codigoValido(valor) {
  return typeof valor === 'string' && CODIGO_RE.test(valor) ? valor : null;
}

/** Pedido novo: `codigo` vai no link (só o admin vê, uma vez); `guardar` é o
 * que fica na conta. */
function novoPedido(agora = new Date()) {
  const codigo = crypto.randomBytes(32).toString('base64url');
  const expira = new Date(new Date(agora).getTime() + VALIDADE_HORAS * 60 * 60 * 1000).toISOString();
  return { codigo, guardar: { hash: hashDe(codigo), expira } };
}

/** O código apresentado vale para o que está guardado na conta?
 * { ok: true } ou { ok: false, motivo: 'sem-pedido' | 'vencido' | 'nao-confere' }. */
function conferirPedido(guardado, codigo, agora = new Date()) {
  if (!guardado || typeof guardado !== 'object' || typeof guardado.hash !== 'string' || typeof guardado.expira !== 'string') {
    return { ok: false, motivo: 'sem-pedido' };
  }
  const expira = new Date(guardado.expira).getTime();
  if (!Number.isFinite(expira) || new Date(agora).getTime() > expira) return { ok: false, motivo: 'vencido' };
  if (!codigoValido(codigo)) return { ok: false, motivo: 'nao-confere' };
  const a = Buffer.from(hashDe(codigo), 'hex');
  const b = Buffer.from(guardado.hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, motivo: 'nao-confere' };
  return { ok: true };
}

/** Caminho do link (o endereço do site quem põe é a tela do admin). */
function caminhoDoLink(userId, codigo) {
  return `/redefinir-senha.html#u=${userId}&c=${codigo}`;
}

module.exports = { VALIDADE_HORAS, CHAVE_META, idUsuario, codigoValido, novoPedido, conferirPedido, caminhoDoLink, hashDe };
