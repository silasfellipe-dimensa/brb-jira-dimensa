require('dotenv').config({ path: '.env.local' });

const url = process.env.SUPABASE_URL + '/auth/v1/health';

console.log('Tentando alcançar:', url);
console.log('Variaveis de proxy no ambiente:', {
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  http_proxy: process.env.http_proxy,
  https_proxy: process.env.https_proxy,
  NO_PROXY: process.env.NO_PROXY
});

fetch(url, { headers: { apikey: process.env.SUPABASE_ANON_KEY } })
  .then((r) => r.text().then((t) => console.log('OK:', r.status, t)))
  .catch((erro) => {
    console.log('FALHOU.');
    console.log('erro.message:', erro.message);
    console.log('erro.cause:', erro.cause);
    console.log('erro completo:', JSON.stringify(erro, Object.getOwnPropertyNames(erro), 2));
  });
