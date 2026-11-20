-- Banco do REPORT E-commerce (projeto tawliuofpmfohylqdnix), NAO o do Produtividade. Criado em 20/11/2026.
-- Saldo de abertura da Expedição ("conferido sem expedição" no começo do dia operacional), usado pelo telão da Black para a
-- meta da Expedição (97% de conferido do dia + este saldo). tv.html: carregarSaldoExp / calcularExpedicao.
--
-- Dia operacional começa às 01h BRT = 04h UTC (as colunas de pedidos estão em UTC). Saldo = pedidos conferidos antes da
-- abertura (até 8 dias antes), sem cancelados, que (a) nunca foram processados ou (b) só foram processados depois da abertura.
--
-- Por que a tabela de cache: o perfil anon do Supabase tem statement_timeout de 3 s. Calculado a cada chamada, com o cache do
-- banco frio, passava disso (erro 57014; o telão mostrou "Saldo —"). O saldo de abertura não muda no dia, então a função
-- guarda o resultado (a partir das 03h BRT, quando o dado de abertura já assentou) e as chamadas seguintes leem uma linha.
-- Para recalcular um dia: delete from public.expedicao_saldo_dia where dia = 'aaaa-mm-dd';

create index concurrently if not exists idx_pedidos_proc_nulo_conf
  on public.pedidos (conferido_em) include (qtd_total_produto, cancelado_pelo_erp) where processado_em is null;
create index concurrently if not exists idx_pedidos_processado_cob
  on public.pedidos (processado_em) include (conferido_em, qtd_total_produto, cancelado_pelo_erp);
-- (idx_pedidos_conferido_em_cob foi da 1ª versão da função e ficou sem uso: pode ser removido com drop index concurrently.)

create table if not exists public.expedicao_saldo_dia (
  dia date primary key,
  pecas bigint not null,
  pedidos bigint not null,
  calculado_em timestamptz not null default now()
);
alter table public.expedicao_saldo_dia enable row level security;                 -- sem política: só a função (security definer) acessa
revoke all on table public.expedicao_saldo_dia from anon, authenticated;

create or replace function public.produtividade_expedicao_saldo(dia date)
returns json
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare
  v_ini timestamp := dia::timestamp + interval '4 hours';   -- 01h BRT = 04h UTC
  v_p bigint;
  v_n bigint;
begin
  select e.pecas, e.pedidos into v_p, v_n from public.expedicao_saldo_dia e where e.dia = produtividade_expedicao_saldo.dia;
  if not found then
    select coalesce(sum(s.q), 0)::bigint, count(*)::bigint into v_p, v_n from (
      select p.qtd_total_produto as q
        from public.pedidos p
       where p.processado_em is null
         and p.conferido_em <  v_ini and p.conferido_em >= v_ini - interval '8 days'
         and coalesce(p.cancelado_pelo_erp, false) = false
      union all
      select p.qtd_total_produto
        from public.pedidos p
       where p.processado_em >= v_ini
         and p.conferido_em <  v_ini and p.conferido_em >= v_ini - interval '8 days'
         and coalesce(p.cancelado_pelo_erp, false) = false
    ) s;
    if (now() at time zone 'utc') >= dia::timestamp + interval '6 hours' then
      insert into public.expedicao_saldo_dia as t (dia, pecas, pedidos) values (produtividade_expedicao_saldo.dia, v_p, v_n)
        on conflict on constraint expedicao_saldo_dia_pkey do nothing;
    end if;
  end if;
  return json_build_object('dia', dia, 'pecas', v_p, 'pedidos', v_n);
end
$$;

grant execute on function public.produtividade_expedicao_saldo(date) to anon, authenticated;
