-- Missão Black 2026 — libera as atividades Embalagem (emb), Embarque (exp) e Organização (org) na escalação dos times.
-- Rodar uma vez no SQL Editor do Supabase (projeto vehfchdfbukrbcedciiy). Não apaga nenhum dado.
alter table public.competicao_times drop constraint if exists competicao_times_atividade_check;
alter table public.competicao_times add constraint competicao_times_atividade_check
  check (atividade ~ '^(sep|conf|emb|exp|org)(_colmeia)?$');

-- Conferência: deve mostrar a regra nova.
select conname, pg_get_constraintdef(oid) as regra from pg_constraint where conname = 'competicao_times_atividade_check';
