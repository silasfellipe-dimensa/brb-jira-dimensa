// fetch do cliente do Supabase com nova tentativa para UM erro específico:
// "JWT issued at future".
//
// O que é: o Supabase recusa a chave porque, para o relógio de um dos
// servidores dele, ela foi emitida "no futuro" - diferença de relógio entre
// os servidores do próprio Supabase (a chave não muda; ninguém mexeu nela).
// Aparece de vez em quando e some sozinho em segundos.
//
// Por que repetir é seguro: a recusa acontece na autenticação, ANTES de o
// banco executar o pedido - nada foi gravado. Qualquer outro erro (inclusive
// outro 401) volta na hora, sem repetir.

const TENTATIVAS_EXTRAS = 2;
const ESPERA_MS = 800;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** É a recusa por relógio? Lê uma cópia do corpo (a resposta segue intacta). */
async function ehJwtNoFuturo(resposta) {
  if (resposta.status !== 401) return false;
  try {
    return /JWT issued at future/i.test(await resposta.clone().text());
  } catch (e) {
    return false;
  }
}

function criarFetchComNovaTentativa(fetchBase = fetch, { tentativas = TENTATIVAS_EXTRAS, esperaMs = ESPERA_MS } = {}) {
  return async function fetchComNovaTentativa(url, opcoes) {
    let resposta = await fetchBase(url, opcoes);
    for (let i = 1; i <= tentativas && (await ehJwtNoFuturo(resposta)); i++) {
      console.warn(`[supabase] "JWT issued at future" (relógio do Supabase); nova tentativa ${i} de ${tentativas}`);
      await dormir(esperaMs * i);
      resposta = await fetchBase(url, opcoes);
    }
    return resposta;
  };
}

module.exports = { criarFetchComNovaTentativa, ehJwtNoFuturo };
