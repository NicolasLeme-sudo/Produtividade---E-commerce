# Produtividade E-commerce — Vulcabras

Site interno de rastreamento de produtividade do time de armazém: Outbound,
Inbound, Gestão de Estoque e Reversa.

## Arquitetura (3 camadas, nunca misturar)

1. **`ingest.js`** — roda no navegador, só quem tem perfil **Admin** acessa
   a tela que chama (Admin > Abastecimento de base). Lê os arquivos que o
   Admin sobe (TSV/XLSX via SheetJS/XLSX.js), aplica as 14 regras de negócio
   validadas com a operação, e grava o resultado **já calculado** no
   Supabase (`dashboard_snapshots`, `base_ativos`). Nunca renderiza tela.
2. **Supabase (Postgres)** — só guarda o snapshot já calculado. Nenhuma
   lógica de negócio mora no banco (só RLS de controle de acesso).
3. **`index.html`** — só **lê** o snapshot do Supabase e desenha a tela.
   Nunca recalcula regra de negócio, só formata pra exibição. Também
   contém a tela de login (Supabase Auth) e a navegação.

## Supabase

- URL: `https://vehfchdfbukrbcedciiy.supabase.co`
- Anon key: pública por design (protegida por RLS — cada tabela só libera
  o que o perfil do usuário autenticado pode ver).
- Tabelas: `perfis_acesso` (admin | gestao — não existe "operador" neste
  site), `dashboard_snapshots` (uma linha por página: outbound / inbound /
  estoque / reversa, campo `dados` jsonb), `base_ativos` (colaboradores).

## Controle de acesso

- **Admin**: vê tudo, inclusive "Abastecimento de base" e "Base de ativos".
- **Gestão**: vê tudo, menos essas duas telas (leitura total do resto).

## Relatórios que a tela de Abastecimento espera

| Relatório | Alimenta |
|---|---|
| Kardex de Movimentações | Separação Colmeia, Pula, Pendente de fechamento |
| Produtividade de Separação | Separação Checkout |
| Conferência Checkout/Etiqueta | Conferência Checkout |
| Conferência Colmeia | Conferência Colmeia |
| Kardex de Endereço | Armazenagem |
| Gerenciador de OR (geral) | Recebimento |
| Bipagens + Diferença por Local | Inventário (curva real, heatmap) |
| Base Geral Corte/Pula (planilha manual) | Cortes/Pulas atendidos, ranking de agressores |
| Corte em Tela | Cortes em tela |
| Corte Resolvido | Cortes aceitos / no endereço |
| Controle de Nota Fiscal | Cancelamentos WMS |
| Controle de NF Reversa | Integração Reversa |
| Gerenciador de OR - Reversa | Vinculação Reversa |
| Base de Ativos (planilha RH) | `base_ativos` — usuário WMS ↔ colaborador |
| Movimentação de Pallets | Lançamento manual (sem fonte no WMS) |

Usuário do WMS sem cadastro na Base de Ativos nunca é descartado — entra
como "não cadastrado" nos rankings. Expedição ainda não tem fonte
automática (depende do relatório "Acompanhamento Exp").
