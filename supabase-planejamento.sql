-- Rode este script uma vez no SQL Editor do Supabase.
-- Guarda uma linha por grupo (epico ou task avulsa) e sprint de ORIGEM -
-- diferente de "entregas" (que so guarda quem ja foi concluido), aqui
-- entram tambem os grupos ainda em aberto, para responder "o que era pra
-- sair dessa sprint, saiu?".

create table if not exists public.planejamento_sprints (
  id text primary key,
  chave text not null,
  tipo text not null,
  sprint_origem text,
  sprint_origem_id bigint,
  entregue boolean not null default false,
  sprint_conclusao text,
  sprint_conclusao_id bigint,
  conclusao_em timestamptz,
  total int not null default 0,
  concluidas int not null default 0,
  dados jsonb not null,
  atualizado_em timestamptz not null default now()
);

create index if not exists planejamento_sprint_origem_idx
  on public.planejamento_sprints (sprint_origem_id);
create index if not exists planejamento_sprint_conclusao_idx
  on public.planejamento_sprints (sprint_conclusao_id);

alter table public.planejamento_sprints enable row level security;

-- O servidor usa a service_role. Nao ha acesso publico direto.
