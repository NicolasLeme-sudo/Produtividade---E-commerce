-- Times de apoio da Black (27/11): 9 Expedição · 10 Corte · 11 Pula · 12 FIFO.
-- Só escalação e pontos manuais (vistoria, gincana, ajuste); não entram na Corrida por peças.
-- Rodar uma vez no SQL Editor do Supabase do Produtividade.
alter table public.competicao_pontos drop constraint if exists competicao_pontos_time_check;
alter table public.competicao_times  drop constraint if exists competicao_times_time_check;
alter table public.competicao_pontos add constraint competicao_pontos_time_check check (time between 1 and 12);
alter table public.competicao_times  add constraint competicao_times_time_check  check (time between 1 and 12);
