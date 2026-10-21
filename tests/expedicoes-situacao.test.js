// Expedições: o cartão diz quantos itens faltam, a tela diz quando os dados
// foram lidos e o que aconteceu com a última alteração (não há botão Salvar).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'paginas', 'expedicoes.html'), 'utf8');

test('chip: "faltam 5 itens" / "falta 1 item"', () => {
  assert.match(html, /p\.pendentes === 1 \? 'falta 1 item' : 'faltam ' \+ p\.pendentes \+ ' itens'/);
});

test('linha de situação ao lado do resumo, lida por leitor de tela', () => {
  assert.match(html, /<div class="situacao" id="situacao" aria-live="polite"><\/div>/);
  for (const t of ['Salvamento automático', 'Salvando…', 'Salvo automaticamente às ', 'Última alteração não foi salva', 'Salva ao sair do campo', 'Atualizado em ']) {
    assert.ok(html.includes(t), t);
  }
});

test('toda gravação passa pelo contador de "Salvando…" (inclusive com outra em andamento)', () => {
  const i = html.indexOf('function executar(promessa, aoConcluir, aoFalhar) {');
  const corpo = html.slice(i, html.indexOf('if (ocupado) return;', i));
  assert.match(corpo, /situacao\.salvando\+\+/);
  assert.ok(!/executar\(chamar\('GET'/.test(html), 'leitura não conta como salvamento');
});

test('Atualizar em destaque e "Atualizado em" renovado a cada carga', () => {
  assert.match(html, /class="btn destaque" data-acao="atualizar"/);
  assert.match(html, /situacao\.carregadoEm = new Date\(\)/);
});

test('alerta de subtarefas abertas: fora do checklist, só o aviso (sem listar quais); vermelho perto da data', () => {
  assert.match(html, /j\.status === 'ok' && j\.subtarefasAbertas > 0/);
  assert.match(html, /⚠ Há subtarefas em aberto no Jira</);
  assert.match(html, /var perto = e\.dias !== null && e\.dias !== undefined && e\.dias <= 1;/);
});

test('item que o Jira ainda não confirma: checkbox desabilitado, N/A continua disponível', () => {
  assert.match(html, /var semClique = travado \|\| soJira;/);
  assert.match(html, /\(semClique \? ' disabled' : ''\)/);
  assert.match(html, /else if \(!travado\) linha \+= '<button type="button" class="mini" data-acao="abrir-na"/);
});

test('Solução assistida: o texto do Jira aparece para o time ler', () => {
  assert.match(html, /<blockquote>' \+ esc\(i\.jira\.detalhe\) \+ '<\/blockquote>/);
});
