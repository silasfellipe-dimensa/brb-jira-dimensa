// Testes de logica pura da tela Demandas e Pontos de Funcao - sem rede, sem banco.
// Cada teste nomeia o bug que pegaria.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { SITE } = require('../jira');
const {
  interpretarNumero, interpretarPontosTotal, interpretarData, interpretarTexto,
  normalizarCampos, urlJira, deLinha, idDemanda,
  interpretarMes, interpretarListaMeses, mesesDisponiveis, filtrarPorMeses, resumirMeses
} = require('../demandas');

describe('interpretarNumero — numero digitado em pt-BR', () => {
  // Bug: a planilha de origem usa virgula (10,4); aceitar so ponto faria
  // quase todo valor digitado ser recusado.
  test('aceita virgula e ponto como separador decimal', () => {
    assert.strictEqual(interpretarNumero('10,4').valor, 10.4);
    assert.strictEqual(interpretarNumero('10.4').valor, 10.4);
    assert.strictEqual(interpretarNumero('5').valor, 5);
    assert.strictEqual(interpretarNumero(0.5).valor, 0.5);
  });

  test('vazio vira null, nao zero', () => {
    assert.strictEqual(interpretarNumero('').valor, null);
    assert.strictEqual(interpretarNumero('   ').valor, null);
    assert.strictEqual(interpretarNumero(null).valor, null);
    assert.strictEqual(interpretarNumero(undefined).valor, null);
  });

  // Bug: "0" e "em branco" sao coisas diferentes na planilha - fase em
  // branco ainda nao foi paga, fase com 0 foi tratada e nao rendeu nada.
  test('zero continua sendo zero', () => {
    const r = interpretarNumero('0');
    assert.ok(r.ok);
    assert.strictEqual(r.valor, 0);
  });

  test('recusa texto, negativo, mais de 2 casas e valor absurdo', () => {
    ['abc', '-1', '1,234', '1.2.3', '1,', ',5', '10 PF'].forEach((t) => {
      assert.ok(!interpretarNumero(t).ok, `deveria recusar "${t}"`);
    });
    assert.ok(!interpretarNumero(-1).ok);
    assert.ok(!interpretarNumero(NaN).ok);
    assert.ok(!interpretarNumero(Infinity).ok);
    assert.ok(!interpretarNumero(100000).ok);
  });
});

describe('interpretarPontosTotal — numero ou "em analise"', () => {
  test('aceita "em análise" com variacoes de caixa, acento e espaco', () => {
    ['em análise', 'Em Analise', '  em   análise  ', 'EM ANÁLISE'].forEach((t) => {
      const r = interpretarPontosTotal(t);
      assert.ok(r.ok, t);
      assert.strictEqual(r.valor, null);
      assert.strictEqual(r.emAnalise, true);
    });
  });

  test('numero limpa a marca de em analise', () => {
    const r = interpretarPontosTotal('2,3');
    assert.strictEqual(r.valor, 2.3);
    assert.strictEqual(r.emAnalise, false);
  });

  test('vazio nao e "em analise"', () => {
    const r = interpretarPontosTotal('');
    assert.ok(r.ok);
    assert.strictEqual(r.valor, null);
    assert.strictEqual(r.emAnalise, false);
  });

  test('outro texto e recusado', () => {
    assert.ok(!interpretarPontosTotal('talvez').ok);
    assert.ok(!interpretarPontosTotal('em análise 3').ok);
  });
});

describe('interpretarData', () => {
  test('aceita AAAA-MM-DD valido e vazio', () => {
    assert.strictEqual(interpretarData('2026-10-08').valor, '2026-10-08');
    assert.strictEqual(interpretarData('').valor, null);
    assert.strictEqual(interpretarData(null).valor, null);
  });

  // Bug: new Date("2026-02-31") nao falha, vira 3 de marco - a data
  // errada seria gravada sem ninguem perceber.
  test('recusa data que nao existe no calendario', () => {
    assert.ok(!interpretarData('2026-02-31').ok);
    assert.ok(!interpretarData('2026-13-01').ok);
    assert.ok(!interpretarData('2025-02-29').ok);
    assert.ok(interpretarData('2028-02-29').ok);
  });

  test('recusa formato diferente e ano fora de faixa', () => {
    assert.ok(!interpretarData('08/10/2026').ok);
    assert.ok(!interpretarData('2026-1-8').ok);
    assert.ok(!interpretarData('1999-12-31').ok);
    assert.ok(!interpretarData('2101-01-01').ok);
  });
});

describe('interpretarTexto', () => {
  test('apara espacos e trata ausente como vazio', () => {
    assert.strictEqual(interpretarTexto('nome', '  Estornar contratos  ').valor, 'Estornar contratos');
    assert.strictEqual(interpretarTexto('nome', null).valor, '');
    assert.strictEqual(interpretarTexto('nome', undefined).valor, '');
  });

  test('recusa texto acima do limite do campo', () => {
    assert.ok(interpretarTexto('demandaAcs', 'x'.repeat(40)).ok);
    assert.ok(!interpretarTexto('demandaAcs', 'x'.repeat(41)).ok);
    assert.ok(!interpretarTexto('observacoes', 'x'.repeat(2001)).ok);
  });
});

describe('normalizarCampos — corpo do PATCH vira colunas do banco', () => {
  test('mapeia cada campo para a sua coluna', () => {
    const r = normalizarCampos({
      demandaAcs: ' 20260525005 ', artefatoJira: 'JDCBBRB-401', nome: 'Estornar Contratos',
      documentacao: '1,5', desenvolvimento: '2', teste: '0,5', implantacao: '0,2',
      inicioAtendimento: '2026-10-01', conclusaoPrevista: '2026-10-20', previsaoExpedicao: '2026-10-08',
      observacoes: 'Em expedição'
    });
    assert.ok(r.ok);
    assert.deepStrictEqual(r.registro, {
      demanda_acs: '20260525005', artefato_jira: 'JDCBBRB-401', nome: 'Estornar Contratos',
      pontos_documentacao: 1.5, pontos_desenvolvimento: 2, pontos_teste: 0.5, pontos_implantacao: 0.2,
      inicio_atendimento: '2026-10-01', conclusao_prevista: '2026-10-20', previsao_expedicao: '2026-10-08',
      observacoes: 'Em expedição'
    });
  });

  // Bug de seguranca que isto evita: mass assignment - quem edita nao pode
  // mandar id, removido, criado_por etc. e ver isso gravado.
  test('ignora campo fora da lista, nunca grava', () => {
    const r = normalizarCampos({ nome: 'ok', id: 99, removido: true, criado_por: 'x@y.com', atualizado_por: 'z' });
    assert.ok(r.ok);
    assert.deepStrictEqual(Object.keys(r.registro), ['nome']);
  });

  test('so campos desconhecidos nao e uma atualizacao valida', () => {
    assert.ok(!normalizarCampos({ removido: true }).ok);
    assert.ok(!normalizarCampos({}).ok);
  });

  test('pontos "em análise" zera o numero e marca a flag', () => {
    const r = normalizarCampos({ pontosTotal: 'em análise' });
    assert.deepStrictEqual(r.registro, { pontos_total: null, em_analise: true });
  });

  // Bug: digitar o numero depois de "em analise" e a flag continuar ligada,
  // mostrando "em analise" ao lado de um numero.
  test('pontos numerico desliga a flag de em análise', () => {
    const r = normalizarCampos({ pontosTotal: '10,4' });
    assert.deepStrictEqual(r.registro, { pontos_total: 10.4, em_analise: false });
  });

  test('apagar a celula grava null/vazio, nao ignora', () => {
    const r = normalizarCampos({ teste: '', previsaoExpedicao: '', nome: '' });
    assert.deepStrictEqual(r.registro, { pontos_teste: null, previsao_expedicao: null, nome: '' });
  });

  test('a mensagem de erro diz qual campo falhou', () => {
    const r = normalizarCampos({ teste: 'abc' });
    assert.ok(!r.ok);
    assert.match(r.erro, /^Teste:/);
    assert.match(normalizarCampos({ inicioAtendimento: '2026-02-31' }).erro, /^Início do Atendimento:/);
    assert.match(normalizarCampos({ pontosTotal: 'talvez' }).erro, /^Pontos de Função \(total\):/);
  });

  test('um campo invalido derruba a atualizacao inteira', () => {
    assert.ok(!normalizarCampos({ nome: 'ok', teste: 'abc' }).ok);
  });

  test('corpo ausente, nulo ou array e recusado sem quebrar', () => {
    assert.ok(!normalizarCampos(undefined).ok);
    assert.ok(!normalizarCampos(null).ok);
    assert.ok(!normalizarCampos([]).ok);
    assert.ok(!normalizarCampos('texto').ok);
  });
});

describe('urlJira — so vira link o que e do Jira da empresa', () => {
  test('chave vira URL do Jira, em maiuscula', () => {
    assert.strictEqual(urlJira('JDCBBRB-360'), `${SITE}/browse/JDCBBRB-360`);
    assert.strictEqual(urlJira(' jdcbbrb-360 '), `${SITE}/browse/JDCBBRB-360`);
  });

  test('URL completa do proprio Jira passa como esta', () => {
    const url = `${SITE}/browse/JDCBBRB-401`;
    assert.strictEqual(urlJira(url), url);
  });

  // Bug de seguranca: o valor e digitado pela equipe e exibido para todo
  // mundo logado - nao pode virar link para outro site nem "javascript:".
  test('recusa outro dominio, javascript: e texto solto', () => {
    assert.strictEqual(urlJira('https://site-malicioso.com/browse/X-1'), null);
    assert.strictEqual(urlJira('javascript:alert(1)'), null);
    assert.strictEqual(urlJira(`${SITE}.evil.com/browse/X-1`), null);
    assert.strictEqual(urlJira('sem chave'), null);
    assert.strictEqual(urlJira(''), null);
    assert.strictEqual(urlJira(null), null);
  });

  test('URL do Jira com espaco no meio e recusada', () => {
    assert.strictEqual(urlJira(`${SITE}/browse/A-1 onclick=x`), null);
  });
});

describe('deLinha — linha do banco para o formato da API', () => {
  test('mapeia colunas, converte numeric em numero e calcula o link', () => {
    const d = deLinha({
      id: 7, demanda_acs: '20260707010', artefato_jira: 'JDCBBRB-260', nome: 'AUTCAIXA',
      pontos_total: '2.30', em_analise: false, pontos_documentacao: null, pontos_desenvolvimento: null,
      pontos_teste: '0.50', pontos_implantacao: 0.2, inicio_atendimento: null,
      conclusao_prevista: null, previsao_expedicao: '2026-10-08', observacoes: 'Em expedição',
      atualizado_por: 'silas.fellipe@dimensa.com.br', atualizado_em: '2026-10-08T12:00:00Z'
    });
    assert.strictEqual(d.id, 7);
    assert.strictEqual(d.pontosTotal, 2.3);
    assert.strictEqual(d.teste, 0.5);
    assert.strictEqual(d.implantacao, 0.2);
    assert.strictEqual(d.documentacao, null);
    assert.strictEqual(d.previsaoExpedicao, '2026-10-08');
    assert.strictEqual(d.artefatoUrl, `${SITE}/browse/JDCBBRB-260`);
  });

  test('linha recem-criada (tudo vazio) nao quebra', () => {
    const d = deLinha({ id: 1 });
    assert.strictEqual(d.demandaAcs, '');
    assert.strictEqual(d.pontosTotal, null);
    assert.strictEqual(d.emAnalise, false);
    assert.strictEqual(d.artefatoUrl, null);
    assert.strictEqual(d.atualizadoPor, null);
  });

  test('zero vindo do banco continua sendo zero, nao null', () => {
    assert.strictEqual(deLinha({ id: 1, pontos_teste: 0 }).teste, 0);
    assert.strictEqual(deLinha({ id: 1, pontos_teste: '0.00' }).teste, 0);
  });
});

describe('idDemanda — :id da URL', () => {
  test('aceita inteiro positivo', () => {
    assert.strictEqual(idDemanda('12'), 12);
    assert.strictEqual(idDemanda(5), 5);
  });

  test('recusa zero, negativo, decimal, texto e numero gigante', () => {
    ['0', '-1', '1.5', 'abc', '', '12abc', '12345678901234'].forEach((v) => {
      assert.strictEqual(idDemanda(v), null, `deveria recusar "${v}"`);
    });
    assert.strictEqual(idDemanda(undefined), null);
  });
});

describe('interpretarMes — competência "AAAA-MM"', () => {
  test('aceita mês válido, aparando espaços', () => {
    assert.strictEqual(interpretarMes('2026-10').valor, '2026-10');
    assert.strictEqual(interpretarMes(' 2026-01 ').valor, '2026-01');
    assert.strictEqual(interpretarMes('2026-12').valor, '2026-12');
  });

  test('recusa mês inexistente, formato errado e ano fora de faixa', () => {
    ['2026-13', '2026-00', '26-10', '2026-1', '2026/10', '10/2026', '1999-12', '2101-01', '', 'outubro'].forEach((v) => {
      assert.ok(!interpretarMes(v).ok, `deveria recusar "${v}"`);
    });
    assert.ok(!interpretarMes(null).ok);
    assert.ok(!interpretarMes(undefined).ok);
    assert.ok(!interpretarMes(202610).ok);
  });
});

describe('interpretarListaMeses — ?meses=2026-09,2026-10', () => {
  test('devolve ordenado e sem repetir', () => {
    assert.deepStrictEqual(interpretarListaMeses('2026-10,2026-09,2026-10').valor, ['2026-09', '2026-10']);
    assert.deepStrictEqual(interpretarListaMeses(' 2026-10 , 2026-09 ').valor, ['2026-09', '2026-10']);
  });

  test('recusa vazio, ausente, item inválido e item vazio no meio', () => {
    ['', '   ', 'abc', '2026-10,abc', '2026-10,', ',2026-10', '2026-10,,2026-09'].forEach((v) => {
      assert.ok(!interpretarListaMeses(v).ok, `deveria recusar "${v}"`);
    });
    assert.ok(!interpretarListaMeses(undefined).ok);
  });

  // Bug: ?meses=a&meses=b faz o Express entregar um array, e array.split
  // derrubaria a rota com erro 500 em vez de um 400 claro.
  test('recusa array (parâmetro repetido na URL) sem quebrar', () => {
    assert.ok(!interpretarListaMeses(['2026-10', '2026-09']).ok);
  });

  test('recusa mais de 60 meses (cinco anos)', () => {
    const muitos = [];
    for (let i = 0; i < 61; i++) muitos.push(`${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`);
    assert.ok(!interpretarListaMeses(muitos.join(',')).ok);
    assert.ok(interpretarListaMeses(muitos.slice(0, 60).join(',')).ok);
  });
});

describe('mesesDisponiveis e filtrarPorMeses', () => {
  const dados = [
    { id: 1, mes: '2026-10' }, { id: 2, mes: '2026-09' }, { id: 3, mes: '2026-10' }, { id: 4, mes: null }
  ];

  test('meses com registro, em ordem cronológica, sem repetir nem nulo', () => {
    assert.deepStrictEqual(mesesDisponiveis(dados), ['2026-09', '2026-10']);
    assert.deepStrictEqual(mesesDisponiveis([]), []);
  });

  test('filtra pelos meses pedidos; null significa todos', () => {
    assert.deepStrictEqual(filtrarPorMeses(dados, ['2026-09']).map((d) => d.id), [2]);
    assert.deepStrictEqual(filtrarPorMeses(dados, ['2026-09', '2026-10']).map((d) => d.id), [1, 2, 3]);
    assert.strictEqual(filtrarPorMeses(dados, null).length, 4);
    assert.deepStrictEqual(filtrarPorMeses(dados, ['2025-01']), []);
  });
});

describe('resumirMeses — o número que vai para o cliente', () => {
  const linha = (o) => ({
    id: 1, mes: '2026-10', demandaAcs: '', pontosTotal: null,
    documentacao: null, desenvolvimento: null, teste: null, implantacao: null, ...o
  });

  test('soma cada mês e o "total entregue" é a soma das 4 fases', () => {
    const r = resumirMeses([
      linha({ id: 1, demandaAcs: 'A', pontosTotal: 10, documentacao: 3, desenvolvimento: 4 }),
      linha({ id: 2, demandaAcs: 'B', pontosTotal: 2.3, teste: 0.5, implantacao: 0.2 })
    ], ['2026-10']);
    assert.deepStrictEqual(r.porMes, [{
      mes: '2026-10', demandas: 2, pontosTotal: 12.3, documentacao: 3, desenvolvimento: 4,
      teste: 0.5, implantacao: 0.2, entregue: 7.7
    }]);
  });

  test('vem em ordem cronológica e inclui mês pedido sem nenhum registro, zerado', () => {
    const r = resumirMeses([linha({ mes: '2026-10', teste: 1 })], ['2026-10', '2026-08', '2026-10']);
    assert.deepStrictEqual(r.porMes.map((m) => m.mes), ['2026-08', '2026-10']);
    assert.strictEqual(r.porMes[0].demandas, 0);
    assert.strictEqual(r.porMes[0].entregue, 0);
  });

  test('ignora registro de mês que não foi pedido', () => {
    const r = resumirMeses([
      linha({ id: 1, mes: '2026-09', teste: 5 }), linha({ id: 2, mes: '2026-10', teste: 1 })
    ], ['2026-10']);
    assert.strictEqual(r.consolidado.teste, 1);
    assert.strictEqual(r.consolidado.demandas, 1);
  });

  test('consolidado soma as fases de todos os meses', () => {
    const r = resumirMeses([
      linha({ id: 1, mes: '2026-09', demandaAcs: 'A', documentacao: 1, desenvolvimento: 2 }),
      linha({ id: 2, mes: '2026-10', demandaAcs: 'A', teste: 0.5, implantacao: 0.5 })
    ], ['2026-09', '2026-10']);
    assert.strictEqual(r.consolidado.documentacao, 1);
    assert.strictEqual(r.consolidado.desenvolvimento, 2);
    assert.strictEqual(r.consolidado.teste, 0.5);
    assert.strictEqual(r.consolidado.entregue, 4);
    assert.strictEqual(r.consolidado.meses, 2);
  });

  // Bug que isto pega: a mesma demanda aparece em vários meses (um registro
  // novo por mês) e cada linha repete o total de pontos dela. Somar tudo
  // contaria a demanda duas vezes e inflaria o consolidado apresentado ao
  // cliente. O mês a mês continua mostrando o valor de cada mês.
  test('a mesma demanda em dois meses conta os pontos UMA vez no consolidado', () => {
    const r = resumirMeses([
      linha({ id: 1, mes: '2026-09', demandaAcs: '20260525005', pontosTotal: 10 }),
      linha({ id: 2, mes: '2026-10', demandaAcs: '20260525005', pontosTotal: 12 }),
      linha({ id: 3, mes: '2026-10', demandaAcs: '20260616011', pontosTotal: 5 })
    ], ['2026-09', '2026-10']);
    assert.strictEqual(r.porMes[0].pontosTotal, 10);
    assert.strictEqual(r.porMes[1].pontosTotal, 17);
    assert.strictEqual(r.consolidado.pontosTotal, 17); // 12 (mês mais recente) + 5, nao 27
    assert.strictEqual(r.consolidado.demandas, 2);
  });

  test('se o mês mais recente não informou o total, vale o último informado', () => {
    const r = resumirMeses([
      linha({ id: 1, mes: '2026-09', demandaAcs: 'A', pontosTotal: 10 }),
      linha({ id: 2, mes: '2026-10', demandaAcs: 'A', pontosTotal: null })
    ], ['2026-09', '2026-10']);
    assert.strictEqual(r.consolidado.pontosTotal, 10);
  });

  test('o número ACS é comparado sem espaços sobrando', () => {
    const r = resumirMeses([
      linha({ id: 1, mes: '2026-09', demandaAcs: ' A ', pontosTotal: 4 }),
      linha({ id: 2, mes: '2026-10', demandaAcs: 'A', pontosTotal: 4 })
    ], ['2026-09', '2026-10']);
    assert.strictEqual(r.consolidado.pontosTotal, 4);
    assert.strictEqual(r.consolidado.demandas, 1);
  });

  test('linha sem número ACS não dá para reconhecer como repetida: cada uma conta', () => {
    const r = resumirMeses([
      linha({ id: 1, mes: '2026-09', demandaAcs: '', pontosTotal: 5 }),
      linha({ id: 2, mes: '2026-10', demandaAcs: '', pontosTotal: 5 })
    ], ['2026-09', '2026-10']);
    assert.strictEqual(r.consolidado.pontosTotal, 10);
    assert.strictEqual(r.consolidado.demandas, 2);
  });

  test('"em análise" (total nulo) não entra na soma de pontos', () => {
    const r = resumirMeses([
      linha({ id: 1, demandaAcs: 'A', pontosTotal: null }), linha({ id: 2, demandaAcs: 'B', pontosTotal: 3 })
    ], ['2026-10']);
    assert.strictEqual(r.porMes[0].pontosTotal, 3);
    assert.strictEqual(r.consolidado.pontosTotal, 3);
    assert.strictEqual(r.consolidado.demandas, 2);
  });

  test('não acumula erro de ponto flutuante (0,1 + 0,2 = 0,3)', () => {
    const r = resumirMeses([
      linha({ id: 1, demandaAcs: 'A', teste: 0.1 }), linha({ id: 2, demandaAcs: 'B', teste: 0.2 })
    ], ['2026-10']);
    assert.strictEqual(r.porMes[0].teste, 0.3);
    assert.strictEqual(r.consolidado.entregue, 0.3);
  });

  test('sem nenhum registro, tudo zero e sem quebrar', () => {
    const r = resumirMeses([], ['2026-10']);
    assert.strictEqual(r.consolidado.entregue, 0);
    assert.strictEqual(r.consolidado.demandas, 0);
    assert.strictEqual(resumirMeses([], []).porMes.length, 0);
  });
});

describe('deLinha — mês', () => {
  test('carrega o mês, e linha antiga sem mês vira null', () => {
    assert.strictEqual(deLinha({ id: 1, mes: '2026-10' }).mes, '2026-10');
    assert.strictEqual(deLinha({ id: 1 }).mes, null);
  });
});
