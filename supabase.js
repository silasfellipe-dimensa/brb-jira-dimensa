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

/** Cria a conta no Supabase. Ele mesmo dispara o e-mail de confirmacao.
 *
 * O emailRedirectTo e passado explicitamente para o link do e-mail nao
 * depender do "Site URL" configurado no painel do Supabase - que e o que
 * fazia o link cair em localhost. A URL usada aqui precisa estar na lista
 * de Redirect URLs do projeto no Supabase. */
async function cadastrar(email, senha) {
  const destino = (process.env.APP_URL || '').replace(/\/$/, '');
  const opcoes = destino ? { emailRedirectTo: `${destino}/login.html?confirmado=1` } : undefined;

  const { data, error } = await authClient.auth.signUp({
    email,
    password: senha,
    options: opcoes
  });
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
  if (msg.includes('Password should be at least') || msg.includes('Password is known to be weak')) {
    return 'Essa senha é muito fraca ou curta. Escolha outra, com pelo menos 8 caracteres.';
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

/** Grava a foto do dia na tabela historico.
 *
 * Uma linha por dia, sobrescrita se o mesmo dia carregar de novo - a ultima
 * carga do dia e a que vale. E o que permite CFD, burndown e tendencia, que a
 * tabela `snapshot` (linha unica, sobrescrita) nunca poderia sustentar.
 *
 * Falha aqui NAO derruba a atualizacao do board: o historico e acessorio, o
 * snapshot e o que a tela precisa. Por isso o erro e registrado e engolido. */
async function gravarHistorico(resumo) {
  const dia = new Date().toISOString().slice(0, 10);
  try {
    const { error } = await db()
      .from('historico')
      .upsert({ dia, dados: resumo, gravado_em: new Date().toISOString() }, { onConflict: 'dia' });
    if (error) throw new Error(error.message);
    return true;
  } catch (erro) {
    console.error('[supabase] falha ao gravar historico (board segue normal):', erro.message);
    return false;
  }
}

/** Le os ultimos N dias de historico, do mais antigo para o mais novo. */
async function lerHistorico(limiteDias = 60) {
  try {
    const { data, error } = await db()
      .from('historico')
      .select('dia,dados')
      .order('dia', { ascending: false })
      .limit(limiteDias);
    if (error) throw new Error(error.message);
    return (data || []).reverse();
  } catch (erro) {
    console.error('[supabase] falha ao ler historico:', erro.message);
    return [];
  }
}

async function gravarEntregas(entregas) {
  if (!Array.isArray(entregas) || !entregas.length) return true;
  try {
    const unicas = new Map();
    for (const entrega of entregas) {
      const id = `${entrega.chave}:${entrega.sprintConclusaoId || entrega.sprintConclusao || 'sem-sprint'}`;
      unicas.set(id, { ...entrega, id });
    }
    const linhas = Array.from(unicas.values()).map((entrega) => ({
      id: entrega.id,
      chave: entrega.chave,
      conclusao_em: entrega.resolvidoEm || null,
      sprint_conclusao: entrega.sprintConclusao || null,
      sprint_conclusao_id: entrega.sprintConclusaoId || null,
      sprint_origem: entrega.sprintOrigem || null,
      sprint_origem_id: entrega.sprintOrigemId || null,
      dados: entrega,
      atualizado_em: new Date().toISOString()
    }));
    const { error } = await db().from('entregas').upsert(linhas, { onConflict: 'id' });
    if (error) throw new Error(error.message);
    return true;
  } catch (erro) {
    console.error('[supabase] falha ao gravar entregas (board segue normal):', erro.message);
    return false;
  }
}

async function lerEntregas({ sprint, mes, inicio, fim } = {}) {
  try {
    let consulta = db().from('entregas').select('dados,conclusao_em,sprint_conclusao,sprint_origem')
      .order('conclusao_em', { ascending: false }).limit(10000);
    if (sprint) consulta = consulta.eq('sprint_conclusao', sprint);
    if (inicio) consulta = consulta.gte('conclusao_em', inicio);
    if (fim) consulta = consulta.lt('conclusao_em', fim);
    const { data, error } = await consulta;
    if (error) throw new Error(error.message);
    let entregas = (data || []).map((linha) => linha.dados);
    if (mes) {
      entregas = entregas.filter((e) => e.resolvidoEm && e.resolvidoEm.slice(0, 7) === mes);
    }
    return entregas;
  } catch (erro) {
    console.error('[supabase] falha ao ler entregas:', erro.message);
    return [];
  }
}

async function listarSprintsEntregas() {
  try {
    const { data, error } = await db().from('entregas')
      .select('sprint_conclusao,sprint_conclusao_id,conclusao_em')
      .not('sprint_conclusao', 'is', null)
      .order('conclusao_em', { ascending: false }).limit(10000);
    if (error) throw new Error(error.message);
    const unicas = new Map();
    for (const linha of data || []) {
      if (!unicas.has(linha.sprint_conclusao)) {
        unicas.set(linha.sprint_conclusao, {
          nome: linha.sprint_conclusao,
          id: linha.sprint_conclusao_id,
          ultimaEntrega: linha.conclusao_em
        });
      }
    }
    return Array.from(unicas.values());
  } catch (erro) {
    console.error('[supabase] falha ao listar sprints de entregas:', erro.message);
    return [];
  }
}

async function listarMesesEntregas() {
  try {
    const { data, error } = await db().from('entregas')
      .select('conclusao_em').not('conclusao_em', 'is', null)
      .order('conclusao_em', { ascending: false }).limit(10000);
    if (error) throw new Error(error.message);
    return Array.from(new Set((data || []).map((linha) => linha.conclusao_em.slice(0, 7))));
  } catch (erro) {
    console.error('[supabase] falha ao listar meses de entregas:', erro.message);
    return [];
  }
}

async function limparEntregas() {
  try {
    // Delete "tudo" via um filtro sempre verdadeiro - a tabela nao tem uma
    // rota de "truncate" direta pelo client. Necessario ao trocar o modelo
    // de granularidade (de "por task" para "por epico/task avulsa"), senao
    // as linhas antigas ficam orfas (chave antiga nunca mais bate) e inflam
    // a contagem do histórico.
    const { error } = await db().from('entregas').delete().not('id', 'is', null);
    if (error) throw new Error(error.message);
    return true;
  } catch (erro) {
    console.error('[supabase] falha ao limpar entregas:', erro.message);
    return false;
  }
}

// Planejamento: uma linha por grupo (epico/task avulsa) e sprint de ORIGEM -
// entregue ou nao. Diferente de entregas, guarda tambem quem ainda esta em
// aberto, para o card "Planejado x Entregue" responder o que ficou pra tras.
async function gravarPlanejamento(planejamento) {
  if (!Array.isArray(planejamento) || !planejamento.length) return true;
  try {
    const unicas = new Map();
    for (const item of planejamento) {
      const id = `${item.chave}:${item.sprintOrigemId || item.sprintOrigem || 'sem-sprint'}`;
      unicas.set(id, { ...item, id });
    }
    const linhas = Array.from(unicas.values()).map((item) => ({
      id: item.id,
      chave: item.chave,
      tipo: item.tipo,
      sprint_origem: item.sprintOrigem || null,
      sprint_origem_id: item.sprintOrigemId || null,
      entregue: !!item.entregue,
      sprint_conclusao: item.sprintConclusao || null,
      sprint_conclusao_id: item.sprintConclusaoId || null,
      conclusao_em: item.resolvidoEm || null,
      total: item.total || 0,
      concluidas: item.concluidas || 0,
      dados: item,
      atualizado_em: new Date().toISOString()
    }));
    const { error } = await db().from('planejamento_sprints').upsert(linhas, { onConflict: 'id' });
    if (error) throw new Error(error.message);
    return true;
  } catch (erro) {
    console.error('[supabase] falha ao gravar planejamento (board segue normal):', erro.message);
    return false;
  }
}

async function limparPlanejamento() {
  try {
    const { error } = await db().from('planejamento_sprints').delete().not('id', 'is', null);
    if (error) throw new Error(error.message);
    return true;
  } catch (erro) {
    console.error('[supabase] falha ao limpar planejamento:', erro.message);
    return false;
  }
}

/** Numeros de "Planejado x Entregue" para UMA sprint (a de origem). */
async function lerPlanejamentoSprint(sprintOrigemId) {
  try {
    const { data, error } = await db().from('planejamento_sprints')
      .select('sprint_origem,sprint_origem_id,entregue,sprint_conclusao_id')
      .eq('sprint_origem_id', sprintOrigemId).limit(10000);
    if (error) throw new Error(error.message);
    return resumirPlanejamento(data || [], sprintOrigemId);
  } catch (erro) {
    console.error('[supabase] falha ao ler planejamento da sprint:', erro.message);
    return null;
  }
}

/** Quantos itens de OUTRAS sprints (carry-over) foram entregues DURANTE a
 * sprint informada - o contraponto do "planejado": nao so "o que era pra
 * sair, saiu", mas tambem "quanto do que saiu veio de atraso anterior". */
async function lerCarryOverEntregue(sprintConclusaoId) {
  try {
    const { data, error } = await db().from('planejamento_sprints')
      .select('sprint_origem_id', { count: 'exact', head: false })
      .eq('sprint_conclusao_id', sprintConclusaoId).eq('entregue', true)
      .neq('sprint_origem_id', sprintConclusaoId).limit(10000);
    if (error) throw new Error(error.message);
    return (data || []).length;
  } catch (erro) {
    console.error('[supabase] falha ao ler carry-over de entregas:', erro.message);
    return 0;
  }
}

/** Serie historica: um resumo por sprint de origem, mais antiga primeiro -
 * para o grafico comparar varias sprints. */
async function listarPlanejamentoPorSprint() {
  try {
    const { data, error } = await db().from('planejamento_sprints')
      .select('sprint_origem,sprint_origem_id,entregue,sprint_conclusao_id')
      .not('sprint_origem_id', 'is', null).limit(10000);
    if (error) throw new Error(error.message);
    const porSprint = new Map();
    for (const linha of data || []) {
      if (!porSprint.has(linha.sprint_origem_id)) porSprint.set(linha.sprint_origem_id, []);
      porSprint.get(linha.sprint_origem_id).push(linha);
    }
    const resultado = [];
    for (const [sprintOrigemId, linhas] of porSprint) {
      resultado.push(resumirPlanejamento(linhas, sprintOrigemId));
    }
    return resultado;
  } catch (erro) {
    console.error('[supabase] falha ao listar planejamento por sprint:', erro.message);
    return [];
  }
}

/** Reduz as linhas cruas de uma sprint de origem aos 4 numeros do card:
 * planejado, entregue no prazo (mesma sprint), entregue atrasado (sprint
 * de conclusao diferente da de origem) e ainda nao entregue. Pura, de
 * proposito - testavel sem tocar no banco. */
function resumirPlanejamento(linhas, sprintOrigemId) {
  const nome = linhas.length ? linhas[0].sprint_origem : null;
  let entregueNoPrazo = 0;
  let entregueAtrasado = 0;
  let naoEntregue = 0;
  for (const linha of linhas) {
    if (!linha.entregue) { naoEntregue++; continue; }
    if (linha.sprint_conclusao_id === sprintOrigemId) entregueNoPrazo++;
    else entregueAtrasado++;
  }
  return {
    sprintOrigemId,
    sprintOrigem: nome,
    planejado: linhas.length,
    entregueNoPrazo,
    entregueAtrasado,
    naoEntregue
  };
}

module.exports = {
  cadastrar, entrar, lerSnapshot, gravarSnapshot, gravarHistorico, lerHistorico,
  gravarEntregas, lerEntregas, listarSprintsEntregas, listarMesesEntregas, limparEntregas,
  gravarPlanejamento, limparPlanejamento, lerPlanejamentoSprint, lerCarryOverEntregue,
  listarPlanejamentoPorSprint, resumirPlanejamento
};
