-- Rode este script uma vez no SQL Editor do Supabase.
-- Acrescenta o MES (competencia, "AAAA-MM") a tabela demandas_pf que ja existe.
-- A entrega e mensal e cada mes tem registros novos: a mesma demanda pode
-- aparecer em varios meses, uma linha em cada.
--
-- Pode rodar mais de uma vez sem estragar nada.

alter table public.demandas_pf add column if not exists mes text;

-- Linhas criadas antes desta mudanca ficam no mes em que foram criadas
-- (horario de Brasilia). Depois e so ajustar, se algum estiver no mes errado.
update public.demandas_pf
   set mes = to_char(criado_em at time zone 'America/Sao_Paulo', 'YYYY-MM')
 where mes is null;

alter table public.demandas_pf alter column mes set not null;

alter table public.demandas_pf drop constraint if exists demandas_pf_mes_formato;
alter table public.demandas_pf
  add constraint demandas_pf_mes_formato check (mes ~ '^\d{4}-(0[1-9]|1[0-2])$');

create index if not exists demandas_pf_mes_idx
  on public.demandas_pf (mes) where removido = false;
