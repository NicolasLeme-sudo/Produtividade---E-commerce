# Guia geral — Nicolas Leme · Logística Vulcabras (CD Extrema/MG)

Este arquivo fica em `C:\Repositórios\CLAUDE.md` e vale para qualquer projeto aberto ali dentro.
Cada repositório tem também o seu próprio `CLAUDE.md`, com os detalhes do projeto.

## 1. Como trabalhar comigo (obrigatório)
- **Plano + modelo antes de tudo.** Antes de criar ou editar qualquer arquivo que gaste créditos, mande um plano de alterações com um modelo visual (esboço, tabela ou mockup simples) e espere o meu "ok". Sem exceção.
- **Economia de créditos e memória é prioridade.** Leia só o trecho necessário dos arquivos grandes (index.html e README têm milhares de linhas). Não releia o que já leu.
- **Sempre em produção.** Ajuste aprovado vai direto para `main` (commit + push). A Vercel publica em ~1 min. Eu não olho nada que não esteja em main.
- **Português do Brasil**, direto e estruturado. Comece pelo resultado ou insight principal em até 50 palavras.
- **Postura de analista de dados sênior:** tabelas markdown, sugestão de gráfico quando ajudar, valide premissas, aponte limitações, valores ausentes e vieses. Se o dado for ambíguo, faça perguntas curtas antes.
- **Python/SQL:** código limpo, comentado, com a lógica explicada em passos simples.

## 2. Segurança
- Nunca escreva senhas em arquivos do repositório, commits ou mensagens. Senhas ficam só em `.env` local (já no .gitignore).
- Arquivos do WMS e planilhas têm nomes de colaboradores: só uso local, não enviar a serviços externos.
- Senhas expostas em chat (telão, robô, WMS) devem ser trocadas depois da Black Friday (27/11/2026).

## 3. Mapa dos sistemas
| Projeto | Pasta / repositório | Supabase | Observação |
|---|---|---|---|
| Report E-commerce | `report-ecommerce` | `tawliuofpmfohylqdnix` | Referência de arquitetura e identidade para todos |
| Report DISTR (Distribuidora) | `report-DISTR` | `qaehjplsasumuhszjcnu` | Estoque, embarque, ressuprimento, forecast |
| Produtividade E-commerce + Telão | `Produtividade---E-commerce` | `vehfchdfbukrbcedciiy` | https://produtividadee-commerce.vercel.app · telão em /tv.html |
| Checklist de Setores | `Checklist-CD` | `izqmncxmxkvmsuutbsnl` | React via Babel no navegador |
| Inventário E-commerce | `Inventario---Dashboard` | `juoibcncsehzdelkhcnk` | index.html + gerador.html |
| WMS | Senior Silt | — | https://vulcaprd.seniorcloud.com.br/siltwms/ · exporta `Exportacao_<número>.tsv` |

Todos os sites: HTML estático único, sem build, deploy automático na Vercel a partir de `main`.
Padrão de dados: o navegador (ou robô) lê o arquivo, calcula no `ingest.js` e grava o resultado pronto em `dashboard_snapshots` (uma linha por página, `dados` jsonb). A tela só formata. RLS ligada; perfis em `perfis_acesso` (admin, gestao, ...).

## 4. Identidade visual Vulcabras (vale para sites, PPTX e HTML)
- Skill `identidade-vulcabras`: paleta oficial, Segoe UI, cards, logos (Vulcabras branca, Mizuno, Olympikus, Under Armour). Detalhes completos em `report-ecommerce/README.md` seção 2.
- Tema escuro é o padrão; tema claro alternativo. Botões **"🌙 Tema Escuro" / "☀️ Tema Claro"** (padrão do Inventário).
- **Topbar padrão** em todos os reports: perfil do usuário + Tela cheia + Tema + Sair (classes `.vb-acoes`, `.vb-perfil`, `.vb-btn`; funções `vbTelaCheia`, `vbAtualizaTema`).
- Cores das marcas: Olympikus `#297ADF`, Mizuno `#DFBD41`, Under Armour `#C8102E`.
- Apresentações: skill `apresentacao-html` (HTML único com capa e V minimalista) ou skill `pptx`. Template institucional em `PADRAO-VULCABRAS.md` (report-ecommerce e outros).

## 5. Skills e rotinas recorrentes
| Tema | Como funciona |
|---|---|
| **Embalas** (skill `embalas`) | Junta as abas Mizuno, Olympikus e Under Armour do export HANA numa base única "Embalas" (semanal). É a base `dim_embalas` (codigo_barra, segmento, marca) do Report E-commerce. Última: 27/10, 267.793 linhas. |
| **POP** (skill `pop`) | Procedimento Operacional Padrão em Word + PDF, cabeçalho/rodapé azul-marinho, passos numerados com print e destaque vermelho. POP-004 a POP-012 já feitos. |
| **Apresentação faturamento semanal** | Forecast guardado por mês (outubro usa o forecast de outubro, sem misturar com novembro). |
| **Tabela DISTR volumetria** | Imagem para colar no Outlook, gerada por artefato. |
| **Estoque Armazéns DISTR** | `Mapa-de-Armazens-do-CD.pptx` (6 slides): mapa dos armazéns, tratativas de regularização e cronograma. |
| **Atualização de ativos** | Parser de e-mail extrai setor/gestor/turno para a Base de Ativos. |

## 6. Windows / VS Code
- Use `npm.cmd` e `npx.cmd` (o PowerShell bloqueia `npm.ps1`).
- Caminhos com "Repositórios" sempre entre aspas: `cd "C:\Repositórios\report-ecommerce"`.
- Ferramentas instaladas: Node 26, npm 11, Git 2.56, VS Code.
- Atualizar uma pasta: `git pull origin main`. Subir: `git add -A && git commit -m "..." && git push origin main`.
- Nunca abrir e salvar TSV do WMS no Excel: estraga os acentos do cabeçalho.
