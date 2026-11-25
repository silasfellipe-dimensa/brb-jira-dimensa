-- Rode este script uma vez no SQL Editor do Supabase.
-- Tela "Evidências": relatório de teste no layout Evertec, montado a partir
-- do relatório do Zephyr Essential salvo como .mhtml (ciclo -> casos ->
-- passos -> prints). O relatório lido fica em "dados" (jsonb); os prints vão
-- para o Storage, no bucket privado "evidencias", e cada um tem uma linha em
-- evidencia_imagens.
-- Quem lê e grava é só o servidor (service_role): RLS ligado e nenhuma
-- policy, então a chave pública não enxerga nada - igual às outras tabelas.
-- Remover é lógico (removido = true).

create table if not exists public.evidencias (
  id bigint generated always as identity primary key,
  titulo text not null default '',
  acs text not null default '',            -- 11 dígitos, ex.: 20260630006
  jira text not null default '',           -- task coberta, ex.: JDCBBRB-201
  ambiente text not null default '',
  versao text not null default '',
  observacoes text not null default '',
  ciclo_chave text not null,               -- ex.: JDCBBRB-R9
  ciclo_nome text not null default '',
  resultado text not null default '' check (resultado in ('aprovado', 'reprovado', 'bloqueado', 'incompleto', 'sem_casos', '')),
  total_casos integer not null default 0,
  total_imagens integer not null default 0, -- quantas o relatório pede (as enviadas estão em evidencia_imagens)
  arquivo_nome text not null default '',
  dados jsonb not null,
  removido boolean not null default false,
  criado_por text,
  criado_em timestamptz not null default now(),
  atualizado_por text,
  atualizado_em timestamptz not null default now()
);

create index if not exists evidencias_ativas_idx
  on public.evidencias (criado_em desc) where removido = false;
create index if not exists evidencias_ciclo_idx
  on public.evidencias (ciclo_chave) where removido = false;

create table if not exists public.evidencia_imagens (
  evidencia_id bigint not null references public.evidencias (id),
  ref text not null check (ref ~ '^img[0-9]{1,4}$'),
  caminho text not null,                   -- caminho no bucket "evidencias"
  tipo text not null check (tipo in ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  bytes integer not null,
  enviado_por text,
  enviado_em timestamptz not null default now(),
  primary key (evidencia_id, ref)
);

alter table public.evidencias enable row level security;
alter table public.evidencia_imagens enable row level security;

-- Bucket privado para os prints (sem link público: o servidor entrega a
-- imagem só para quem está logado).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('evidencias', 'evidencias', false, 4194304, array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
on conflict (id) do nothing;
