-- Rode este script uma vez no SQL Editor do Supabase.
-- Tela "Demandas e Pontos de Funcao": uma linha por demanda/sustentacao, com
-- os pontos de funcao e quanto cada fase "pagou". Os valores das fases sao
-- digitados (sem regra fixa de percentual), e a maioria das colunas fica
-- vazia no comeco - a linha vai sendo preenchida conforme o projeto anda.
-- Remover e logico (removido = true): ponto pago e dado de cobranca.
-- Cada linha pertence a um mes ("AAAA-MM"): a entrega e mensal e cada mes
-- tem registros novos, entao a mesma demanda pode aparecer em varios meses.
--
-- Este script cria a tabela do zero. Se a tabela JA existe (criada antes do
-- campo "mes"), rode supabase-demandas-mes.sql em vez deste.

create table if not exists public.demandas_pf (
  id bigint generated always as identity primary key,
  mes text not null check (mes ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  demanda_acs text not null default '',
  artefato_jira text not null default '',
  nome text not null default '',
  pontos_total numeric(8,2) check (pontos_total is null or pontos_total >= 0),
  em_analise boolean not null default false,
  pontos_documentacao numeric(8,2) check (pontos_documentacao is null or pontos_documentacao >= 0),
  pontos_desenvolvimento numeric(8,2) check (pontos_desenvolvimento is null or pontos_desenvolvimento >= 0),
  pontos_teste numeric(8,2) check (pontos_teste is null or pontos_teste >= 0),
  pontos_implantacao numeric(8,2) check (pontos_implantacao is null or pontos_implantacao >= 0),
  inicio_atendimento date,
  conclusao_prevista date,
  previsao_expedicao date,
  observacoes text not null default '',
  removido boolean not null default false,
  criado_por text,
  criado_em timestamptz not null default now(),
  atualizado_por text,
  atualizado_em timestamptz not null default now()
);

create index if not exists demandas_pf_ativas_idx
  on public.demandas_pf (id) where removido = false;

create index if not exists demandas_pf_mes_idx
  on public.demandas_pf (mes) where removido = false;

alter table public.demandas_pf enable row level security;

-- O servidor usa a service_role. Nao ha acesso publico direto.
