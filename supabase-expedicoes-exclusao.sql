-- Rode este script uma vez no SQL Editor do Supabase (depois do supabase-expedicoes.sql).
-- Motivo da exclusão de uma expedição (pedido de 2026-11-19): ao excluir,
-- quem exclui explica por quê. O motivo fica na própria expedição e, pelo
-- gatilho abaixo, também no histórico (expedicoes_historico) - então não se
-- perde quando a expedição é restaurada.
-- Pode rodar de novo sem problema.

alter table public.expedicoes add column if not exists motivo_exclusao text;

-- Mesmo gatilho de supabase-expedicoes-campos.sql (que já acompanha o PF),
-- agora guardando também o motivo no evento "removeu".
create or replace function public.expedicoes_registrar_historico()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  nome_campo text;
  antes jsonb;
  depois jsonb;
  rot text;
begin
  rot := nullif(btrim(concat_ws(' - ', nullif(new.artefato_jira, ''), nullif(new.nome, ''), nullif(new.demanda_acs, ''))), '');

  if tg_op = 'INSERT' then
    insert into public.expedicoes_historico (expedicao_id, rotulo, acao, usuario)
    values (new.id, rot, 'criou', coalesce(new.criado_por, new.atualizado_por));
    return new;
  end if;

  if old.removido is distinct from new.removido then
    insert into public.expedicoes_historico (expedicao_id, rotulo, acao, valor_novo, usuario)
    values (new.id, rot, case when new.removido then 'removeu' else 'criou' end,
            case when new.removido then new.motivo_exclusao end, new.atualizado_por);
  end if;

  antes := to_jsonb(old);
  depois := to_jsonb(new);
  foreach nome_campo in array array[
    'artefato_jira', 'nome', 'demanda_acs', 'data_expedicao', 'responsavel', 'pontos_funcao'
  ] loop
    if antes ->> nome_campo is distinct from depois ->> nome_campo then
      insert into public.expedicoes_historico (expedicao_id, rotulo, acao, campo, valor_anterior, valor_novo, usuario)
      values (new.id, rot, 'alterou', nome_campo, antes ->> nome_campo, depois ->> nome_campo, new.atualizado_por);
    end if;
  end loop;
  return new;
end;
$$;
