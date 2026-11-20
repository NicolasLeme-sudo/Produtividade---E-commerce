-- Libera a página "config" em dashboard_snapshots (20/11/2026).
-- Sem isso, Admin > "Dias com operação extra" > Salvar falha com:
--   new row for relation "dashboard_snapshots" violates check constraint "dashboard_snapshots_pagina_check"
-- Rode uma vez no SQL Editor do Supabase do Produtividade (projeto vehfchdfbukrbcedciiy). Pode rodar de novo sem problema.
-- Páginas hoje em uso: outbound, inbound, estoque, reversa, operacao (+ config, a nova).

alter table public.dashboard_snapshots drop constraint if exists dashboard_snapshots_pagina_check;

alter table public.dashboard_snapshots
  add constraint dashboard_snapshots_pagina_check
  check (pagina in ('outbound', 'inbound', 'estoque', 'reversa', 'operacao', 'config'));
