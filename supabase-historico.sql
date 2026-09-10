-- Rode uma vez no SQL Editor do Supabase.
--
-- Guarda UMA LINHA POR DIA com a foto do board. A tabela `snapshot` tem uma
-- linha só e e sobrescrita a cada carga: serve para desenhar o board de hoje,
-- mas nao guarda passado nenhum. Sem serie historica nao existe CFD, nao
-- existe burndown e nao existe tendencia - e cada dia sem gravar e um dia de
-- historia perdido para sempre.
--
-- So o resumo, nao o board inteiro: contagem por coluna e por dia e o
-- suficiente para os graficos de fluxo, e mantem a tabela pequena.

create table public.historico (
  dia date primary key,
  dados jsonb not null,
  gravado_em timestamptz not null default now()
);

alter table public.historico enable row level security;

-- Nenhuma policy de propósito: com RLS ligada e sem policy, a chave publica
-- (anon) nao le nem escreve nada aqui. So a service_role, que roda no
-- servidor, enxerga a tabela - mesmo desenho da `snapshot`.
