-- Rode este script uma vez no SQL Editor do Supabase (depois do supabase-expedicoes.sql).
-- Observacao por item das Expedicoes: texto livre e opcional, em qualquer estado
-- (concluido, pendente ou nao aplicavel). Fica separada do motivo do "nao
-- aplicavel", que continua obrigatorio e visivel na lista.
-- O gatilho do historico passa a registrar tambem quem mexeu na observacao.

alter table public.expedicao_itens
  add column if not exists observacao text,
  add column if not exists observacao_por text,
  add column if not exists observacao_em timestamptz;

alter table public.expedicao_itens drop constraint if exists expedicao_itens_observacao_tam;
alter table public.expedicao_itens
  add constraint expedicao_itens_observacao_tam check (observacao is null or length(observacao) <= 1000);

create or replace function public.expedicao_itens_registrar_historico()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  rot text;
begin
  select nullif(btrim(concat_ws(' - ', nullif(e.artefato_jira, ''), nullif(e.nome, ''), nullif(e.demanda_acs, ''))), '')
    into rot from public.expedicoes e where e.id = new.expedicao_id;

  if tg_op = 'INSERT' then
    -- os itens padrao nascem junto com a expedicao: so o avulso e um fato novo
    if not new.padrao then
      insert into public.expedicoes_historico (expedicao_id, item_id, rotulo, item_texto, acao, usuario)
      values (new.expedicao_id, new.id, rot, new.texto, 'adicionou_item', new.atualizado_por);
    end if;
    return new;
  end if;

  if old.removido is distinct from new.removido and new.removido then
    insert into public.expedicoes_historico (expedicao_id, item_id, rotulo, item_texto, acao, usuario)
    values (new.expedicao_id, new.id, rot, new.texto, 'removeu_item', new.atualizado_por);
  end if;

  if old.estado is distinct from new.estado then
    insert into public.expedicoes_historico (expedicao_id, item_id, rotulo, item_texto, acao, campo, valor_anterior, valor_novo, usuario)
    values (new.expedicao_id, new.id, rot, new.texto, 'alterou', 'estado', old.estado, new.estado, new.atualizado_por);
  end if;

  if old.justificativa is distinct from new.justificativa then
    insert into public.expedicoes_historico (expedicao_id, item_id, rotulo, item_texto, acao, campo, valor_anterior, valor_novo, usuario)
    values (new.expedicao_id, new.id, rot, new.texto, 'alterou', 'justificativa', old.justificativa, new.justificativa, new.atualizado_por);
  end if;

  if old.observacao is distinct from new.observacao then
    insert into public.expedicoes_historico (expedicao_id, item_id, rotulo, item_texto, acao, campo, valor_anterior, valor_novo, usuario)
    values (new.expedicao_id, new.id, rot, new.texto, 'alterou', 'observacao', old.observacao, new.observacao,
            coalesce(new.observacao_por, new.atualizado_por));
  end if;
  return new;
end;
$$;
