-- Pontos da Black (28/11): o admin pode APAGAR e EDITAR lançamentos (antes só inserir; correção era por estorno).
-- editado_em: o telão usa para mostrar o balão de "Edição" mesmo em lançamento de outro dia/turno.
-- Rodar uma vez no SQL Editor do Supabase (projeto vehfchdfbukrbcedciiy).
alter table public.competicao_pontos add column if not exists editado_em timestamptz;

drop policy if exists pontos_alteracao_admin on public.competicao_pontos;
create policy pontos_alteracao_admin on public.competicao_pontos for update
  using (perfil_atual() = 'admin') with check (perfil_atual() = 'admin');

drop policy if exists pontos_exclusao_admin on public.competicao_pontos;
create policy pontos_exclusao_admin on public.competicao_pontos for delete
  using (perfil_atual() = 'admin');
