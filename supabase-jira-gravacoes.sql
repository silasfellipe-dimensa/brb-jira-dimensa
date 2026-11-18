-- Rode este script uma vez no SQL Editor do Supabase.
-- Registro de cada gravação feita no Jira pela tela de Expedições (começa pela
-- Solução). No Jira a alteração aparece em nome da conta do token; quem
-- gravou de verdade, e o valor antes/depois, ficam só aqui.

create table if not exists public.jira_gravacoes (
  id bigint generated always as identity primary key,
  email text not null,
  issue text not null,
  campo text not null,
  valor_anterior text,
  valor_novo text,
  criado_em timestamptz not null default now()
);

create index if not exists jira_gravacoes_issue_idx
  on public.jira_gravacoes (issue, criado_em desc);

alter table public.jira_gravacoes enable row level security;

-- O servidor usa a service_role. Nao ha acesso publico direto.
