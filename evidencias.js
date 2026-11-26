// Evidências de teste: regras puras (sem banco, sem rede), para testar.
//
// O navegador lê o .mhtml do Zephyr (static/leitor-zephyr.js) e manda o
// relatório já em JSON. O servidor NÃO confia nesse JSON: refaz a estrutura
// campo a campo, só com texto, com teto de tamanho, e recalcula o resultado
// geral. As imagens sobem depois, uma por pedido, e só entram se a ref existir
// no relatório gravado e os bytes forem mesmo PNG/JPEG/GIF/WebP.

const { codigoStatus, resultadoGeral, acsDoTitulo } = require('./static/leitor-zephyr');

const MAX_CASOS = 300;
const MAX_PASSOS = 100;
const MAX_LINHAS_SCRIPT = 400;
const MAX_IMAGENS = 400;
const MAX_TEXTO_CURTO = 300;
const MAX_TEXTO = 20000;
const MAX_OBSERVACOES = 8000;
const MAX_BYTES_IMAGEM = 4 * 1024 * 1024; // abaixo do teto de 4,5 MB do corpo na Vercel

const RE_CICLO = /^[A-Z][A-Z0-9_]{1,30}-R\d{1,7}$/;
const RE_CASO = /^[A-Z][A-Z0-9_]{1,30}-T\d{1,7}$/;
const RE_ISSUE = /^[A-Z][A-Z0-9_]{1,30}-\d{1,7}$/;
const RE_REF = /^img\d{1,4}$/;
const RE_DATA = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
const STATUS = ['sucesso', 'falha', 'bloqueado', 'andamento', 'nao_executado', 'concluido', 'outro', ''];

function txt(v, max) {
  if (typeof v !== 'string') return '';
  // sem caractere de controle (fora quebra de linha e tab)
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}
function lista(v, max) { return Array.isArray(v) ? v.slice(0, max) : []; }
function chavesValidas(v, re) {
  return lista(v, 50).filter((k) => typeof k === 'string' && re.test(k));
}
function data(v) { return typeof v === 'string' && RE_DATA.test(v) ? v : ''; }
function status(v) { return STATUS.includes(v) ? v : 'outro'; }

/** ACS: 11 dígitos (ex.: 20260630006) ou vazio. */
function normalizarAcs(v) {
  const s = String(v == null ? '' : v).replace(/\D/g, '');
  return s.length === 11 ? s : '';
}

function normalizarJira(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  return RE_ISSUE.test(s) ? s : '';
}

function normalizarPasso(p, i, refs) {
  const passo = {
    numero: Number.isInteger(p && p.numero) && p.numero > 0 && p.numero < 10000 ? p.numero : i + 1,
    status: status(p && p.status),
    statusNome: txt(p && p.statusNome, 60),
    script: lista(p && p.script, MAX_LINHAS_SCRIPT).map((l) => txt(l, 2000)),
    campos: lista(p && p.campos, 20).map((c) => ({ rotulo: txt(c && c.rotulo, 80), texto: txt(c && c.texto, MAX_TEXTO) }))
      .filter((c) => c.rotulo && c.texto),
    resultado: txt(p && p.resultado, MAX_TEXTO),
    imagens: [],
    issues: chavesValidas(p && p.issues, RE_ISSUE)
  };
  lista(p && p.imagens, 50).forEach((im) => {
    const ref = im && im.ref;
    if (typeof ref === 'string' && RE_REF.test(ref) && !refs.has(ref) && refs.size < MAX_IMAGENS) {
      refs.add(ref);
      passo.imagens.push({ ref, legenda: txt(im.legenda, 200) });
    }
  });
  return passo;
}

function normalizarCaso(c, refs) {
  if (!c || typeof c.chave !== 'string' || !RE_CASO.test(c.chave)) return null;
  return {
    chave: c.chave,
    nome: txt(c.nome, 500),
    status: status(c.status),
    statusNome: txt(c.statusNome, 60),
    objetivo: txt(c.objetivo, MAX_TEXTO),
    precondicao: txt(c.precondicao, MAX_TEXTO),
    cobertura: chavesValidas(c.cobertura, RE_ISSUE),
    dataTermino: data(c.dataTermino),
    atribuidoA: txt(c.atribuidoA, 120),
    executadoPor: txt(c.executadoPor, 120),
    ambiente: txt(c.ambiente, 120),
    tipo: txt(c.tipo, 60),
    issues: chavesValidas(c.issues, RE_ISSUE),
    passos: lista(c.passos, MAX_PASSOS).map((p, i) => normalizarPasso(p, i, refs))
  };
}

/** Relatório vindo do navegador -> { ok, relatorio, refs } ou { ok:false, erro }. */
function normalizarRelatorio(r) {
  if (!r || typeof r !== 'object') return { ok: false, erro: 'Relatório ausente.' };
  const ciclo = r.ciclo || {};
  if (typeof ciclo.chave !== 'string' || !RE_CICLO.test(ciclo.chave)) {
    return { ok: false, erro: 'O relatório não tem a chave do ciclo de teste (ex.: JDCBBRB-R9).' };
  }
  const refs = new Set();
  const casos = lista(r.casos, MAX_CASOS).map((c) => normalizarCaso(c, refs)).filter(Boolean);
  if (!casos.length) return { ok: false, erro: 'O relatório não tem nenhum caso de teste.' };
  return {
    ok: true,
    refs,
    relatorio: {
      ciclo: {
        chave: ciclo.chave,
        nome: txt(ciclo.nome, 500),
        descricao: txt(ciclo.descricao, MAX_TEXTO),
        status: txt(ciclo.status, 60),
        inicioPlanejado: data(ciclo.inicioPlanejado),
        fimPlanejado: data(ciclo.fimPlanejado),
        versao: txt(ciclo.versao, 120),
        iteracao: txt(ciclo.iteracao, 120)
      },
      casos,
      avisos: lista(r.avisos, 50).map((a) => txt(a, 400)).filter(Boolean)
    }
  };
}

/** Campos que a pessoa digita (no cadastro e na edição). Só os que vierem. */
const CAMPOS_EDITAVEIS = {
  titulo: (v) => txt(v, MAX_TEXTO_CURTO),
  acs: (v) => (String(v == null ? '' : v).trim() === '' ? '' : normalizarAcs(v)),
  jira: (v) => (String(v == null ? '' : v).trim() === '' ? '' : normalizarJira(v)),
  ambiente: (v) => txt(v, 120),
  versao: (v) => txt(v, 120),
  observacoes: (v) => txt(v, MAX_OBSERVACOES)
};

function normalizarCampos(corpo, { exigirAlgum } = {}) {
  const registro = {};
  if (!corpo || typeof corpo !== 'object') return { ok: false, erro: 'Pedido inválido.' };
  for (const [campo, limpar] of Object.entries(CAMPOS_EDITAVEIS)) {
    if (corpo[campo] === undefined) continue;
    if (corpo[campo] !== null && typeof corpo[campo] !== 'string') return { ok: false, erro: `Campo ${campo} inválido.` };
    const v = limpar(corpo[campo]);
    if (campo === 'acs' && corpo.acs && String(corpo.acs).trim() && !v) return { ok: false, erro: 'O ACS tem 11 dígitos (ex.: 20260630006).' };
    if (campo === 'jira' && corpo.jira && String(corpo.jira).trim() && !v) return { ok: false, erro: 'A task do Jira tem o formato JDCBBRB-201.' };
    registro[campo] = v;
  }
  if (exigirAlgum && !Object.keys(registro).length) return { ok: false, erro: 'Nada para salvar.' };
  return { ok: true, registro };
}

/** Pedido de criação: campos + relatório. Preenche o que der a partir do relatório. */
function normalizarNovaEvidencia(corpo) {
  const c = normalizarCampos(corpo);
  if (!c.ok) return c;
  const r = normalizarRelatorio(corpo && corpo.relatorio);
  if (!r.ok) return r;
  const reg = c.registro;
  const rel = r.relatorio;
  if (!reg.titulo) reg.titulo = rel.ciclo.nome || rel.ciclo.chave;
  if (!reg.jira) {
    // a task coberta pelos casos (a mais citada), se o relatório tiver
    const conta = {};
    rel.casos.forEach((caso) => caso.cobertura.forEach((k) => { conta[k] = (conta[k] || 0) + 1; }));
    const maisCitada = Object.keys(conta).sort((a, b) => conta[b] - conta[a])[0];
    reg.jira = maisCitada || '';
  }
  return {
    ok: true,
    refs: r.refs,
    linha: {
      ...reg,
      acs: reg.acs || '',
      ambiente: reg.ambiente || '',
      versao: reg.versao || '',
      observacoes: reg.observacoes || '',
      ciclo_chave: rel.ciclo.chave,
      ciclo_nome: rel.ciclo.nome,
      resultado: resultadoGeral(rel.casos),
      total_casos: rel.casos.length,
      total_imagens: r.refs.size,
      arquivo_nome: txt(corpo.arquivoNome, 200),
      dados: rel
    }
  };
}

function idEvidencia(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 1e12 ? n : null;
}

function refImagem(v) {
  return typeof v === 'string' && RE_REF.test(v) ? v : null;
}

/** Tipo real pelos primeiros bytes - nunca pelo cabeçalho que o navegador mandou. */
function tipoDaImagem(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { tipo: 'image/png', ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { tipo: 'image/jpeg', ext: 'jpg' };
  if (buf.slice(0, 4).toString('latin1') === 'GIF8') return { tipo: 'image/gif', ext: 'gif' };
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { tipo: 'image/webp', ext: 'webp' };
  return null;
}

/** Linha do banco -> objeto da tela. `comDados` = inclui o relatório completo. */
function deLinhaEvidencia(l, comDados) {
  const e = {
    id: l.id,
    titulo: l.titulo || '',
    acs: l.acs || '',
    jira: l.jira || '',
    ambiente: l.ambiente || '',
    versao: l.versao || '',
    observacoes: l.observacoes || '',
    cicloChave: l.ciclo_chave || '',
    cicloNome: l.ciclo_nome || '',
    resultado: l.resultado || '',
    totalCasos: l.total_casos || 0,
    totalImagens: l.total_imagens || 0,
    arquivoNome: l.arquivo_nome || '',
    criadoPor: l.criado_por || '',
    criadoEm: l.criado_em || null,
    atualizadoPor: l.atualizado_por || '',
    atualizadoEm: l.atualizado_em || null
  };
  if (comDados) {
    e.dados = l.dados || null;
    e.imagensSalvas = Array.isArray(l.imagens_salvas) ? l.imagens_salvas : [];
  }
  return e;
}

/** Refs que o relatório gravado usa (para aceitar só essas no upload). */
function refsDoRelatorio(dados) {
  const refs = new Set();
  ((dados && dados.casos) || []).forEach((c) => (c.passos || []).forEach((p) => (p.imagens || []).forEach((im) => {
    if (im && RE_REF.test(im.ref || '')) refs.add(im.ref);
  })));
  return refs;
}

// ---------- Task do Jira (busca enquanto digita e o que vem dela) ----------

const PROJETO_JIRA = 'JDCBBRB';
const MAX_SUGESTOES = 10;

/** O que a pessoa digitou no campo da task -> o que buscar. Só letras, números,
 * _ . - e espaço (o termo vai dentro de JQL). "201" e "JDCBBRB-201" viram a
 * chave; o resto procura no título. null = curto demais para buscar. */
function termoBuscaTask(q) {
  const termo = String(q === undefined || q === null ? '' : q)
    .replace(/[^\p{L}\p{N}_.\- ]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (termo.length < 2) return null;
  const k = /^([A-Za-z][A-Za-z0-9_]*)-(\d{1,7})$/.exec(termo);
  if (k) return { termo, chave: k[1].toUpperCase() + '-' + Number(k[2]) };
  if (/^\d{1,7}$/.test(termo)) return { termo, chave: PROJETO_JIRA + '-' + Number(termo) };
  return { termo, chave: '' };
}

/** JQL do título. Só no projeto do BRB (a instância tem outros clientes). A
 * última palavra vai com * para achar enquanto ainda se digita ("simul" -> simular). */
function jqlBuscaTask(b) {
  const palavras = b.termo.split(' ').filter((p) => p.replace(/[_.\-]/g, ''));
  if (!palavras.length) return '';
  const texto = palavras.join(' ') + '*';
  return `project = ${PROJETO_JIRA} AND summary ~ "${texto}" ORDER BY updated DESC`;
}

/** Issue do Jira -> sugestão da lista. */
function deTaskJira(i) {
  const f = (i && i.fields) || {};
  const titulo = String(f.summary || '').trim();
  return { chave: i.key, titulo, tipo: (f.issuetype && f.issuetype.name) || '', acs: acsDoTitulo(titulo) };
}

/** Junta a chave exata (se existir) com as do título, sem repetir, as que têm
 * ACS primeiro (é a task que a evidência procura), no máximo MAX_SUGESTOES. */
function sugestoesTask(exata, achadas) {
  const vistas = new Set();
  const lista = [];
  [exata].concat(achadas || []).forEach((i) => {
    if (!i || !i.key || vistas.has(i.key)) return;
    vistas.add(i.key);
    lista.push(deTaskJira(i));
  });
  const ordem = lista.map((t, i) => ({ t, i, peso: (exata && t.chave === exata.key) ? 0 : t.acs ? 1 : 2 }));
  ordem.sort((a, b) => a.peso - b.peso || a.i - b.i);
  return ordem.slice(0, MAX_SUGESTOES).map((o) => o.t);
}

/** "Versões corrigidas" (fixVersions) de uma ou mais issues -> "DJSBRB_6.4.1.0, DJSCF_6.8.1.4".
 * No projeto a versão costuma estar nas filhas do Épico, não nele. */
function versoesDe(issues) {
  const nomes = [];
  (issues || []).forEach((i) => {
    const vs = (i && i.fields && i.fields.fixVersions) || [];
    vs.forEach((v) => {
      const n = String((v && v.name) || '').trim();
      if (n && nomes.indexOf(n) < 0) nomes.push(n);
    });
  });
  return nomes.join(', ').slice(0, 120);
}

module.exports = {
  MAX_BYTES_IMAGEM, PROJETO_JIRA, MAX_SUGESTOES,
  termoBuscaTask, jqlBuscaTask, deTaskJira, sugestoesTask, versoesDe,
  normalizarAcs, normalizarJira, normalizarRelatorio, normalizarCampos, normalizarNovaEvidencia,
  idEvidencia, refImagem, tipoDaImagem, deLinhaEvidencia, refsDoRelatorio,
  codigoStatus, resultadoGeral, acsDoTitulo
};
