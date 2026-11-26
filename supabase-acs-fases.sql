-- Rode este script uma vez no SQL Editor do Supabase (depois do supabase-acs.sql).
-- Tela "Demandas": fases (F1 a F7) e pontos de funcao de cada solicitacao do ACS.
--
-- O coletor busca, para cada demanda, o historico de fases e as contagens de
-- PF no ACS e manda junto com a lista. Nao vem matricula nem nome de quem
-- aprovou: so a fase, a situacao, as datas e o valor da contagem.
--
-- Pode rodar mais de uma vez: so acrescenta o que falta. As tabelas continuam
-- com RLS ligado e sem politica (ver supabase-acs.sql).

alter table public.acs_solicitacoes
  add column if not exists fases jsonb,          -- [{fase, situacao, inclusao, validacao, rejeicao}]
  add column if not exists metricas jsonb,       -- [{pf, tipo, situacao, data, documento}]
  add column if not exists coordenacao text,     -- ex.: GENED, GEOFE
  add column if not exists detalhe_em timestamptz; -- quando fases/PF foram buscados pela ultima vez

-- Confirma: devem aparecer as 4 colunas novas.
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'acs_solicitacoes'
  and column_name in ('fases', 'metricas', 'coordenacao', 'detalhe_em');
