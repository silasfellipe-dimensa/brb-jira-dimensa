-- Rode este script uma vez no SQL Editor do Supabase.
-- Tela "Expedicoes": checklist do time para nao esquecer nada antes de
-- comitar e antes de expedir. Cada expedicao tem Jira, nome, ACS, data de
-- expedicao e uma lista de itens (os padroes do time + os avulsos de cada
-- demanda). Cada item fica pendente, concluido ou nao aplicavel (este
-- ultimo exige o motivo).
-- Remover e logico (removido = true), e um gatilho grava quem fez o que e
-- quando (tabela expedicoes_historico), igual ao historico de Demandas.

create table if not exists public.expedicoes (
  id bigint generated always as identity primary key,
  artefato_jira text not null default '',
  nome text not null default '',
  demanda_acs text not null default '',
  data_expedicao date,
  responsavel text not null default '',   -- foto do responsavel do Jira na criacao (o atual vem do quadro)
  removido boolean not null default false,
  criado_por text,
  criado_em timestamptz not null default now(),
  atualizado_por text,
  atualizado_em timestamptz not null default now()
);

create index if not exists expedicoes_ativas_idx
  on public.expedicoes (data_expedicao) where removido = false;

create table if not exists public.expedicao_itens (
  id bigint generated always as identity primary key,
  expedicao_id bigint not null references public.expedicoes (id),
  bloco text not null check (bloco in ('comitar', 'expedir')),
  texto text not null,
  padrao boolean not null default true,   -- false = item avulso, o unico que pode ser removido
  estado text not null default 'pendente' check (estado in ('pendente', 'concluido', 'nao_aplicavel')),
  justificativa text,
  removido boolean not null default false,
  atualizado_por text,
  atualizado_em timestamptz not null default now(),
  -- "nao aplicavel" sempre com motivo; os outros estados nunca guardam motivo
  constraint expedicao_itens_motivo check (
    (estado = 'nao_aplicavel' and length(btrim(coalesce(justificativa, ''))) >= 10)
    or (estado <> 'nao_aplicavel' and justificativa is null)
  )
);

create index if not exists expedicao_itens_exp_idx
  on public.expedicao_itens (expedicao_id) where removido = false;

create table if not exists public.expedicoes_historico (
  id bigint generated always as identity primary key,
  expedicao_id bigint not null,
  item_id bigint,
  rotulo text,                 -- foto "Jira - nome" na hora do evento
  item_texto text,
  acao text not null check (acao in ('criou', 'alterou', 'removeu', 'adicionou_item', 'removeu_item')),
  campo text,
  valor_anterior text,
  valor_novo text,
  usuario text,
  quando timestamptz not null default now()
);

create index if not exists expedicoes_historico_exp_idx on public.expedicoes_historico (expedicao_id, quando desc);
create index if not exists expedicoes_historico_quando_idx on public.expedicoes_historico (quando desc);

alter table public.expedicoes enable row level security;
alter table public.expedicao_itens enable row level security;
alter table public.expedicoes_historico enable row level security;
-- O servidor usa a service_role. Nao ha acesso publico direto.

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
  foreach nome_campo in array array['artefato_jira', 'nome', 'demanda_acs', 'data_expedicao', 'responsavel'] loop
    if antes ->> nome_campo is distinct from depois ->> nome_campo then
      insert into public.expedicoes_historico (expedicao_id, rotulo, acao, campo, valor_anterior, valor_novo, usuario)
      values (new.id, rot, 'alterou', nome_campo, antes ->> nome_campo, depois ->> nome_campo, new.atualizado_por);
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists expedicoes_historico_trg on public.expedicoes;
create trigger expedicoes_historico_trg
  after insert or update on public.expedicoes
  for each row execute function public.expedicoes_registrar_historico();

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
  return new;
end;
$$;

drop trigger if exists expedicao_itens_historico_trg on public.expedicao_itens;
create trigger expedicao_itens_historico_trg
  after insert or update on public.expedicao_itens
  for each row execute function public.expedicao_itens_registrar_historico();
