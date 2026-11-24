// Regras da tela "Demandas" (ACS) - acs.js. Sem banco, sem rede.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  interpretarDataBr, normalizarSolicitacao, normalizarCarga, normalizarErroColetor, deLinhaAcs,
  emBrasilia, horasUteisEntre, situacaoColeta, deveColetar, assinar, conferirAssinatura,
  MAX_SOLICITACOES
} = require('../acs');

// Como o ACS manda (formato real do endpoint, com dados inventados).
const bruta = (extra = {}) => ({
  SQ_SOLICITACAO: 20260511005,
  SISSIGLA: 'TTB',
  DS_STATUS_SOLICITACAO: 'EM IMPLANTAÇÃO',
  ST_SOLICITACAO: 'Q',
  DS_RESUMO: 'Criação de relatórios analíticos',
  DT_IMPLANTACAO: '29/10/2026',
  DT_SOLICITACAO: '11/05/2026',
  DT_PREVISAO_INICIO: '27/05/2026',
  DT_PREVISAO_TERMINO: '26/06/2026',
  NO_GESTOR_NEGOCIO: 'FULANA DE TAL',
  NR_GESTOR_NEGOCIO: 12345,
  ...extra
});

// Instante a partir da hora de Brasília (UTC-3).
const brt = (dia, hora = '00:00') => new Date(`${dia}T${hora}:00-03:00`);

describe('interpretarDataBr — "dd/mm/aaaa" do ACS', () => {
  test('converte para AAAA-MM-DD', () => {
    assert.strictEqual(interpretarDataBr('29/10/2026'), '2026-10-29');
    assert.strictEqual(interpretarDataBr(' 01/02/2026 '), '2026-02-01');
  });

  test('vazio, espaço e nulo viram null (data ainda não definida)', () => {
    for (const v of ['', '   ', null, undefined]) assert.strictEqual(interpretarDataBr(v), null);
  });

  // Caso real: 14 das 56 solicitações vieram com "-" na previsão de início e
  // de término, e a carga inteira era recusada por causa delas.
  test('"-" é como o ACS escreve "sem data": vira null', () => {
    for (const v of ['-', ' - ', '--']) assert.strictEqual(interpretarDataBr(v), null, v);
    assert.strictEqual(interpretarDataBr('-1'), undefined);
  });

  test('formato errado ou data que não existe devolve undefined', () => {
    for (const v of ['2026-10-29', '29/10/26', '31/02/2026', '00/01/2026', '10/13/2026', 'amanhã', '29-10-2026']) {
      assert.strictEqual(interpretarDataBr(v), undefined, v);
    }
  });
});

describe('normalizarSolicitacao — item do ACS vira linha do banco', () => {
  test('mapeia os campos e converte as datas', () => {
    assert.deepStrictEqual(normalizarSolicitacao(bruta()), {
      ok: true,
      linha: {
        numero: 20260511005, sistema: 'TTB', status_codigo: 'Q', status: 'EM IMPLANTAÇÃO',
        resumo: 'Criação de relatórios analíticos', gestor: 'FULANA DE TAL',
        data_solicitacao: '2026-05-11', previsao_inicio: '2026-05-27',
        previsao_termino: '2026-06-26', data_implantacao: '2026-10-29'
      }
    });
  });

  // Bug que isto pega: a matrícula do gestor ir parar no banco na nuvem.
  test('a matrícula do gestor não é guardada', () => {
    const { linha } = normalizarSolicitacao(bruta());
    assert.ok(!JSON.stringify(linha).includes('12345'));
    assert.ok(!Object.keys(linha).some((k) => /nr_gestor|matricula/i.test(k)));
  });

  test('campo que o ACS não mandou não vira coluna inesperada', () => {
    const { linha } = normalizarSolicitacao(bruta({ CAMPO_NOVO: 'x', removido: true }));
    assert.deepStrictEqual(Object.keys(linha).sort(), [
      'data_implantacao', 'data_solicitacao', 'gestor', 'numero', 'previsao_inicio',
      'previsao_termino', 'resumo', 'sistema', 'status', 'status_codigo'
    ]);
  });

  test('data vazia vira null; texto é aparado e limitado', () => {
    const { linha } = normalizarSolicitacao(bruta({ DT_IMPLANTACAO: '  ', DS_RESUMO: '  a   b\n c  ' + 'x'.repeat(600) }));
    assert.strictEqual(linha.data_implantacao, null);
    assert.ok(linha.resumo.startsWith('a b c'));
    assert.strictEqual(linha.resumo.length, 500);
  });

  test('recusa número inválido, status faltando e data torta', () => {
    for (const ruim of [
      null, 'texto', [], bruta({ SQ_SOLICITACAO: 0 }), bruta({ SQ_SOLICITACAO: -5 }), bruta({ SQ_SOLICITACAO: 'abc' }),
      bruta({ SQ_SOLICITACAO: 1.5 }), bruta({ ST_SOLICITACAO: '' }), bruta({ DS_STATUS_SOLICITACAO: '  ' }),
      bruta({ DT_SOLICITACAO: '2026-05-11' }), bruta({ DT_PREVISAO_TERMINO: '31/02/2026' })
    ]) {
      assert.strictEqual(normalizarSolicitacao(ruim).ok, false, JSON.stringify(ruim));
    }
  });
});

describe('normalizarCarga — o corpo que o coletor manda', () => {
  test('lista válida vira linhas', () => {
    const r = normalizarCarga({ solicitacoes: [bruta(), bruta({ SQ_SOLICITACAO: 20260511006 })] });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.linhas.map((l) => l.numero), [20260511005, 20260511006]);
  });

  // Bug que isto pega: o ACS devolver [] num dia ruim e a tela "perder" todas
  // as demandas (quem não vem na lista é marcado como fora de andamento).
  test('lista vazia é recusada, para não apagar a tela', () => {
    const r = normalizarCarga({ solicitacoes: [] });
    assert.strictEqual(r.ok, false);
    assert.match(r.erro, /vazia/);
  });

  test('um item ruim recusa a carga inteira e diz qual', () => {
    const r = normalizarCarga({ solicitacoes: [bruta(), bruta({ SQ_SOLICITACAO: 'x' })] });
    assert.strictEqual(r.ok, false);
    assert.match(r.erro, /Item 2/);
  });

  test('sem lista, ou lista que não é lista, é recusada', () => {
    for (const corpo of [undefined, null, {}, { solicitacoes: 'x' }, { solicitacoes: {} }, [bruta()]]) {
      assert.strictEqual(normalizarCarga(corpo).ok, false, JSON.stringify(corpo));
    }
  });

  test('número repetido conta uma vez (vale o último)', () => {
    const r = normalizarCarga({ solicitacoes: [bruta({ DS_RESUMO: 'primeiro' }), bruta({ DS_RESUMO: 'segundo' })] });
    assert.strictEqual(r.linhas.length, 1);
    assert.strictEqual(r.linhas[0].resumo, 'segundo');
  });

  test('lista maior que o limite é recusada', () => {
    const muitas = Array.from({ length: MAX_SOLICITACOES + 1 }, (_, i) => bruta({ SQ_SOLICITACAO: 1000 + i }));
    assert.strictEqual(normalizarCarga({ solicitacoes: muitas }).ok, false);
  });
});

describe('normalizarErroColetor — o coletor avisando que falhou', () => {
  test('texto do erro, aparado e limitado', () => {
    assert.strictEqual(normalizarErroColetor({ erro: '  ACS respondeu 401  ' }), 'ACS respondeu 401');
    assert.strictEqual(normalizarErroColetor({ erro: 'x'.repeat(900) }).length, 500);
    assert.strictEqual(normalizarErroColetor({ erro: '   ' }), 'Falha sem descrição.');
  });

  test('sem campo erro (ou não-texto) não é aviso de falha', () => {
    for (const corpo of [undefined, null, {}, { solicitacoes: [] }, { erro: 500 }, { erro: null }]) {
      assert.strictEqual(normalizarErroColetor(corpo), null);
    }
  });
});

describe('deLinhaAcs — linha do banco para a API', () => {
  const linha = {
    numero: 20260511005, sistema: 'TTB', status_codigo: 'X', status: 'EM EXECUÇÃO', resumo: 'r', gestor: 'g',
    data_solicitacao: '2026-05-11', previsao_inicio: null, previsao_termino: '2026-06-26', data_implantacao: null,
    status_desde: '2026-11-20T11:00:00+00:00', primeira_coleta: '2026-11-10T11:00:00+00:00'
  };

  test('converte os nomes e mantém data vazia como null', () => {
    const s = deLinhaAcs(linha);
    assert.strictEqual(s.numero, 20260511005);
    assert.strictEqual(s.statusCodigo, 'X');
    assert.strictEqual(s.previsaoInicio, null);
    assert.strictEqual(s.previsaoTermino, '2026-06-26');
    assert.strictEqual(s.statusDesdeAproximado, false);
  });

  test('status que nunca mudou desde a 1ª coleta: o "desde" é aproximado', () => {
    assert.strictEqual(deLinhaAcs({ ...linha, status_desde: linha.primeira_coleta }).statusDesdeAproximado, true);
  });
});

describe('horasUteisEntre — sábado e domingo não contam (Brasília)', () => {
  test('dentro da semana conta tudo', () => {
    // 2026-11-23 é segunda-feira
    assert.strictEqual(emBrasilia(brt('2026-11-23', '08:00')).diaSemana, 1);
    assert.strictEqual(horasUteisEntre(brt('2026-11-23', '08:00'), brt('2026-11-24', '08:00')), 24);
    assert.strictEqual(horasUteisEntre(brt('2026-11-23', '08:00'), brt('2026-11-23', '09:30')), 1.5);
  });

  test('sexta 8h até segunda 8h = 24h úteis (o fim de semana não conta)', () => {
    assert.strictEqual(horasUteisEntre(brt('2026-11-20', '08:00'), brt('2026-11-23', '08:00')), 24);
  });

  test('começando ou terminando no fim de semana', () => {
    assert.strictEqual(horasUteisEntre(brt('2026-11-21', '10:00'), brt('2026-11-22', '22:00')), 0);
    assert.strictEqual(horasUteisEntre(brt('2026-11-21', '10:00'), brt('2026-11-23', '08:00')), 8);
  });

  test('o dia vira à meia-noite de Brasília, não de UTC', () => {
    // sexta 22h de Brasília já é sábado em UTC: as 2h até meia-noite ainda contam
    assert.strictEqual(horasUteisEntre(brt('2026-11-20', '22:00'), brt('2026-11-21', '03:00')), 2);
  });

  test('fim antes do início, ou datas iguais, dá zero', () => {
    assert.strictEqual(horasUteisEntre(brt('2026-11-24', '08:00'), brt('2026-11-23', '08:00')), 0);
    assert.strictEqual(horasUteisEntre(brt('2026-11-24', '08:00'), brt('2026-11-24', '08:00')), 0);
  });

  test('intervalo de anos não trava: devolve o teto', () => {
    assert.strictEqual(horasUteisEntre(new Date('2000-01-01'), new Date('2026-11-24')), 400 * 24);
  });
});

describe('situacaoColeta — o aviso "sem atualização há mais de 1 dia útil"', () => {
  test('nunca coletou', () => {
    assert.deepStrictEqual(situacaoColeta(null, brt('2026-11-24', '10:00')), { estado: 'nunca', horasUteis: null });
  });

  test('coletou hoje cedo: em dia', () => {
    assert.strictEqual(situacaoColeta(brt('2026-11-24', '08:02'), brt('2026-11-24', '17:00')).estado, 'em-dia');
  });

  // A coleta é às 8h: no dia seguinte, antes de a nova chegar, não pode alarmar.
  test('coletou ontem às 8h; hoje às 8h30 ainda não avisa (folga para a máquina ligar)', () => {
    assert.strictEqual(situacaoColeta(brt('2026-11-23', '08:02'), brt('2026-11-24', '08:30')).estado, 'em-dia');
  });

  test('coletou ontem às 8h e hoje não veio: às 10h já avisa', () => {
    const s = situacaoColeta(brt('2026-11-23', '08:02'), brt('2026-11-24', '10:00'));
    assert.strictEqual(s.estado, 'atrasada');
    assert.ok(s.horasUteis > 25);
  });

  test('coletou sexta às 8h: no fim de semana e na segunda cedo continua em dia', () => {
    const sexta = brt('2026-11-20', '08:02');
    assert.strictEqual(situacaoColeta(sexta, brt('2026-11-22', '15:00')).estado, 'em-dia');
    assert.strictEqual(situacaoColeta(sexta, brt('2026-11-23', '08:30')).estado, 'em-dia');
    assert.strictEqual(situacaoColeta(sexta, brt('2026-11-23', '10:00')).estado, 'atrasada');
  });
});

describe('deveColetar — o que o servidor responde ao coletor', () => {
  const base = { ultimaOk: null, ultimaFalha: null, pedidoPendente: false };

  test('pedido do botão Atualizar vale a qualquer hora, até no fim de semana', () => {
    assert.deepStrictEqual(deveColetar({ ...base, agora: brt('2026-11-22', '03:00'), pedidoPendente: true }), { coletar: true, motivo: 'pedido' });
  });

  test('dia útil antes das 8h: ainda não', () => {
    assert.deepStrictEqual(deveColetar({ ...base, agora: brt('2026-11-24', '07:59') }), { coletar: false, motivo: 'antes-da-hora' });
  });

  test('dia útil a partir das 8h, sem coleta hoje: coleta', () => {
    assert.deepStrictEqual(deveColetar({ ...base, agora: brt('2026-11-24', '08:00') }), { coletar: true, motivo: 'diaria' });
    // máquina ligou tarde: coleta assim que perguntar
    assert.strictEqual(deveColetar({ ...base, agora: brt('2026-11-24', '14:20'), ultimaOk: brt('2026-11-23', '08:01') }).coletar, true);
  });

  test('já coletou hoje: não repete', () => {
    const r = deveColetar({ ...base, agora: brt('2026-11-24', '11:00'), ultimaOk: brt('2026-11-24', '08:01') });
    assert.deepStrictEqual(r, { coletar: false, motivo: 'ja-coletou-hoje' });
  });

  test('"hoje" é o dia de Brasília: coleta de ontem às 23h não vale para hoje', () => {
    const r = deveColetar({ ...base, agora: brt('2026-11-24', '08:05'), ultimaOk: brt('2026-11-23', '23:00') });
    assert.strictEqual(r.coletar, true);
  });

  test('sábado e domingo não há coleta diária', () => {
    assert.strictEqual(deveColetar({ ...base, agora: brt('2026-11-21', '09:00') }).motivo, 'fim-de-semana');
    assert.strictEqual(deveColetar({ ...base, agora: brt('2026-11-22', '09:00') }).motivo, 'fim-de-semana');
  });

  // Bug que isto pega: ACS fora do ar e o coletor batendo nele a cada 5 minutos.
  test('depois de uma falha, espera 30 minutos para tentar de novo', () => {
    const falhou = brt('2026-11-24', '08:00');
    assert.deepStrictEqual(deveColetar({ ...base, agora: brt('2026-11-24', '08:10'), ultimaFalha: falhou }),
      { coletar: false, motivo: 'aguardando-nova-tentativa' });
    assert.strictEqual(deveColetar({ ...base, agora: brt('2026-11-24', '08:31'), ultimaFalha: falhou }).coletar, true);
  });
});

describe('assinatura dos pedidos do coletor', () => {
  const segredo = 'a'.repeat(64);
  const agora = new Date('2026-11-24T11:00:00Z');
  const timestamp = String(Math.floor(agora.getTime() / 1000));
  const corpo = Buffer.from('{"solicitacoes":[]}', 'utf8');
  const pedido = { timestamp, metodo: 'POST', caminho: '/api/acs/coletor/carga', corpo };
  const assinatura = assinar(segredo, pedido);
  const conferir = (mudancas = {}) => conferirAssinatura({ segredo, assinatura, agora, ...pedido, ...mudancas });

  test('assinatura certa passa', () => {
    assert.strictEqual(conferir(), true);
    assert.strictEqual(conferir({ metodo: 'post' }), true, 'o método não diferencia maiúscula');
  });

  test('qualquer coisa alterada no caminho derruba: corpo, rota, método, hora', () => {
    assert.strictEqual(conferir({ corpo: Buffer.from('{"solicitacoes":[1]}') }), false);
    assert.strictEqual(conferir({ caminho: '/api/acs/coletor/tarefa' }), false);
    assert.strictEqual(conferir({ metodo: 'GET' }), false);
    assert.strictEqual(conferir({ timestamp: String(Number(timestamp) + 1) }), false);
  });

  test('segredo errado não passa', () => {
    assert.strictEqual(conferir({ segredo: 'b'.repeat(64) }), false);
  });

  // Bug que isto pega: alguém gravar um pedido válido e reenviar mais tarde.
  test('pedido com mais de 5 minutos (para trás ou para a frente) é recusado', () => {
    const tarde = new Date(agora.getTime() + 5 * 60 * 1000 + 1000);
    const cedo = new Date(agora.getTime() - 5 * 60 * 1000 - 1000);
    assert.strictEqual(conferir({ agora: tarde }), false);
    assert.strictEqual(conferir({ agora: cedo }), false);
    assert.strictEqual(conferir({ agora: new Date(agora.getTime() + 4 * 60 * 1000) }), true);
  });

  // Falha fechada: esquecer a variável de ambiente não pode abrir a rota.
  test('sem segredo configurado, ou curto demais, ninguém passa', () => {
    for (const s of [undefined, null, '', 'curto', 'a'.repeat(31)]) {
      const curta = s ? assinar(s, pedido) : assinatura;
      assert.strictEqual(conferirAssinatura({ segredo: s, assinatura: curta, agora, ...pedido }), false, String(s));
    }
  });

  test('cabeçalho faltando ou malformado não passa (nem quebra)', () => {
    for (const mud of [
      { assinatura: undefined }, { assinatura: '' }, { assinatura: 'zz' }, { assinatura: assinatura.slice(2) },
      { timestamp: undefined }, { timestamp: '' }, { timestamp: 'agora' }, { timestamp: `${timestamp}000` }
    ]) {
      assert.strictEqual(conferir(mud), false, JSON.stringify(mud));
    }
  });

  test('pedido sem corpo (GET) também é assinado', () => {
    const get = { timestamp, metodo: 'GET', caminho: '/api/acs/coletor/tarefa', corpo: undefined };
    const a = assinar(segredo, get);
    assert.strictEqual(conferirAssinatura({ segredo, assinatura: a, agora, ...get }), true);
    assert.strictEqual(conferirAssinatura({ segredo, assinatura: a, agora, ...get, caminho: '/api/acs/coletor/carga' }), false);
  });
});
