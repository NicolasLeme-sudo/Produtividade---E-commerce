-- Missão Black Friday 2026 — pontos lançados à mão e horas de ouro agendadas.
-- Rodar uma vez no SQL Editor do Supabase (projeto vehfchdfbukrbcedciiy).
-- Pontos nunca são editados nem apagados: correção = novo lançamento com o valor inverso (trilha de auditoria).

create table if not exists public.competicao_pontos (
  id uuid primary key default gen_random_uuid(),
  dia date not null,
  turno text not null,
  time smallint not null check (time between 1 and 6),
  categoria text not null check (categoria in ('vistoria', 'desafio', 'ajuste')),
  item text,                       -- item do checklist ou nome do desafio
  pontos integer not null,         -- negativo = desconto
  motivo text,
  registrado_por uuid default auth.uid() references auth.users(id),
  registrado_email text,
  criado_em timestamptz not null default now()
);
create index if not exists competicao_pontos_dia_idx on public.competicao_pontos (dia, turno);
alter table public.competicao_pontos enable row level security;
drop policy if exists pontos_leitura on public.competicao_pontos;
create policy pontos_leitura on public.competicao_pontos for select using (perfil_atual() = any (array['admin', 'gestao']));
drop policy if exists pontos_insercao_admin on public.competicao_pontos;
create policy pontos_insercao_admin on public.competicao_pontos for insert with check (perfil_atual() = 'admin');

create table if not exists public.competicao_hora_ouro (
  id uuid primary key default gen_random_uuid(),
  dia date not null,
  turno text not null,
  hora smallint not null check (hora between 0 and 23),   -- começa em hora:00 e dura 60 min
  meta_piso integer not null,      -- peças na hora, por time do piso
  meta_colmeia integer not null,   -- peças na hora, por time da colmeia
  criado_por uuid default auth.uid() references auth.users(id),
  criado_em timestamptz not null default now(),
  unique (dia, turno, hora)
);
alter table public.competicao_hora_ouro enable row level security;
drop policy if exists ouro_leitura on public.competicao_hora_ouro;
create policy ouro_leitura on public.competicao_hora_ouro for select using (perfil_atual() = any (array['admin', 'gestao']));
drop policy if exists ouro_escrita_admin on public.competicao_hora_ouro;
create policy ouro_escrita_admin on public.competicao_hora_ouro for all using (perfil_atual() = 'admin') with check (perfil_atual() = 'admin');
