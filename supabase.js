const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

/** Cria a conta no Supabase. Ele mesmo dispara o e-mail de confirmacao. */
async function cadastrar(email, senha) {
  const { data, error } = await supabase.auth.signUp({ email, password: senha });
  if (error) {
    console.error('[supabase] falha no cadastro:', error.message || error);
    throw new Error(traduzErro(error));
  }
  return data;
}

/** Confirma email+senha. Falha se a conta ainda nao foi confirmada por email. */
async function entrar(email, senha) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: senha });
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
  if (msg.includes('User already registered')) {
    return 'Já existe uma conta com esse e-mail. Tente entrar em vez de cadastrar.';
  }
  if (msg.includes('Password should be at least')) {
    return 'A senha precisa ter pelo menos 6 caracteres.';
  }
  // Qualquer coisa nao reconhecida (erro de rede, timeout, etc.) cai numa
  // mensagem generica - o detalhe real ja foi pro log do servidor, nunca
  // pro navegador de quem esta tentando entrar.
  return 'Não foi possível concluir sua solicitação. Tente novamente em instantes.';
}

module.exports = { cadastrar, entrar };
