require('dotenv').config({ path: '.env.local' });

const { buscarEntregasHistoricas } = require('./jira');
const {
  gravarEntregas, limparEntregas, gravarPlanejamento, limparPlanejamento
} = require('./supabase');

buscarEntregasHistoricas()
  .then(async ({ entregas, planejamento }) => {
    // Limpa antes de gravar: o modelo mudou de "uma linha por task" para
    // "uma linha por epico/task avulsa concluido" - linhas antigas usam
    // chaves que não existem mais nesse novo modelo e ficariam órfãs,
    // duplicando a contagem do histórico se não forem removidas primeiro.
    const limpouEntregas = await limparEntregas();
    if (!limpouEntregas) {
      throw new Error('Não foi possível limpar as entregas antigas antes da nova carga.');
    }
    const limpouPlanejamento = await limparPlanejamento();
    if (!limpouPlanejamento) {
      throw new Error('Não foi possível limpar o planejamento antigo antes da nova carga.');
    }
    const gravado = await gravarEntregas(entregas);
    if (!gravado) {
      throw new Error('As entregas foram consultadas, mas não foram gravadas no Supabase.');
    }
    const gravadoPlanejamento = await gravarPlanejamento(planejamento);
    if (!gravadoPlanejamento) {
      throw new Error('O planejamento foi consultado, mas não foi gravado no Supabase.');
    }
    console.log(
      `Carga retroativa concluída: ${entregas.length} entrega(s) e ` +
      `${planejamento.length} item(ns) de planejamento processado(s).`
    );
  })
  .catch((erro) => {
    console.error('Falha na carga retroativa de entregas:', erro.message);
    process.exitCode = 1;
  });
