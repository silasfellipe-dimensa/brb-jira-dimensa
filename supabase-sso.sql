-- Rode este script uma vez no SQL Editor do Supabase.
-- Login único (sso.js): cada "passe" só pode ser usado uma vez. O sistema de
-- destino grava aqui o id do passe (jti) ao usar; um segundo uso do mesmo
-- passe bate na chave primária e é recusado.
--
-- Um projeto Supabase só para os três sistemas (Portal, Kanban, Qualidade):
-- esta tabela serve a todos. Sem ela, o login único fica recusando todos os
-- passes (falha fechada) e as pessoas entram com e-mail e senha, como antes.

create table if not exists public.sso_passes_usados (
  jti text primary key,
  sistema text not null,
  usado_em timestamptz not null default now()
);

-- Passe vale 60 s; a linha só precisa existir enquanto o passe poderia ser
-- reaproveitado. A limpeza é feita pelos próprios sistemas (linhas com mais
-- de 1 dia), então este índice deixa o "apagar velhos" barato.
create index if not exists sso_passes_usados_usado_em_idx
  on public.sso_passes_usados (usado_em);

alter table public.sso_passes_usados enable row level security;

-- Sem política: só o servidor (service_role) lê e grava. A chave pública não
-- enxerga nem escreve nada aqui.
