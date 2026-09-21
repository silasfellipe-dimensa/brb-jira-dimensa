-- Rode este script uma vez no SQL Editor do Supabase.
-- Mantem uma linha por task e sprint de conclusao, sem apagar historico.

create table if not exists public.entregas (
  id text primary key,
  chave text not null,
  conclusao_em timestamptz,
  sprint_conclusao text,
  sprint_conclusao_id bigint,
  sprint_origem text,
  sprint_origem_id bigint,
  dados jsonb not null,
  atualizado_em timestamptz not null default now()
);

create index if not exists entregas_conclusao_em_idx
  on public.entregas (conclusao_em desc);
create index if not exists entregas_sprint_conclusao_idx
  on public.entregas (sprint_conclusao);

alter table public.entregas enable row level security;

-- O servidor usa a service_role. Nao ha acesso publico direto.
