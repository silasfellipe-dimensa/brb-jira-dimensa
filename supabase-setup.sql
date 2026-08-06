-- Rode isso uma vez no SQL Editor do Supabase (menu lateral esquerdo).
-- Cria uma "tabela" com uma unica linha, que guarda o snapshot mais
-- recente do board. Substitui o data/snapshot.json que usavamos localmente
-- (nao serve pra Vercel, o disco nao persiste la).

create table public.snapshot (
  id int primary key default 1,
  dados jsonb not null,
  atualizado_em timestamptz not null default now(),
  constraint somente_uma_linha check (id = 1)
);

insert into public.snapshot (id, dados)
values (1, '{"vazio": true, "erro": "Ainda não foi feita nenhuma carga.", "colunas": [], "pessoas": {}}'::jsonb);

alter table public.snapshot enable row level security;

-- A chave anon (a que usamos no servidor) so consegue ler e atualizar essa
-- tabela especifica - nao da acesso a nada mais no banco.
create policy "leitura do snapshot" on public.snapshot for select using (true);
create policy "escrita do snapshot" on public.snapshot for update using (true);
