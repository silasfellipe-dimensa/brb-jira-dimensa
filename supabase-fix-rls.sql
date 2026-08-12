-- CORRECAO DE SEGURANCA - rode no SQL Editor do Supabase.
--
-- Problema: as politicas antigas usavam "using (true)", que libera leitura
-- e escrita da tabela snapshot para QUALQUER UM que tenha a chave publica
-- (anon/publishable). Isso permitia ler o board inteiro e sobrescreve-lo
-- sem passar pelo login da aplicacao.
--
-- Correcao: remover as politicas permissivas. Sem nenhuma politica, o RLS
-- nega tudo por padrao para a chave anon. O servidor passa a acessar a
-- tabela com a chave service_role, que ignora RLS e nunca sai do backend.

drop policy if exists "leitura do snapshot" on public.snapshot;
drop policy if exists "escrita do snapshot" on public.snapshot;

-- Garante que o RLS continua ligado (sem politicas = ninguem passa via anon).
alter table public.snapshot enable row level security;

-- Confirma o resultado: a listagem abaixo deve vir VAZIA.
select policyname from pg_policies where tablename = 'snapshot';
