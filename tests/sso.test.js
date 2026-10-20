// Login único (sso.js): o passe e as rotas /sso (chegada) e /ir/qualidade (saída).
// Supabase aponta para 127.0.0.1:1: queimar o passe falha - e isso TEM de
// virar "não entra" (falha fechada). O caminho feliz com banco real fica no
// teste de ponta a ponta.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

process.env.ALLOWED_DOMAINS = 'dimensa.com.br,brb.com.br,evertecinc.com.br,totvs.com.br';
process.env.SESSION_SECRET = 'segredo-de-teste-nao-usado-em-producao';
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_ANON_KEY = 'chave-de-teste';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'chave-de-servico-de-teste';
process.env.QUALIDADE_URL = 'https://qualidade.exemplo/';
const SEGREDO = 'segredo-sso-de-teste-com-mais-de-32-caracteres';
process.env.SSO_SECRET = SEGREDO;

const sso = require('../sso');

describe('passe (sso.js)', () => {
  test('emitido pelo Portal para o Kanban: o Kanban lê; o e-mail vem minúsculo', () => {
    const p = sso.emitirPasse('Fulano@Dimensa.com.br', 'kanban', 'portal');
    const d = sso.lerPasse(p, 'kanban');
    assert.strictEqual(d.email, 'fulano@dimensa.com.br');
    assert.match(d.jti, /^[0-9a-f-]{36}$/);
  });

  test('passe de um sistema não abre outro (aud)', () => {
    const p = sso.emitirPasse('fulano@dimensa.com.br', 'qualidade', 'portal');
    assert.strictEqual(sso.lerPasse(p, 'kanban'), null);
  });

  test('cada passe tem id próprio (uso único depende disso)', () => {
    const a = sso.lerPasse(sso.emitirPasse('a@dimensa.com.br', 'kanban', 'portal'), 'kanban');
    const b = sso.lerPasse(sso.emitirPasse('a@dimensa.com.br', 'kanban', 'portal'), 'kanban');
    assert.notStrictEqual(a.jti, b.jti);
  });

  test('recusa: vencido, assinado com outro segredo, emissor = destino, emissor desconhecido, lixo', () => {
    const base = { email: 'a@dimensa.com.br' };
    const op = (o) => ({ algorithm: 'HS256', audience: 'kanban', issuer: 'portal', jwtid: 'x', expiresIn: 60, ...o });
    const vencido = jwt.sign({ ...base, iat: Math.floor(Date.now() / 1000) - 120 }, SEGREDO, op({ expiresIn: 30 }));
    assert.strictEqual(sso.lerPasse(vencido, 'kanban'), null, 'vencido');
    assert.strictEqual(sso.lerPasse(jwt.sign(base, 'outro-segredo-qualquer-com-32-caracteres!!', op()), 'kanban'), null, 'outro segredo');
    assert.strictEqual(sso.lerPasse(jwt.sign(base, SEGREDO, op({ issuer: 'kanban' })), 'kanban'), null, 'emissor = destino');
    assert.strictEqual(sso.lerPasse(jwt.sign(base, SEGREDO, op({ issuer: 'invasor' })), 'kanban'), null, 'emissor desconhecido');
    assert.strictEqual(sso.lerPasse(jwt.sign(base, SEGREDO, op({ algorithm: 'HS512' })), 'kanban'), null, 'outro algoritmo');
    assert.strictEqual(sso.lerPasse(jwt.sign({}, SEGREDO, op()), 'kanban'), null, 'sem e-mail');
    for (const lixo of [undefined, '', 'abc', 'x'.repeat(3000), ['a']]) assert.strictEqual(sso.lerPasse(lixo, 'kanban'), null);
  });

  test('passe que dura mais que 60 s (maxAge) é recusado mesmo com exp longo', () => {
    const longo = jwt.sign({ email: 'a@dimensa.com.br', iat: Math.floor(Date.now() / 1000) - 90 }, SEGREDO,
      { algorithm: 'HS256', audience: 'kanban', issuer: 'portal', jwtid: 'x', expiresIn: 3600 });
    assert.strictEqual(sso.lerPasse(longo, 'kanban'), null);
  });

  test('sem SSO_SECRET (ou curto): desligado - não emite nem aceita', () => {
    const p = sso.emitirPasse('a@dimensa.com.br', 'kanban', 'portal');
    process.env.SSO_SECRET = 'curto';
    try {
      assert.strictEqual(sso.ssoAtivo(), false);
      assert.strictEqual(sso.emitirPasse('a@dimensa.com.br', 'kanban', 'portal'), null);
      assert.strictEqual(sso.lerPasse(p, 'kanban'), null);
    } finally { process.env.SSO_SECRET = SEGREDO; }
  });

  test('caminhoSeguro: só caminho dentro do próprio sistema', () => {
    assert.strictEqual(sso.caminhoSeguro('/demandas'), '/demandas');
    assert.strictEqual(sso.caminhoSeguro('/demandas?ano=2026'), '/demandas?ano=2026');
    for (const ruim of ['https://mal.site', '//mal.site', '/\\mal.site', 'demandas', '', null, '/a\nb', '/' + 'x'.repeat(400)]) {
      assert.strictEqual(sso.caminhoSeguro(ruim), '/', String(ruim));
    }
  });

  test('urlDeEntrada: /sso do destino com passe e destino; destino ruim some', () => {
    const u = new URL(sso.urlDeEntrada('https://kanban.exemplo/', 'PASSE', '/demandas'));
    assert.strictEqual(u.origin + u.pathname, 'https://kanban.exemplo/sso');
    assert.strictEqual(u.searchParams.get('passe'), 'PASSE');
    assert.strictEqual(u.searchParams.get('destino'), '/demandas');
    assert.strictEqual(new URL(sso.urlDeEntrada('https://kanban.exemplo', 'P', '//mal.site')).searchParams.get('destino'), null);
  });

  test('o mesmo sso.js nos três projetos (quando estão lado a lado na máquina)', () => {
    const meu = fs.readFileSync(path.join(__dirname, '..', 'sso.js'), 'utf8').replace(/\r\n/g, '\n');
    for (const outro of ['hub', 'qualidade']) {
      const p = path.join(__dirname, '..', '..', outro, 'sso.js');
      if (!fs.existsSync(p)) continue; // CI só tem este repositório
      assert.strictEqual(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'), meu, outro + '/sso.js diferente');
    }
  });
});

describe('rotas', () => {
  const app = require('../server');
  const { criarSessao, COOKIE_NAME } = require('../auth');
  let servidor; let base;
  before(async () => { await new Promise((r) => { servidor = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${servidor.address().port}`; });
  after(() => servidor && servidor.close());
  const pedir = (c, o = {}) => fetch(base + c, { redirect: 'manual', ...o });
  const cookie = (email) => ({ Cookie: `${COOKIE_NAME}=${criarSessao({ email })}` });

  test('/sso sem passe, com lixo ou passe de outro sistema: volta ao login, sem sessão', async () => {
    for (const q of ['', '?passe=abc', '?passe=' + sso.emitirPasse('a@dimensa.com.br', 'qualidade', 'portal')]) {
      const r = await pedir('/sso' + q);
      assert.strictEqual(r.status, 303, q);
      assert.strictEqual(r.headers.get('location'), '/login.html?sso=expirado');
      assert.ok(!(r.headers.get('set-cookie') || '').includes(COOKIE_NAME), 'não abriu sessão');
    }
  });

  test('/sso com passe válido de domínio sem acesso: recusa e não abre sessão', async () => {
    const r = await pedir('/sso?passe=' + sso.emitirPasse('x@gmail.com', 'kanban', 'portal'));
    assert.strictEqual(r.headers.get('location'), '/login.html?sso=sem-acesso');
    assert.ok(!(r.headers.get('set-cookie') || '').includes(COOKIE_NAME));
  });

  test('/sso com passe válido mas banco fora (não dá para queimar): NÃO entra (falha fechada)', async () => {
    const r = await pedir('/sso?passe=' + sso.emitirPasse('a@dimensa.com.br', 'kanban', 'portal') + '&destino=/demandas');
    assert.strictEqual(r.headers.get('location'), '/login.html?sso=expirado');
    assert.ok(!(r.headers.get('set-cookie') || '').includes(COOKIE_NAME));
    assert.match(r.headers.get('cache-control'), /no-store/);
  });

  test('/ir/qualidade sem sessão: vai para o login', async () => {
    const r = await pedir('/ir/qualidade');
    assert.strictEqual(r.status, 302);
    assert.match(r.headers.get('location'), /login/);
  });

  test('/ir/qualidade: leva para o /sso do Qualidade com um passe válido SÓ para o Qualidade', async () => {
    const r = await pedir('/ir/qualidade', { headers: cookie('Fulano@dimensa.com.br') });
    const u = new URL(r.headers.get('location'));
    assert.strictEqual(u.origin + u.pathname, 'https://qualidade.exemplo/sso');
    const d = sso.lerPasse(u.searchParams.get('passe'), 'qualidade');
    assert.strictEqual(d.email, 'fulano@dimensa.com.br');
    assert.strictEqual(sso.lerPasse(u.searchParams.get('passe'), 'kanban'), null);
  });

  test('/ir/qualidade para quem não vê o Qualidade (TOTVS): volta ao quadro, sem passe', async () => {
    const r = await pedir('/ir/qualidade', { headers: cookie('fulano@totvs.com.br') });
    assert.strictEqual(r.headers.get('location'), '/');
  });

  test('/ir/qualidade com login único desligado: endereço puro (o Qualidade pede login, como antes)', async () => {
    process.env.SSO_SECRET = '';
    try {
      const r = await pedir('/ir/qualidade', { headers: cookie('fulano@dimensa.com.br') });
      assert.strictEqual(r.headers.get('location'), process.env.QUALIDADE_URL);
    } finally { process.env.SSO_SECRET = SEGREDO; }
  });
});
