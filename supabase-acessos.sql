-- Rode este script uma vez no SQL Editor do Supabase.
-- Historico de login, para a pagina /admin responder "quem entrou e quando".
-- So passa a existir a partir de quando este script roda - login anterior
-- a isso nao aparece, nao ha como reconstruir o passado.

create table if not exists public.acessos (
  id bigint generated always as identity primary key,
  email text not null,
  tipo text not null,
  criado_em timestamptz not null default now()
);

create index if not exists acessos_criado_em_idx
  on public.acessos (criado_em desc);

alter table public.acessos enable row level security;

-- O servidor usa a service_role. Nao ha acesso publico direto.
