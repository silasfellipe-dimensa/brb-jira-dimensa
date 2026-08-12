const { createClient } = require('@supabase/supabase-js');

// Dois clientes, de proposito:
//
// - authClient usa a chave publica (anon/publishable). Serve so para
//   cadastro e login, que sao endpoints de autenticacao - nao dao acesso
//   a dado nenhum por si so.
//
// - dbClient usa a service_role, que ignora RLS. E a unica forma de tocar
//   na tabela snapshot, que agora nega tudo para a chave publica. Essa
//   chave NUNCA pode ir para o navegador nem para o repositorio.
const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Criado sob demanda, nao na importacao: se a chave ainda nao estiver
// configurada, so as rotas de dados falham (com mensagem clara), em vez
// de derrubar a aplicacao inteira - inclusive a tela de login.
let _dbClient = null;
function db() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY não configurada no ambiente.');
  }
  if (!_dbClient) {
    _dbClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
  }
  return _dbClient;
}

/** Cria a conta no Supabase. Ele mesmo dispara o e-mail de confirmacao. */
async function cadastrar(email, senha) {
  const { data, error } = await authClient.auth.signUp({ email, password: senha });
  if (error) {
    console.error('[supabase] falha no cadastro:', error.message || error);
    throw new Error(traduzErro(error));
  }
  return data;
}

/** Confirma email+senha. Falha se a conta ainda nao foi confirmada por email. */
async function entrar(email, senha) {
  const { data, error } = await authClient.auth.signInWithPassword({ email, password: senha });
  if (error) {
    console.error('[supabase] falha no login:', error.message || error);
    throw new Error(traduzErro(error));
  }
  return data.user;
}

function traduzErro(error) {
  const msg = error.message || '';
  if (msg.includes('Email not confirmed')) {
    return 'Você ainda não confirmou seu cadastro. Verifique o link enviado por e-mail.';
  }
  if (msg.includes('Invalid login credentials')) {
    return 'E-mail ou senha incorretos.';
  }
  if (msg.includes('Password should be at least')) {
    return 'A senha precisa ter pelo menos 6 caracteres.';
  }
  // "User already registered" cai de proposito na mensagem generica abaixo:
  // dizer que a conta existe deixaria qualquer um descobrir quais e-mails
  // estao cadastrados so tentando cadastrar de novo.
  return 'Não foi possível concluir sua solicitação. Tente novamente em instantes.';
}

/** Le o snapshot mais recente gravado na tabela public.snapshot. */
async function lerSnapshot() {
  try {
    const { data, error } = await db().from('snapshot').select('dados').eq('id', 1).single();
    if (error) throw new Error(error.message);
    return data.dados;
  } catch (erro) {
    console.error('[supabase] falha ao ler snapshot:', erro.message);
    return { vazio: true, erro: 'Não foi possível ler os dados agora.', colunas: [], pessoas: {} };
  }
}

/** Sobrescreve a unica linha da tabela public.snapshot com o board novo. */
async function gravarSnapshot(dados) {
  const { error } = await db()
    .from('snapshot')
    .update({ dados, atualizado_em: new Date().toISOString() })
    .eq('id', 1);
  if (error) throw new Error('Falha ao gravar snapshot: ' + error.message);
}

module.exports = { cadastrar, entrar, lerSnapshot, gravarSnapshot };
