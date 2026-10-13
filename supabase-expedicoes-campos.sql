-- Rode este script uma vez no SQL Editor do Supabase (depois do supabase-expedicoes.sql).
--
-- 1) Campo PF (pontos de funcao) em cada expedicao. Opcional.
-- 2) O gatilho do historico passa a registrar tambem a mudanca do PF.
-- 3) Itens novos no "antes de comitar": Descricao, Documentos de Configuracao e
--    Solucao (sao itens do checklist, nao campos de texto). O "Solucao
--    preenchida" que ficava no "antes de expedir" MUDA para o "antes de comitar"
--    (mesmo item, com o estado e a observacao que ja tinha), para nao ficar
--    duplicado. Vale tambem para as expedicoes que ja existem; rodar de novo nao
--    duplica nada. Expedicoes novas ja nascem com a lista atualizada pelo codigo.

alter table public.expedicoes
  add column if not exists pontos_funcao numeric(8,2);

alter table public.expedicoes drop constraint if exists expedicoes_pf_valor;
alter table public.expedicoes
  add constraint expedicoes_pf_valor check (pontos_funcao is null or pontos_funcao >= 0);

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
    insert into public.expedicoes_historico (expedicao_id, rotulo, acao, usuario)
    values (new.id, rot, case when new.removido then 'removeu' else 'criou' end, new.atualizado_por);
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

-- "Solucao preenchida" sai do antes de expedir e vai para o antes de comitar
update public.expedicao_itens i
   set bloco = 'comitar', texto = 'Solução preenchida?'
 where i.padrao and not i.removido
   and i.bloco = 'expedir' and i.texto = 'Solução preenchida'
   and not exists (
     select 1 from public.expedicao_itens x
      where x.expedicao_id = i.expedicao_id and x.texto = 'Solução preenchida?' and not x.removido
   );

-- itens que ainda faltam nas expedicoes existentes
insert into public.expedicao_itens (expedicao_id, bloco, texto, padrao, atualizado_por)
select e.id, 'comitar', t.texto, true, 'sistema (ajuste da lista)'
  from public.expedicoes e
 cross join (values
   ('Descrição preenchida?'),
   ('Documentos de Configuração preenchidos?'),
   ('Solução preenchida?')
 ) as t(texto)
 where not e.removido
   and not exists (
     select 1 from public.expedicao_itens x
      where x.expedicao_id = e.id and x.texto = t.texto and not x.removido
   );
