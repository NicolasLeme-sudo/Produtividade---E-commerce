# CLAUDE.md — Produtividade E-commerce · Telão Black Friday · Robô

Regras gerais de trabalho: `C:\Repositórios\CLAUDE.md` (cópia em `docs/GUIA-NICOLAS.md`). Resumo: plano + modelo antes de editar, PT-BR, economia de créditos, aprovado vai direto para `main`.
Arquitetura detalhada: `README.md`. Site: https://produtividadee-commerce.vercel.app · Supabase `vehfchdfbukrbcedciiy`.

## Arquivos
| Arquivo | Papel |
|---|---|
| `index.html` | Dashboard de Produtividade. Só formata; nunca recalcula regra. ~180 KB: leia por trechos. |
| `ingest.js` | ÚNICO lugar com regra de negócio. Tela de Abastecimento (admin), lê TSV/XLSX, grava `dashboard_snapshots` (outbound, inbound, estoque, reversa). API: `window.ProdutividadeIngest.processar(idDoCard)`. |
| `tv.html` | Telão da Black Friday (27/11/2026, TV 75"). |
| `tv/` | logo-vulcabras.png, moldura-meta-batida.webp, comemoracao.mp3 |
| `corrida/tN.gif` | Carros dos 6 times |
| `robo/` | Robô que envia os relatórios do WMS ao banco sem abrir o site |

## Competição / Corrida Maluca
- Conta em `calcularCompeticao` (index.html), copiada para tv.html. Filtros fixos no telão: último dia, turno Todos, separação+conferência, checkout+colmeia.
- Times: 1 Vermelho `#EF5B5B`, 2 Azul `#4C95F0`, 3 Verde `#45C665`, 4 Amarelo `#F6C400`, 5 Rosa `#EC4FA0`, 6 Roxo `#A773EA`. Times 5 e 6 = colmeia.
- Meta/dia (provisória, falta a oficial): times 1–4 = 2000 peças, 5–6 = 1200. Constante `META_DIA_TIME`.
- Cards abaixo da pista seguem a mesma ordem das posições (`timesOrdemPista`), também no index.html.
- Membros em `competicao_times` (usuario_wms, atividade, turno, time).

## Telão (tv.html)
- Login `@vulcabras.com`; usuário do telão com perfil `gestao` (sessão persistente, `storageKey: telao-produtividade`).
- Telas em rodízio (pula tela sem dado): A Corrida Maluca 120 s · B Separação e Conferência 90 s · D Armazenagem por hora 60 s. **Tela C (Operação agora, em itens) ainda não existe.**
- Dados a cada 60 s; recarrega a página a cada 6 h; wakeLock; setas trocam tela; botão Tela cheia some em tela cheia.
- Selo de atualização: verde < 30 min, âmbar < 2 h, vermelho acima.
- Parâmetros: `?giro=`, `?refresh=`, `?comemorar=N`.
- Comemoração de meta: moldura + card azul translúcido ("META BATIDA!", "Time <Cor>", peças na cor do time) + áudio 25 s bem alto + carro traz o card, estaciona e vai/volta a cada 3 s até sumir. Só cruzamentos do dia; chave `telao_comemorou_<dia>_<n>`; tecla/clique pula.
- Tela B: separação `#297ADF`, conferência `#2EC4B6`; Top 5 de cada. Tela D: `armazenagem.normalHoraDia` (Kardex tem data+hora).
- Faixa inferior (ticker) contínua, quantidades na cor do time.

## Robô (robo/)
- `robo.js` roda o próprio `../ingest.js` num sandbox Node (vm) com navegador falso, faz login com `robo@vulcabras.com` (admin) e chama `processar(id)`. Números idênticos ao site.
- Reconhece o relatório pelas colunas do cabeçalho:

| Relatório | id do card | Colunas-chave |
|---|---|---|
| Separação Analítica | up-separacao-analitica | Usuário, Região Destino, Data/Hora Início, Peças |
| Conferência Analítica | up-conferencia-analitica | Conferênte, Data/Hora Início, Peças |
| Conferência Colmeia | up-conf-colmeia | Operador, Qtde Unitária Montada, Qtde Volumes |
| Kardex | up-kardex-geral | Local, Tipo do Local, Complementar, Estoque Antes, Usuário |
| Acompanhamento OP | up-acompanhamento-op | Pedido de Venda, Status da Nota Fiscal, Classificação Tipo Pedido |
| Itens de NF de Saída | (fase 2) | Chave Acesso NF-e, Barra, Qtde. Faturada |

- Comandos (na pasta robo): `npm.cmd install` · `npm.cmd run teste -- arquivo.tsv` (não grava) · `npm.cmd start` · `npm.cmd run navegador` · `npm.cmd run gravar` (grava cliques no WMS em gravacao.js).
- `iniciar.bat`: git pull + npm install + liga; o robô reinicia a cada 6 h para pegar atualização.
- `.env` (nunca no Git): PROD_EMAIL, PROD_SENHA, PASTA (Downloads), MOVER_ENVIADOS. Enviados vão para `Downloads\telao-enviados`; log `robo.log`.
- Testado com arquivos reais de 26–29/10: 5 relatórios OK.

## Pendências (ordem)
1. Nicolas grava os cliques no WMS (`npm.cmd run gravar`) e troca a senha por `SENHA` no gravacao.js.
2. **Fase B:** `baixar.js` (Playwright, Chrome invisível) exporta a cada 5–10 min (Separação, Conferência, OP a cada 5; Colmeia, Kardex, Itens NF a cada 10) e entrega ao envio. Senha do WMS só no .env; ideal um usuário de WMS próprio do robô. Ver se o login tem captcha/2FA e se a exportação é imediata ou em fila.
3. Agendador de Tarefas do Windows rodando `iniciar.bat` no logon; desligar suspensão do notebook; telão em tela cheia no mesmo notebook.
4. **Fase 2 / Tela C:** Acompanhamento OP × Itens de NF × `dim_embalas` (Report E-commerce), em ITENS: em tela, por etapa, por marca, mais antigo; pizza itens por marca. Resumo compacto gravado no banco do Produtividade.
5. Metas oficiais por time; teste na TV 75"; trocar senhas expostas após a Black.
