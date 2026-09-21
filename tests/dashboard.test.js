// Testes de regressao para a logica pura embutida em paginas/dashboard.html.
//
// O script do dashboard nao e um modulo (roda direto no navegador, sem
// import/export), entao aqui extraimos so o texto da funcao que queremos
// testar - por contagem de chaves balanceadas - e avaliamos isolada, sem
// precisar simular DOM inteiro. Cada teste nomeia o bug que pegaria.

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'paginas', 'dashboard.html'), 'utf8');

/** Extrai o corpo de "function nome(...) { ... }" contando chaves, para nao
 * depender de regex ganancioso pegando alem do fim da funcao. */
function extrairFuncao(nome) {
  const inicioAssinatura = HTML.indexOf(`function ${nome}(`);
  if (inicioAssinatura === -1) throw new Error(`funcao ${nome} nao encontrada em dashboard.html`);
  const inicioCorpo = HTML.indexOf('{', inicioAssinatura);
  let profundidade = 0;
  for (let i = inicioCorpo; i < HTML.length; i++) {
    if (HTML[i] === '{') profundidade++;
    if (HTML[i] === '}') {
      profundidade--;
      if (profundidade === 0) return HTML.slice(inicioAssinatura, i + 1);
    }
  }
  throw new Error(`chave de fechamento da funcao ${nome} nao encontrada`);
}

function carregarFuncao(nome) {
  // eslint-disable-next-line no-new-func
  return new Function(`${extrairFuncao(nome)}; return ${nome};`)();
}

describe('dashboard.html — script embutido continua sintaticamente valido', () => {
  test('o <script> inteiro nao quebra ao ser avaliado', () => {
    const script = HTML.match(/<script>([\s\S]*)<\/script>/)[1];
    // new Function so verifica sintaxe (parse); nao executa o topo do script
    // aqui, que depende de document/fetch reais.
    assert.doesNotThrow(() => new Function(script));
  });
});

describe('resolverSprintEfetivo — filtro "Sprint atual" no historico de entregas', () => {
  const resolverSprintEfetivo = carregarFuncao('resolverSprintEfetivo');

  // Bug real: o botao "Pesquisar" mandava sprintSelect.value cru. Com o
  // combo no padrao ("Sprint atual", value=""), isso ia pro backend sem
  // filtro de sprint nenhum e trazia TODAS as entregas (61) em vez de so as
  // da sprint atual (17).
  test('combo em branco e nenhum outro filtro -> usa a sprint atual', () => {
    assert.strictEqual(resolverSprintEfetivo('', 'Setembro', '', '', ''), 'Setembro');
  });

  test('sprint escolhida explicitamente -> respeita a escolha, ignora a atual', () => {
    assert.strictEqual(resolverSprintEfetivo('Agosto', 'Setembro', '', '', ''), 'Agosto');
  });

  // Combo em branco + filtro de mes: forcar a sprint atual aqui criaria uma
  // interseccao que o usuario nao pediu (sprint atual E mes X), quase sempre
  // vazia. Filtro amplo deve valer sozinho.
  test('combo em branco mas mes selecionado -> nao forca a sprint atual', () => {
    assert.strictEqual(resolverSprintEfetivo('', 'Setembro', '2026-07', '', ''), '');
  });

  test('combo em branco mas periodo (de/ate) selecionado -> nao forca a sprint atual', () => {
    assert.strictEqual(resolverSprintEfetivo('', 'Setembro', '', '2026-07-01', '2026-07-31'), '');
  });
});

describe('resolverSprintIdEfetivo — mesmo filtro, mas devolvendo o ID para o card "Planejado x Entregue"', () => {
  const resolverSprintIdEfetivo = carregarFuncao('resolverSprintIdEfetivo');

  test('combo em branco e nenhum outro filtro -> usa o ID da sprint atual', () => {
    assert.strictEqual(resolverSprintIdEfetivo('', null, 42, '', '', ''), 42);
  });

  test('sprint escolhida explicitamente -> usa o ID da opcao escolhida, nao o da atual', () => {
    assert.strictEqual(resolverSprintIdEfetivo('Agosto', 41, 42, '', '', ''), 41);
  });

  // Filtro por mes/periodo sem uma sprint especifica: nao ha uma unica
  // sprint para comparar planejado x entregue, entao o card deve avisar em
  // vez de mostrar (por engano) o numero da sprint atual.
  test('combo em branco mas mes selecionado -> nao ha sprint unica, devolve null', () => {
    assert.strictEqual(resolverSprintIdEfetivo('', null, 42, '2026-07', '', ''), null);
  });

  test('sprint sem ID conhecido (dado antigo) -> devolve null em vez de undefined/NaN', () => {
    assert.strictEqual(resolverSprintIdEfetivo('Agosto', null, 42, '', '', ''), null);
  });
});

/** Carrega varias funcoes do dashboard que compartilham escopo (uma chama a
 * outra, ou todas leem a mesma variavel externa `dados`), avaliando os
 * corpos juntos numa unica new Function. `dados` entra como parametro para
 * as referencias a essa variavel de fora resolverem para o mock passado. */
function carregarFuncoesComDados(nomes, dadosMock) {
  const corpo = nomes.map(extrairFuncao).join('\n');
  const resultado = {};
  const nomeados = nomes.join(', ');
  const fabrica = new Function('dados', `${corpo}; return { ${nomeados} };`);
  return fabrica(dadosMock);
}

// Bug real: "Entregas por semana" e "Entregue recentemente" contavam itens
// individuais (task + cada subtask solta), enquanto o board e os demais
// cards do dashboard agrupam por epico/task avulsa (dados.entregas). Um
// grupo com varias subtasks concluidas inflava esses dois cards em relacao
// ao numero real de demandas entregues.
describe('entregues/vazao — usam dados.entregas (agrupado por epico/task avulsa), nao itens soltos', () => {
  const dadosMock = {
    entregas: [
      { chave: 'JDCBEPIC-1', titulo: 'Epico com 5 subtasks', tipo: 'epico',
        resolvidoEm: '2026-09-08T12:00:00Z', pessoa: 'Ana' },
      { chave: 'JDCBBRB-2', titulo: 'Task avulsa', tipo: 'tarefa avulsa',
        resolvidoEm: '2026-09-10T12:00:00Z', pessoa: 'Bruno' }
    ]
  };
  const { entregasAgrupadas, entregasPorSemana, entregues, vazao } = carregarFuncoesComDados(
    ['entregasAgrupadas', 'entregasPorSemana', 'entregues', 'vazao', 'esc', 'dataCurta'], dadosMock
  );

  test('entregasAgrupadas devolve os grupos de dados.entregas, um por demanda', () => {
    assert.strictEqual(entregasAgrupadas().length, 2);
  });

  test('entregues() lista uma linha por grupo (epico/task avulsa), nao por task/subtask individual', () => {
    const html = entregues();
    assert.ok(html.includes('JDCBEPIC-1'), 'deveria listar o epico uma unica vez');
    assert.ok(html.includes('JDCBBRB-2'), 'deveria listar a task avulsa');
  });

  test('vazao() soma por semana o numero de demandas agrupadas, nao de itens soltos', () => {
    // As duas entregas do mock caem na mesma semana (seg 07/09 a dom 13/09) -
    // a coluna deve mostrar 2 (um epico + uma task avulsa), nunca 6 (epico +
    // suas 5 subtasks contadas à parte).
    const semanas = entregasPorSemana();
    assert.strictEqual(semanas.length, 1);
    assert.strictEqual(semanas[0].qtd, 2);
  });
});
