-- Rode este script uma vez no SQL Editor do Supabase.
-- Tela "Demandas": solicitacoes em andamento no ACS do BRB (sistema TTB).
--
-- Quem alimenta e o coletor (coletor/coletor-acs.ps1), que roda dentro da rede
-- do BRB e manda a lista para o servidor. O servidor grava aqui com a
-- service_role. Ninguem mais le nem escreve nestas tabelas.

-- Uma linha por solicitacao. A cada coleta a linha e atualizada; quem deixou
-- de vir na lista "em andamento" fica com em_andamento = false (nao e apagada).
create table if not exists public.acs_solicitacoes (
  numero bigint primary key,                 -- SQ_SOLICITACAO
  sistema text not null default '',
  status_codigo text not null,               -- ST_SOLICITACAO (letra)
  status text not null,                      -- DS_STATUS_SOLICITACAO
  resumo text not null default '',
  gestor text not null default '',           -- so o nome; a matricula nao e guardada
  data_solicitacao date,
  previsao_inicio date,
  previsao_termino date,
  data_implantacao date,
  em_andamento boolean not null default true,
  status_desde timestamptz not null default now(),   -- quando vimos o status atual pela 1a vez
  primeira_coleta timestamptz not null default now(),
  ultima_coleta timestamptz not null default now()
);

create index if not exists acs_solicitacoes_em_andamento_idx
  on public.acs_solicitacoes (numero) where em_andamento = true;

-- Cada mudanca de status (e cada entrada/saida da lista), com a data.
create table if not exists public.acs_historico_status (
  id bigint generated always as identity primary key,
  numero bigint not null,
  evento text not null check (evento in ('entrou', 'status', 'saiu', 'voltou')),
  status_anterior text,
  status_novo text,
  quando timestamptz not null default now()
);

create index if not exists acs_historico_status_numero_idx
  on public.acs_historico_status (numero, quando desc);

-- Cada execucao do coletor: deu certo ou nao, quantas vieram, o erro.
-- E daqui que a tela tira o aviso "sem atualizacao ha mais de 1 dia util".
create table if not exists public.acs_coletas (
  id bigint generated always as identity primary key,
  quando timestamptz not null default now(),
  ok boolean not null,
  quantidade integer,
  erro text
);

create index if not exists acs_coletas_quando_idx
  on public.acs_coletas (quando desc);

-- Botao "Atualizar" da tela: fica um pedido aqui ate o coletor atender.
create table if not exists public.acs_pedidos (
  id bigint generated always as identity primary key,
  pedido_por text not null,
  pedido_em timestamptz not null default now(),
  atendido_em timestamptz
);

create index if not exists acs_pedidos_pendentes_idx
  on public.acs_pedidos (pedido_em) where atendido_em is null;

-- Seguranca: RLS ligado e NENHUMA politica = a chave publica (anon) e a de
-- usuario logado (authenticated) nao leem nem escrevem nada. O revoke abaixo
-- e uma segunda tranca: mesmo que alguem crie uma politica por engano, essas
-- duas chaves continuam sem permissao nas tabelas.
alter table public.acs_solicitacoes enable row level security;
alter table public.acs_historico_status enable row level security;
alter table public.acs_coletas enable row level security;
alter table public.acs_pedidos enable row level security;

revoke all on table public.acs_solicitacoes from anon, authenticated;
revoke all on table public.acs_historico_status from anon, authenticated;
revoke all on table public.acs_coletas from anon, authenticated;
revoke all on table public.acs_pedidos from anon, authenticated;

-- O historico e gravado pelo proprio banco (gatilho), como em Demandas: nao
-- depende de o codigo lembrar e nao falha pela metade.
create or replace function public.acs_registrar_historico()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.acs_historico_status (numero, evento, status_novo)
    values (new.numero, 'entrou', new.status);
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

drop trigger if exists acs_historico_trg on public.acs_solicitacoes;
create trigger acs_historico_trg
  before insert or update on public.acs_solicitacoes
  for each row execute function public.acs_registrar_historico();

-- Fases e pontos de funcao (o mesmo que supabase-acs-fases.sql, para quem
-- esta instalando do zero).
alter table public.acs_solicitacoes
  add column if not exists fases jsonb,
  add column if not exists metricas jsonb,
  add column if not exists coordenacao text,
  add column if not exists detalhe_em timestamptz;

-- Confirma o resultado: a listagem abaixo deve vir VAZIA (nenhuma politica).
select tablename, policyname from pg_policies where tablename like 'acs_%';
