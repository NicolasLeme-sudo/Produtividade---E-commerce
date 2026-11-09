-- Missão Black 2026 — libera os times 07 (Laranja) e 08 (Branco), do vestuário.
-- Rodar uma vez no SQL Editor do Supabase (projeto vehfchdfbukrbcedciiy). Não apaga nenhum dado.
do $$
declare r record;
begin
  for r in
    select conrelid::regclass as tabela, conname
    from pg_constraint
    where contype = 'c'
      and conrelid::regclass::text in ('competicao_pontos', 'competicao_times')
      and pg_get_constraintdef(oid) ilike '%time%between%'
  loop
    execute format('alter table %s drop constraint %I', r.tabela, r.conname);
  end loop;
end $$;

alter table public.competicao_pontos add constraint competicao_pontos_time_check check (time between 1 and 8);
alter table public.competicao_times  add constraint competicao_times_time_check  check (time between 1 and 8);
