-- Rode este script uma vez no SQL Editor do Supabase (depois do supabase-acs.sql
-- e do supabase-acs-fases.sql). Tela "Producao PF".
--
-- O coletor passa a trazer tambem:
--   - as demandas ja implantadas no ultimo ano (com fases e PF), para o historico;
--   - os chamados de sustentacao do TTB (so numero, situacao, datas, quantidade
--     e indicador - sem descricao, solucao nem nomes);
--   - o contrato: o peso de cada fase e a tabela de PF por indicador.
--
-- Pode rodar mais de uma vez. RLS ligado e nenhuma politica, como nas demais.

create table if not exists public.acs_sustentacoes (
  numero bigint primary key,          -- SQ_SUSTENTACAO
  sistema text not null default '',
  situacao integer,                   -- TP_SITUACAO (3 Atendida, 5 Finalizada...)
  abertura timestamptz,
  finalizacao timestamptz,
  quantidade numeric(10,3),
  indicador integer,                  -- SQ_SUSTENTACAO_INDICADOR
  contrato integer,                   -- SQ_CONTRATO
  ultima_coleta timestamptz not null default now()
);

create index if not exists acs_sustentacoes_finalizacao_idx
  on public.acs_sustentacoes (finalizacao);

-- Um contrato por linha: pesos das fases e PF de cada indicador de sustentacao.
create table if not exists public.acs_contratos (
  sq integer primary key,             -- SQ_CONTRATO
  codigo text not null,               -- CD_CONTRATO
  nome text not null default '',
  pesos jsonb not null,               -- {"F1":0,...,"F4":0.3,...}
  indicadores jsonb not null default '[]'::jsonb,  -- [{id, pf, atividade}]
  atualizado_em timestamptz not null default now()
);

alter table public.acs_sustentacoes enable row level security;
alter table public.acs_contratos enable row level security;
revoke all on table public.acs_sustentacoes from anon, authenticated;
revoke all on table public.acs_contratos from anon, authenticated;

-- Historico: uma demanda que ja chega implantada (o coletor traz o passado)
-- nao "entrou" na lista de em andamento - nao registra o evento.
create or replace function public.acs_registrar_historico()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.em_andamento then
      insert into public.acs_historico_status (numero, evento, status_novo)
      values (new.numero, 'entrou', new.status);
    end if;
    return new;
  end if;

  if old.status_codigo is distinct from new.status_codigo then
    new.status_desde := now();
    insert into public.acs_historico_status (numero, evento, status_anterior, status_novo)
    values (new.numero, 'status', old.status, new.status);
  end if;

  if old.em_andamento is distinct from new.em_andamento then
    insert into public.acs_historico_status (numero, evento, status_anterior, status_novo)
    values (new.numero, case when new.em_andamento then 'voltou' else 'saiu' end, old.status, new.status);
  end if;

  return new;
end;
$$;

revoke all on function public.acs_registrar_historico() from public, anon, authenticated;

-- Confirma: as duas tabelas novas, com RLS ligado (rowsecurity = true).
select tablename, rowsecurity from pg_tables
where schemaname = 'public' and tablename in ('acs_sustentacoes', 'acs_contratos');
