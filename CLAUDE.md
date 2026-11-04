# CLAUDE.md — Produtividade E-commerce · Telão Black Friday · Robô

Regras gerais de trabalho: `C:\Repositórios\CLAUDE.md` (cópia em `docs/GUIA-NICOLAS.md`). Resumo: plano + modelo antes de editar, PT-BR, economia de créditos, aprovado vai direto para `main`.
Arquitetura detalhada: `README.md`. Site: https://produtividadee-commerce.vercel.app · Supabase `vehfchdfbukrbcedciiy`.

## Arquivos
| Arquivo | Papel |
|---|---|
| `index.html` | Dashboard de Produtividade. Só formata; nunca recalcula regra. ~180 KB: leia por trechos. |
| `ingest.js` | ÚNICO lugar com regra de negócio. Tela de Abastecimento (admin), lê TSV/XLSX, grava `dashboard_snapshots` (outbound, inbound, estoque, reversa). API: `window.ProdutividadeIngest.processar(idDoCard)`. |
| `tv.html` | Telão da Black Friday (27/11/2026, TV 75"). |
| `tv/` | logo-vulcabras-cor.png (topo do telão; V colorido), logo-vulcabras.png, moldura-meta-batida.webp, comemoracao.mp3 |
| `corrida/tN.gif` | Carros dos 6 times |
| `robo/` | Robô que envia os relatórios do WMS ao banco sem abrir o site |

## Competição / Corrida Maluca
- Conta em `calcularCompeticao` (index.html, com os filtros da tela). Versão de filtros fixos em `RegrasBlack.calcularCompeticao` (regras-black.js), usada pelo telão e pela planilha de pontos. Filtros fixos: último dia, turno Todos, separação+conferência, checkout+colmeia.
- Times: 1 Vermelho `#EF5B5B`, 2 Azul `#4C95F0`, 3 Verde `#45C665`, 4 Amarelo `#F6C400`, 5 Rosa `#EC4FA0`, 6 Roxo `#A773EA`. Times 5 e 6 = colmeia.
- Meta/dia (provisória, falta a oficial): times 1–4 = 2000 peças, 5–6 = 1200. Constante `META_DIA_TIME`.
- Cards abaixo da pista seguem a mesma ordem das posições (`timesOrdemPista`), também no index.html.
- Membros em `competicao_times` (usuario_wms, atividade, turno, time, presenca jsonb). Planilha de escalação: **uma aba por time com o nome da cor** (Vermelho…Roxo, + aba Legenda ignorada); colunas Nome, Usuário WMS, Atividade (**S**, **C** ou **C/S** = uma linha por pessoa; no banco C/S vira 2 registros sep+conf), Turno, Piso, Observação, Líder, 27/11, 28/11, 29/11 (P/F/A; atestado = F). Formato antigo (1 aba com coluna Time) ainda é aceito. "Exportar times atuais" gera o arquivo no formato novo.

## Missão Black (27–29/11) — pontuação
- **Valores só em `regras-black.js`** (`window.RegrasBlack`): 1 pt/peça; meta batida +200; antecipada +100 por hora trabalhada antes do fim do turno contando os minutos, sem o almoço (T01 11h30–12h30, ADM 12h15–13h15, T02 janta 18h40–19h40: `TURNOS[].almoco`), sem teto (minuto da meta: `minutoDaMeta` em regras-black.js, pela Data/Hora Fim das analíticas gravada por minuto nos 4 dias mais recentes + `conferencia.colmeiaMarcas` gravadas a cada envio da Conferência Colmeia); hora de ouro = peças da hora 2× se bater a meta da hora; assiduidade 500 × presentes ÷ escalados (atestado = falta, atraso −20); desafios até 300/dia (100 cada); vistoria checklist leve −20 / média −50 / grave −100 / gravíssima −200, sem apontamento +100; destaque +50 (top sep. e top conf. do turno, por grupo); Trinca Perfeita +200 no acumulado. Colmeia: fixos ×0,6.
- Turnos: T01 05h00–14h48 · T02 14h48–00h16 (depois da meia-noite ainda é o dia anterior) · ADM 07h55–17h33. Times por turno: a escalação filtra pelo turno.
- Tabelas: `competicao_pontos` (vistoria/desafio/ajuste, só insert; correção = estorno) e `competicao_hora_ouro` (agendada; telão mostra faixa dourada com contagem só durante a hora). SQL em `sql/black_pontos.sql`. Só admin lança.
- Lançamento: Admin com menu por setor (Compartilhados, Outbound, Movimentação, Gestão de Estoque, Times da competição, Vistoria, Ajustes = Gincanas + Ajuste de pontuação + Horas de Ouro lado a lado, Base de ativos; ids `adm-*`). Pontos em 4 cartões (`renderPontosBlack`): Vistoria e Ajuste por time; **Gincana lança o mesmo valor para os 6 times** (colmeia ×0,6); lista = desafios do dia + `RegrasBlack.GINCANAS` + Outra. Telas do Admin sem texto explicativo (pedido 03/11). Botão "Extrair Descontos e Adições" (`extrairPontosBlack`): .xlsx com abas Times, Acumulado, Colaboradores, Lançamentos e Horas de ouro (dias da Black passados × turnos; antes da Black, prévia do dia/turno dos seletores). **Sem placar no telão** (decisão 03/11): o telão só mostra a faixa dourada durante a hora de ouro.

## Pastas e entregas da Black
- Arquivos que o Nicolas manda para eu ler: `C:\Leitura de Arquivos`. Entregas que eu gero: `C:\Entrega de Arquivos`.
- Apresentação à coordenação (6 slides, sem telão): `docs/black/apresentacao.html` → `python docs/black/embutir.py "C:/Entrega de Arquivos/Missao_Black_Apresentacao.html"`.
- Para imprimir: `docs/black/checklist-vistoria.html` (2 fichas por A4) e `docs/black/regras.html` (3 págs.) → `node docs/black/gerar-pdfs.js "C:\Entrega de Arquivos"`.
- Demonstração de meta batida no telão: `tv.html?comemorar=N` (N = time).

## Telão (tv.html)
- Login `@vulcabras.com`; usuário do telão com perfil `gestao` (sessão persistente, `storageKey: telao-produtividade`).
- Telas em rodízio, nesta ordem (pula tela sem dado): C Operação agora 90 s · A Corrida Maluca 120 s (times do turno do horário) · B Separação e Conferência 90 s · E Expedição 90 s · D Armazenagem por hora 60 s.
- Troca de tela com transição (sai esmaecendo 0,35 s, entra deslizando 0,7 s); barra do giro contínua (requestAnimationFrame).
- Pista: largada 4 %, chegada 93 %; meta batida põe o carro em `P_META_BATIDA` = 1,06 (passa um pouco da linha).
- Tela C: lê só `dados->resumo` do snapshot `operacao` (gravado pelo ingest.js com Acompanhamento OP + Itens de NF de Saída). Itens por etapa × marca (etapas iguais ao `calcularStatus` do Report), pizza por marca, mais antigo em tela, importados há 2+ dias úteis (mesma regra do Report E-commerce: `diferencaDiasUteis`, seg–sex sem `FERIADOS_2026` de Extrema-MG; atualizar a lista todo ano). Marca: palavra-chave no nome do produto (regra do Report + "UNDER"); sem palavra-chave, base **Embalas** (Artigo → MARCA, card `up-embalas`, gravada em `operacao.embalas`); sem as duas, Olympikus. O Itens de NF guarda a marca dos pedidos em operação + os ainda abertos (status ≠ PROCESSADA/CANCELADO), e o robô baixa o Itens de NF antes do OP: não aparece mais a fatia "Sem marca". Cores: Olympikus `#297ADF`, Mizuno `#DFBD41`, Under Armour `#C8102E`.
- Dados a cada 60 s; recarrega a página a cada 6 h; wakeLock; setas trocam tela; botão Tela cheia some em tela cheia.
- Selo de atualização: verde < 30 min, âmbar < 2 h, vermelho acima.
- Parâmetros: `?giro=`, `?refresh=`, `?comemorar=N`, `?dia=aaaa-mm-dd`.
- **Dia mostrado:** padrão = dia operacional de hoje (`RegrasBlack.diaOperacional`: 00h–01h ainda é ontem). **Tela sem dado hoje mostra o último dia com dado** (`diaComFallback`, cada tela decide; Corrida/B/faixa juntas por `diaOutbound`), com "⚠ Sem dados de hoje" em amarelo à esquerda do "Dado de…" e os títulos "em dd/mm"; volta sozinha para hoje na 1ª peça. Clicar na data embaixo do relógio (calendário próprio no padrão Vulcabras: card escuro com os detalhes na cor da tela aberta — `COR_CAL`: Operação azul, Corrida vermelho, Separação e Conferência turquesa, Expedição amarelo, Armazenagem laranja; ponto = dia com produção) ou setas ↑/↓ escolhe outro dia; selo âmbar "EXIBINDO …" + botão Voltar para hoje; volta sozinho após 30 min. Dia passado: Tela C sai do giro, previsão vira "dia encerrado", sem comemoração/hora de ouro. Nunca cai em dia antigo: sem dado = 0.
- Comemoração de meta: moldura + card azul translúcido ("META BATIDA!", "Time <Cor>", peças na cor do time) + áudio 25 s bem alto + carro traz o card, estaciona e vai/volta a cada 3 s até sumir. Só cruzamentos do dia; chave `telao_comemorou_<dia>_<n>`; tecla/clique pula.
- Tela B (5 cards): Separado · Conferido · **Separado sem conferir** (OP: ENVIADO PARA FATURAMENTO sem "Conferido em", `operacao.resumo.semConferir`) · Previsão separação · Previsão conferência. Cores: separação `#297ADF`, conferência `#2EC4B6`; Top 5 de cada. Tela D: realizado do dia + Previsão do dia; `armazenagem.normalHoraDia` (Kardex tem data+hora). Tela C: colunas com título Itens | Pedidos.
- **Previsão** (`previsaoDoDia` no ingest.js, gravada em `separacao/conferencia/armazenagem.previsao` e `operacao.expPrev` a cada envio): realizado + média por hora das horas completas de hoje (sem almoço 11h30–12h30 e janta 18h40–19h40) × horas trabalhadas que faltam até 00h16. **Nesta hora** (`previsaoDaHora`, campo `nestaHora`, card "nesta hora (HHh)"): feito na hora + média por minuto × minutos trabalhados que faltam na hora; com menos de 10 min trabalhados na hora, a média é a dos últimos 15 min. Minutos: analítico (Data/Hora Fim), Kardex (Data). Menos de 1 h de produção hoje: dia anterior no mesmo horário. Conferência: curva do checkout, colmeia na proporção de hoje.
- Faixa inferior (ticker) contínua, quantidades na cor do time.
- **Tela E · Expedição** (tons de amarelo: `#F6BD00` / `#FCE38A`): embarque = Kardex Tipo do Local DOCA + Complementar `NOTA FISCAL PROCESSADA, RETIRADO ESTOQUE PARA NOTAFISCAL ID:<id>` (id = `idNotaFiscal` do Itens de NF; 1 nota = 1 pedido). Vale o último evento da nota (estorno `PROCESSAMENTO DE NOTA FISCAL ESTORNADO`/cancelamento depois = não conta); usuário, minuto e peças desse evento. Itens de NF dá transportadora e SINGLE (checkout)/MULTI (colmeia); a nota passa de `EM CARGA/OR` para `PROCESSADA` ao embarcar. Tudo no snapshot `operacao`: `expNfs` (notas cruas dos 2 dias mais recentes, cada Kardex junta), `expDias` (resumo congelado, 31 dias), `nfInfo` (EM CARGA/OR + embarcadas), `resumo.expedicao` (o telão lê). Usuário SILT conta no total, fora do Top 5. Card **Conferido sem expedição** (foto do OP, `operacao.resumo.semColeta`): status FATURADO com "Faturado em" e coluna Carga vazia, em itens, Checkout (SINGLE) · Colmeia (MULTI). Conferido em 03/11: 7.357 pedidos, 8.582 peças.

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
| Itens de NF de Saída | up-itens-nf-saida | Chave Acesso NF-e, Pedido de Venda, Produto, Barra, Qtde. Faturada |
| Embalas (base de embalagem, semanal) | up-embalas | SKU, Artigo, MARCA — o robô envia quando o arquivo muda em Downloads e **não move** o arquivo |

- Comandos (na pasta robo): `npm.cmd install` · `npm.cmd run teste -- arquivo.tsv` (não grava) · `npm.cmd start` · `npm.cmd run baixar -- --uma-vez` (baixa os 6 uma vez, sem enviar; `--de dd/mm/aaaa --ate dd/mm/aaaa --so separacao,packing --pasta C:\x` baixa dias passados — o Kardex também aceita período: testado em 04/11 com `--de 03/11/2026 --ate 04/11/2026 --so kardex`; depois reenvie um Kardex só de hoje para o Pendente de fechamento voltar ao dia) · `node robo.js --enviar a.tsv b.tsv` (envia arquivos escolhidos) · `npm.cmd run gravar` (grava cliques no WMS em gravacao.js; a gravação começa sozinha ao abrir).
- Playwright usa o Google Chrome instalado (`channel: 'chrome'`), sem baixar Chromium.
- **Liga/desliga só na mão:** `ligar-robo.bat` (git pull + npm install + liga uma vez, janela preta "Robo do Telao") · `desligar-robo.bat` (ou fechar a janela / Ctrl+C). Sem reinício automático nem laço; erro no baixador tenta de novo em 1 min dentro do processo. Pelo terminal: `cd robo` + `npm.cmd start`. Se a janela do Chrome do robô fechar, ele reabre pelo `abrir-chrome-robo.bat` e refaz as abas. Ao religar, **reaproveita as 6 abas abertas** (cada uma marcada em `window.name` = `robo|<id>|<filtro>`): só recarrega com o botão, sem fechar nem logar. Ciclo: recarrega e exporta a aba em segundo plano, **sem `bringToFront`** (ele puxava a janela e não deixava minimizar); só login/abrir tela traz a aba para frente. `abrir-chrome-robo.bat` abre o Chrome com `--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding` (abas funcionam minimizado). **Nunca conectar outro Playwright/CDP ao Chrome do robô** (porta 9222): isso troca a pasta de download dele e o saveAs falha até religar.
- `.env` (nunca no Git): PROD_EMAIL, PROD_SENHA, PASTA (Downloads), MOVER_ENVIADOS, MOSTRAR_NAVEGADOR, WMS_USUARIO, WMS_SENHA (preenchidos = o robô também baixa). Enviados vão para `Downloads\telao-enviados`; log `robo.log`.
- Testado com arquivos reais de 26–29/10: 5 relatórios OK.

## Pendências (ordem)
1. ~~Gravar os cliques no WMS~~ ✅ 29/10: `robo/gravacao.js` (fora do Git) tem login + 6 exportações .tsv. Achados: login sem captcha/2FA; download imediato (sem fila); botão `#ExportGridPlugin_exportButton` → link "Separado por Tabulações .tsv". Relatórios no menu: Produtividade de Separação, Produtividade de Packing Analítico (= Conferência), Produtividade Montagem de (Colmeia), Kardex de Endereço (depositante VULCABRAS AZALEIA - SP + aba Período), Acompanhamento Saida por Nota Fiscal (Período 30 dias, Todas), Itens de NF de Saida. IDs `#x-auto-NNN` mudam a cada sessão: trocar por texto/role no baixar.js.
2. **Fase B** (código pronto em 30/10, falta validar 20 min seguidos): `baixar.js` deixa **6 abas do WMS** no Google Chrome (cada uma com login próprio; o robô guarda a referência de cada aba), filtros preenchidos uma vez; no ciclo só clica no atualizar da tela (`#DynamicGrid_refresh` em Separação/Packing/Colmeia/Itens NF, `#AdvancedNavegationBar_refresh` em OP/Kardex), espera a máscara de carregando sumir (até 18 s) e exporta para PASTA como `Exportacao_<relatorio>_<hora>.tsv`. Rápido a cada 5 min: Separação, Packing (= Conferência), Colmeia. Lento a cada 10 min: OP, Itens de NF, Kardex. Refaz a aba na virada do dia (00h–01h a data inicial é ontem, por causa do T02), quando o pedido mais antigo do OP muda (Itens NF começa nesse dia; regra em `ProdutividadeIngest.maisAntigoOp`) ou em erro (print em `robo/erros/`). Login que falha pausa 30 min. Ligado pelo `robo.js` quando `WMS_USUARIO` está no .env. Usuário WMS: nicolas.leme.
3. (Opcional) Agendador de Tarefas rodando `ligar-robo.bat` no logon; desligar suspensão do notebook; telão em tela cheia no mesmo notebook.
4. **Tela C** ✅ feita em 29/10 (tv.html + ingest.js + robô). Página `operacao` liberada em `dashboard_snapshots` em 30/10 (CHECK `dashboard_snapshots_pagina_check`). A tela só entra no giro depois do primeiro envio do Acompanhamento OP (+ Itens de NF para as marcas).
5. Metas oficiais por time; teste na TV 75"; trocar senhas expostas após a Black.
