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
      .select('sprint_origem,sprint_origem_id,entregue,sprint_conclusao_id,conclusao_em')
      .eq('sprint_origem_id', sprintOrigemId).limit(10000);
    if (error) throw new Error(error.message);
    return resumirPlanejamento(data || [], sprintOrigemId);
  } catch (erro) {
    console.error('[supabase] falha ao ler planejamento da sprint:', erro.message);
    return null;
  }
}

/** Lista item a item (épico ou task avulsa) do "Planejado x Entregue" de UMA
 * sprint - o detalhe por trás dos 4 números do resumo. `dados` guarda o
 * objeto inteiro que `descreverGrupo` (jira.js) monta, então dá pra mostrar
 * chave, título, quantas subtarefas concluídas e quando saiu sem precisar
 * voltar no Jira. `situacao` replica exatamente o critério de
 * `resumirPlanejamento`, pra lista e resumo nunca contarem coisas diferentes. */
async function listarItensPlanejamento(sprintOrigemId) {
  try {
    const { data, error } = await db().from('planejamento_sprints')
      .select('chave,dados,entregue,sprint_conclusao_id')
      .eq('sprint_origem_id', sprintOrigemId).limit(10000);
    if (error) throw new Error(error.message);
    return classificarItensPlanejamento(data || [], sprintOrigemId);
  } catch (erro) {
    console.error('[supabase] falha ao listar itens do planejamento:', erro.message);
    return [];
  }
}

/** Pura: junta o objeto salvo em `dados` com a `situacao` calculada, mesmo
 * critério de resumirPlanejamento. Separada pra ser testável sem banco. */
function classificarItensPlanejamento(linhas, sprintOrigemId) {
  return linhas.map((linha) => ({
    ...linha.dados,
    situacao: !linha.entregue
      ? 'aberto'
      : (linha.sprint_conclusao_id === sprintOrigemId ? 'no-prazo' : 'atrasado')
  })).sort((a, b) => (a.titulo || '').localeCompare(b.titulo || ''));
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

/** Item a item do carry-over: o que a lista de `listarItensPlanejamento`
 * nao mostra, porque filtra por sprint de ORIGEM - um item nascido em
 * Agosto e entregue em Setembro nunca aparece no detalhe de Setembro sem
 * isto. Confirmado com dados reais (sessao 2026-09-21): so 3 dos 10 itens
 * entregues em Setembro nasceram em Setembro; os outros 7 sao carry-over. */
async function listarItensCarryOver(sprintConclusaoId) {
  try {
    const { data, error } = await db().from('planejamento_sprints')
      .select('dados,sprint_origem')
      .eq('sprint_conclusao_id', sprintConclusaoId).eq('entregue', true)
      .neq('sprint_origem_id', sprintConclusaoId).limit(10000);
    if (error) throw new Error(error.message);
    return montarItensCarryOver(data || []);
  } catch (erro) {
    console.error('[supabase] falha ao listar itens de carry-over:', erro.message);
    return [];
  }
}

/** Pura: mesma transformação de montarItensCarryOver, separada pra ser
 * testável sem banco. */
function montarItensCarryOver(linhas) {
  return linhas
    .map((linha) => ({ ...linha.dados, situacao: 'carry-over', sprintOrigemDoItem: linha.sprint_origem }))
    .sort((a, b) => (a.titulo || '').localeCompare(b.titulo || ''));
}

/** Serie historica: um resumo por sprint de origem, mais antiga primeiro -
 * para o grafico comparar varias sprints. */
async function listarPlanejamentoPorSprint() {
  try {
    const { data, error } = await db().from('planejamento_sprints')
      .select('sprint_origem,sprint_origem_id,entregue,sprint_conclusao_id')
      .not('sprint_origem_id', 'is', null).limit(10000);
    if (error) throw new Error(error.message);
    const todasLinhas = data || [];
    const porSprint = new Map();
    for (const linha of todasLinhas) {
      if (!porSprint.has(linha.sprint_origem_id)) porSprint.set(linha.sprint_origem_id, []);
      porSprint.get(linha.sprint_origem_id).push(linha);
    }
    const resultado = [];
    for (const [sprintOrigemId, linhas] of porSprint) {
      const resumo = resumirPlanejamento(linhas, sprintOrigemId);
      resumo.carryOverEntregue = contarCarryOverPorSprint(todasLinhas, sprintOrigemId);
      resultado.push(resumo);
    }
    return resultado;
  } catch (erro) {
    console.error('[supabase] falha ao listar planejamento por sprint:', erro.message);
    return [];
  }
}

/** Pura: quantos itens de OUTRAS sprints de origem foram entregues DURANTE
 * a sprint informada. Mesmo critério de lerCarryOverEntregue, só que aqui
 * roda sobre o dataset inteiro já carregado (a série histórica busca todas
 * as sprints de uma vez, não faz sentido repetir a query por sprint). Sem
 * isso, o total "entregue" da série contava só quem nasceu ali - e sumia
 * o que a sprint recebeu de atraso anterior (bug real da sessão 2026-09-21:
 * setembro parecia ter entregue 3, e entregou 10). */
function contarCarryOverPorSprint(todasLinhas, sprintConclusaoId) {
  return todasLinhas.filter((linha) =>
    linha.entregue && linha.sprint_conclusao_id === sprintConclusaoId && linha.sprint_origem_id !== sprintConclusaoId
  ).length;
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
    naoEntregue,
    porSemana: porSemanaPlanejamento(linhas, sprintOrigemId)
  };
}

/** Quebra semanal do que foi entregue dentro da sprint de origem, separando
 * no prazo de atrasado - complemento do "Planejado x Entregue" (que só olha
 * a sprint inteira) para responder "em que semana isso saiu", igual ao card
 * "Entregas por semana" já faz para o total do sprint. Mesmo corte de
 * semana (segunda a domingo) usado em toda a vazão, para os eixos baterem. */
function porSemanaPlanejamento(linhas, sprintOrigemId) {
  const porSemana = new Map();
  for (const linha of linhas) {
    if (!linha.entregue || !linha.conclusao_em) continue;
    const d = new Date(linha.conclusao_em);
    const seg = new Date(d);
    seg.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const chave = seg.toISOString().slice(0, 10);
    if (!porSemana.has(chave)) porSemana.set(chave, { semana: chave, noPrazo: 0, atrasado: 0 });
    const grupo = porSemana.get(chave);
    if (linha.sprint_conclusao_id === sprintOrigemId) grupo.noPrazo++;
    else grupo.atrasado++;
  }
  return Array.from(porSemana.values()).sort((a, b) => a.semana.localeCompare(b.semana));
}

/** Grava um evento de acesso (login ou cadastro). Best-effort: se a tabela
 * ainda não existe (script supabase-acessos.sql não rodou) ou o Supabase
 * falhar, loga e segue - login não pode depender disto pra funcionar. */
async function registrarAcesso(email, tipo) {
  try {
    const { error } = await db().from('acessos').insert({ email, tipo });
    if (error) throw new Error(error.message);
  } catch (erro) {
    console.error('[supabase] falha ao registrar acesso (login segue normal):', erro.message);
  }
}

/** Histórico de acessos, mais recente primeiro - o que a página /admin
 * lista. */
async function listarAcessos(limite) {
  try {
    const { data, error } = await db().from('acessos')
      .select('email,tipo,criado_em')
      .order('criado_em', { ascending: false })
      .limit(limite || 200);
    if (error) throw new Error(error.message);
    return data || [];
  } catch (erro) {
    console.error('[supabase] falha ao listar acessos:', erro.message);
    return [];
  }
}

/** Quem está cadastrado, direto do Supabase Auth - não precisa de tabela
 * própria, o Auth já guarda isso. `admin.listUsers` exige a service_role,
 * por isso usa db() (nunca o authClient de chave pública). */
async function listarUsuarios() {
  try {
    const { data, error } = await db().auth.admin.listUsers({ perPage: 1000 });
    if (error) throw new Error(error.message);
    return montarListaUsuarios(data.users || []);
  } catch (erro) {
    console.error('[supabase] falha ao listar usuários:', erro.message);
    return [];
  }
}

/** Confirma o e-mail de alguém sem depender do link (que pode nunca chegar -
 * ver sessão 2026-09-24: rate limit do Supabase, filtro corporativo, etc).
 * Só quem já é admin chega aqui (rota protegida por exigirAdminApi). */
async function confirmarUsuarioManualmente(userId) {
  try {
    const { data, error } = await db().auth.admin.updateUserById(userId, { email_confirm: true });
    if (error) throw new Error(error.message);
    return { ok: true, email: data.user.email };
  } catch (erro) {
    console.error('[supabase] falha ao confirmar usuário manualmente:', erro.message);
    return { ok: false, erro: erro.message };
  }
}

/** Pura: mapeia os campos do Supabase Auth e ordena por último acesso, mais
 * recente primeiro. Quem nunca entrou (só cadastrado, sem login) fica no
 * fim - sem essa checagem explícita, data nula viraria "maior" numa
 * comparação ingenua e pularia pro topo por acidente. */
function montarListaUsuarios(users) {
  return users
    .map((u) => ({
      id: u.id,
      email: u.email,
      criadoEm: u.created_at,
      ultimoLogin: u.last_sign_in_at || null,
      confirmado: !!u.email_confirmed_at
    }))
    .sort((a, b) => {
      if (!a.ultimoLogin && !b.ultimoLogin) return new Date(b.criadoEm) - new Date(a.criadoEm);
      if (!a.ultimoLogin) return 1;
      if (!b.ultimoLogin) return -1;
      return new Date(b.ultimoLogin) - new Date(a.ultimoLogin);
    });
}

module.exports = {
  cadastrar, entrar, lerSnapshot, gravarSnapshot, gravarHistorico, lerHistorico,
  gravarEntregas, lerEntregas, listarSprintsEntregas, listarMesesEntregas, limparEntregas,
  gravarPlanejamento, limparPlanejamento, lerPlanejamentoSprint, lerCarryOverEntregue,
  listarPlanejamentoPorSprint, resumirPlanejamento, porSemanaPlanejamento, listarItensPlanejamento,
  classificarItensPlanejamento, listarItensCarryOver, montarItensCarryOver, contarCarryOverPorSprint,
  registrarAcesso, listarAcessos, listarUsuarios, montarListaUsuarios, confirmarUsuarioManualmente
};
