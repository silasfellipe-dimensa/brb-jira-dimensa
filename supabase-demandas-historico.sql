-- Rode este script uma vez no SQL Editor do Supabase (depois do supabase-demandas.sql).
-- Historico completo da tela "Demandas e Pontos de Funcao": cada criacao,
-- cada campo alterado (valor anterior -> valor novo) e cada exclusao, com
-- quem fez e quando.
--
-- Quem grava e o proprio banco (gatilho), nao o aplicativo: assim o registro
-- nao depende de o codigo lembrar de gravar, nao falha pela metade e pega ate
-- uma correcao feita direto no SQL Editor. O usuario vem da coluna
-- atualizado_por, que o servidor preenche em toda gravacao.
-- A exclusao continua logica (removido = true): a linha nunca sai da tabela.

create table if not exists public.demandas_pf_historico (
  id bigint generated always as identity primary key,
  demanda_id bigint not null,
  mes text,
  demanda_acs text,            -- foto do numero ACS na hora do evento
  nome text,                   -- foto do nome na hora do evento
  acao text not null check (acao in ('criou', 'alterou', 'removeu', 'restaurou')),
  campo text,                  -- so em 'alterou'
  valor_anterior text,
  valor_novo text,
  usuario text,
  quando timestamptz not null default now()
);

create index if not exists demandas_pf_historico_demanda_idx
  on public.demandas_pf_historico (demanda_id, quando desc);
create index if not exists demandas_pf_historico_quando_idx
  on public.demandas_pf_historico (quando desc);

alter table public.demandas_pf_historico enable row level security;
-- O servidor usa a service_role. Nao ha acesso publico direto.

create or replace function public.demandas_pf_registrar_historico()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  nome_campo text;
  antes jsonb;
  depois jsonb;
begin
  if tg_op = 'INSERT' then
    insert into public.demandas_pf_historico (demanda_id, mes, demanda_acs, nome, acao, usuario)
    values (new.id, new.mes, new.demanda_acs, new.nome, 'criou', coalesce(new.criado_por, new.atualizado_por));
    return new;
  end if;

  antes := to_jsonb(old);
  depois := to_jsonb(new);

  if old.removido is distinct from new.removido then
    insert into public.demandas_pf_historico (demanda_id, mes, demanda_acs, nome, acao, usuario)
    values (new.id, new.mes, new.demanda_acs, new.nome,
            case when new.removido then 'removeu' else 'restaurou' end, new.atualizado_por);
  end if;

  foreach nome_campo in array array[
    'demanda_acs', 'artefato_jira', 'nome', 'pontos_total', 'em_analise',
    'pontos_documentacao', 'pontos_desenvolvimento', 'pontos_teste', 'pontos_implantacao',
    'inicio_atendimento', 'conclusao_prevista', 'previsao_expedicao', 'observacoes'
  ] loop
    -- so entra o que mudou de verdade: sair de um campo sem alterar nao gera registro
    if antes ->> nome_campo is distinct from depois ->> nome_campo then
      insert into public.demandas_pf_historico
        (demanda_id, mes, demanda_acs, nome, acao, campo, valor_anterior, valor_novo, usuario)
      values (new.id, new.mes, new.demanda_acs, new.nome, 'alterou', nome_campo,
              antes ->> nome_campo, depois ->> nome_campo, new.atualizado_por);
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists demandas_pf_historico_trg on public.demandas_pf;
create trigger demandas_pf_historico_trg
  after insert or update on public.demandas_pf
  for each row execute function public.demandas_pf_registrar_historico();
