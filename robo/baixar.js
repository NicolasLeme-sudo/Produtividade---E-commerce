/* =========================================================================
   BAIXAR — exporta os relatórios do WMS sozinho (Google Chrome + Playwright)
   -------------------------------------------------------------------------
   Deixa 6 abas do WMS abertas, uma por relatório, cada uma com seu login e
   com os filtros preenchidos uma vez. A cada ciclo só aperta o botão de
   atualizar da tela e exporta o .tsv para a pasta PASTA. Quem envia ao banco
   é o vigia do robo.js (igual a quando a pessoa baixa na mão).

     Grupo rápido (a cada 5 min):  Separação · Packing Analítico · Colmeia
     Grupo lento  (a cada 10 min): Acompanhamento OP · Itens de NF · Kardex

   Refaz a aba (login + tela + filtros) quando: a data dos filtros muda
   (virada do dia; entre 00h e 01h a data inicial é ontem, por causa do T02),
   o pedido mais antigo do OP muda (Itens de NF) ou dá qualquer erro.

   Uso sozinho (teste):  npm run baixar -- --uma-vez
   Dias passados (preencher buracos, sem enviar):
     npm run baixar -- --uma-vez --de 27/10/2026 --ate 30/10/2026 --so separacao,packing --pasta C:\pasta
   Depois envie com:  node robo.js --enviar C:\pasta\*.tsv
   ========================================================================= */
"use strict";
const fs = require("fs");
const path = require("path");

const URL_WMS = "https://vulcaprd.seniorcloud.com.br/siltwms/";
const MIN = 60 * 1000;
const INTERVALO = { rapido: 5 * MIN, lento: 10 * MIN };
const ESPERA_ATUALIZAR_MS = 45000;   // atualização: Kardex levou 12 s, Colmeia passou de 18 s
const PAUSA_MS = 800;              // pausa entre cada ação: o WMS se perde com cliques rápidos
const ESPERA_ABRIR_MS = 60000;       // 1ª carga da aba (consulta do zero é mais lenta)
const ESPERA_EXPORTAR_MS = 90000;
const PAUSA_LOGIN_FALHOU = 30 * MIN; // não insiste na senha errada (evita bloquear o usuário)
const PASTA_ERROS = path.join(__dirname, "erros");

/* ---------------- datas ---------------- */
function ddmmaaaa(d) {
  return String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear();
}
// --de/--ate (dd/mm/aaaa): baixa um período passado em vez de hoje.
function argumento(nome) { const i = process.argv.indexOf(nome); return i > 0 ? process.argv[i + 1] : null; }
function dataBR(s) { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s || ""); return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null; }
const PERIODO = { de: dataBR(argumento("--de")), ate: dataBR(argumento("--ate")) };
const SO = argumento("--so") ? argumento("--so").split(",") : null;   // só estes relatórios (ids de TELAS)
// Demonstração: --rodadas N (levas seguidas no modo --uma-vez), --mostrar (traz para frente a aba que atualiza),
// --manter-abas (não fecha as abas no fim: o robô reaproveita quando ligar).
const RODADAS = Math.max(1, +argumento("--rodadas") || 1), MOSTRAR = process.argv.includes("--mostrar"), MANTER_ABAS = process.argv.includes("--manter-abas");
function hoje() { return PERIODO.ate || new Date(); }
// Entre 00h e 01h ainda pega o dia anterior (T02 vai até 00h16).
// incluirOntem: na 1ª rodada depois de ligar (modo contínuo), a data inicial é ontem — completa o 2º turno
// do dia anterior, que rodou depois do robô desligar. Da 2ª rodada em diante, só hoje.
let incluirOntem = false;
function inicioDoDia() {
  if (PERIODO.de) return PERIODO.de;
  const d = new Date();
  if (d.getHours() < 1) d.setDate(d.getDate() - 1);
  if (incluirOntem) d.setDate(d.getDate() - 1);
  return d;
}
function hora() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0") + String(d.getSeconds()).padStart(2, "0");
}

/* ---------------- telas do WMS ---------------- */
// busca = o que digitar na busca do menu; item = texto do relatório no menu;
// refresh = botão redondo de 2 setas na barra do grid; filtros(page, estado) preenche a tela.
const ATUALIZAR_GRID = "#DynamicGrid_refresh";
const ATUALIZAR_NAVEGACAO = "#AdvancedNavegationBar_refresh";

async function datasParametros(page, idIni, idFim, ini, fim) {
  await preencher(page, idIni, ddmmaaaa(ini));
  await preencher(page, idFim, ddmmaaaa(fim));
  await page.getByRole("button", { name: "Executar" }).click();
}

const TELAS = [
  { id: "separacao", nome: "Separação", grupo: "rapido", busca: "anali", item: "Produtividade de Separação", refresh: ATUALIZAR_GRID,
    chave: function () { return ddmmaaaa(inicioDoDia()) + "-" + ddmmaaaa(hoje()); },
    filtros: function (p) { return datasParametros(p, "#ParametersDialog_data_inicio", "#ParametersDialog_data_fim", inicioDoDia(), hoje()); } },
  { id: "packing", nome: "Packing Analítico", grupo: "rapido", busca: "anali", item: "Produtividade de Packing Anal", refresh: ATUALIZAR_GRID,
    chave: function () { return ddmmaaaa(inicioDoDia()) + "-" + ddmmaaaa(hoje()); },
    filtros: function (p) { return datasParametros(p, "#ParametersDialog_Data_Inicio", "#ParametersDialog_Data_Fim", inicioDoDia(), hoje()); } },
  { id: "colmeia", nome: "Colmeia", grupo: "rapido", busca: "colmeia", item: "Produtividade Montagem de", refresh: ATUALIZAR_GRID,
    chave: function () { return ddmmaaaa(inicioDoDia()) + "-" + ddmmaaaa(hoje()); },
    filtros: function (p) { return datasParametros(p, "#ParametersDialog_dataInicio", "#ParametersDialog_dataFim", inicioDoDia(), hoje()); } },
  // O Itens de NF vem ANTES do OP: assim, quando o OP chega, a marca dos pedidos novos já está gravada
  // (sem a fatia "Sem marca"). A data inicial do Itens de NF sai do OP anterior.
  { id: "itensnf", nome: "Itens de NF", grupo: "lento", busca: "itens de nf", item: "Itens de NF de Saida", refresh: ATUALIZAR_GRID,
    chave: function (st) { return ddmmaaaa(inicioItensNf(st)) + "-" + ddmmaaaa(hoje()); },
    filtros: function (p, st) { return datasParametros(p, "#ParametersDialog_dataInicio", "#ParametersDialog_dataFim", inicioItensNf(st), hoje()); } },
  { id: "op", nome: "Acompanhamento OP", grupo: "lento", busca: "acompanhamento", item: "Acompanhamento Saida por",
    itemSeletor: '[id$="NavigationView_tree-ItemAcompanhamentoSaidaporNotaFiscal"]', refresh: ATUALIZAR_NAVEGACAO,
    chave: function () { return "30dias"; },
    filtros: async function (p) {
      // A tela já carrega pedidos ao abrir: mexer antes disso dá erro no WMS ("reading 'refresh'").
      for (let t = 1; ; t++) {
        try {
          await esperarCarregar(p, ESPERA_ABRIR_MS);
          await p.getByRole("button", { name: "Período" }).click();
          await p.getByRole("link", { name: "30 dias" }).click();
          await esperarCarregar(p, ESPERA_ABRIR_MS);
          await p.getByRole("button", { name: "Exibir" }).click();
          await p.getByRole("link", { name: "Todas" }).click();
          await esperarCarregar(p, ESPERA_ABRIR_MS);
          if (await fecharAvisoErro(p)) throw new Error("WMS mostrou erro no filtro do OP");
          return;
        } catch (e) {
          await fecharAvisoErro(p);
          await p.keyboard.press("Escape").catch(function () {});
          if (t >= 2) throw e;
          await p.waitForTimeout(3000);
        }
      }
    } },
  { id: "kardex", nome: "Kardex", grupo: "lento", busca: "kardex", item: "Kardex de Endereço", refresh: ATUALIZAR_NAVEGACAO,
    chave: function () { return ddmmaaaa(inicioDoDia()) + "-" + ddmmaaaa(hoje()); },
    filtros: async function (p) {
      // Ao abrir, o WMS mostra sozinho a janela "Seleção de produto": fecha antes do depositante.
      const produto = p.locator('.x-window:visible:has-text("Seleção de produto")');
      try { await produto.first().waitFor({ timeout: 8000 }); } catch (e) {}
      if (await produto.count()) {
        await produto.first().getByRole("button", { name: "Cancelar" }).click();
        await produto.first().waitFor({ state: "hidden", timeout: 10000 }).catch(function () {});
      }
      // Depositante VULCABRAS AZALEIA - SP
      await p.getByRole("button", { name: "Filtrar Depositante" }).click();
      const busca = p.locator("#SearchTriggerWindowRemote_searchTextField:visible");
      await busca.waitFor({ timeout: 15000 });
      await busca.press("Enter");
      await p.getByText("VULCABRAS AZALEIA - SP", { exact: false }).first().click();
      await p.getByRole("button", { name: "Selecionar" }).click();
      // Espera a tela carregar com o depositante; antes disso o filtro de data não é aplicado.
      await p.waitForTimeout(2000);
      await esperarCarregar(p, ESPERA_ABRIR_MS);
      // Período = hoje
      await p.getByRole("button", { name: "Período" }).click();
      await p.getByRole("link", { name: "Período" }).click();
      await preencher(p, "#A_dataInicial", ddmmaaaa(inicioDoDia()));
      await preencher(p, "#A_dataFinal", ddmmaaaa(hoje()));
      await p.getByRole("button", { name: "Salvar" }).click();
      await p.waitForTimeout(2000);
      await esperarCarregar(p, ESPERA_ABRIR_MS);
    } },
];

// Itens de NF começa no dia do pedido mais antigo em tela no último OP baixado.
function inicioItensNf(st) {
  const d = st.maisAntigoOp ? new Date(st.maisAntigoOp) : new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const ini = inicioDoDia();
  return d < ini ? d : ini;
}

/* ---------------- ações na página ---------------- */
async function preencher(page, seletor, valor) {
  const campo = page.locator(seletor + ":visible").first();
  await campo.waitFor({ timeout: 20000 });
  await campo.fill(valor);
  if ((await campo.inputValue()) !== valor) {      // reserva: seleciona tudo e digita
    await campo.click({ clickCount: 3 });
    await campo.pressSequentially(valor);
  }
  await campo.press("Tab");
}

class ErroLogin extends Error {}

async function login(page, cfg) {
  const usuario = page.locator("#LoginDialog_loginText");
  const senha = page.locator("#LoginDialog_passwordText");
  // A tela do WMS às vezes não carrega na 1ª vez: tenta até 3 vezes.
  for (let t = 1; ; t++) {
    try {
      if (t === 1) await page.goto(URL_WMS, { waitUntil: "load", timeout: 60000 });
      else await page.reload({ waitUntil: "load", timeout: 60000 });
      await usuario.waitFor({ timeout: 40000 });
      break;
    } catch (e) {
      if (t >= 3) throw new Error("Tela de login do WMS não abriu (3 tentativas): " + e.message.split("\n")[0]);
    }
  }
  await page.bringToFront();                       // aba em segundo plano não aceita o Enter
  // Digita tecla por tecla (o WMS só libera o "Entrar" com digitação de verdade).
  async function digitar(campo, texto) {
    await campo.click();
    await campo.press("Control+A");
    await campo.press("Delete");
    await campo.pressSequentially(texto, { delay: 40 });
  }
  const entrar = page.getByRole("button", { name: "Entrar" }).first();
  for (let t = 1; t <= 3; t++) {
    await digitar(usuario, cfg.WMS_USUARIO);
    await digitar(senha, cfg.WMS_SENHA);
    await page.waitForTimeout(500);
    if ((await usuario.inputValue()) === cfg.WMS_USUARIO && await entrar.isEnabled().catch(function () { return false; })) break;
  }
  await entrar.click({ timeout: 10000 });
  // Pode aparecer um aviso com "OK" (ex.: sessão anterior aberta): confirma e entra de novo.
  const ok = page.getByRole("button", { name: "OK", exact: true });
  try {
    await ok.or(page.getByRole("button", { name: "Sim", exact: true })).first().waitFor({ timeout: 5000 });
    await ok.or(page.getByRole("button", { name: "Sim", exact: true })).first().click();
    await senha.fill(cfg.WMS_SENHA);
    await page.getByRole("button", { name: "Entrar" }).click();
  } catch (e) { /* sem aviso */ }
  // Logado = a caixa de login some.
  try {
    await usuario.waitFor({ state: "hidden", timeout: 30000 });
  } catch (e) {
    // Guarda print e a mensagem que o WMS mostrou, para saber o motivo real.
    let msg = "";
    try { msg = (await page.locator(".x-window-body:visible, .ext-mb-text:visible, .x-window-mc:visible").allInnerTexts()).join(" | ").replace(/\s+/g, " ").slice(0, 200); } catch (x) {}
    try { fs.mkdirSync(PASTA_ERROS, { recursive: true }); await page.screenshot({ path: path.join(PASTA_ERROS, hora() + "_login.png") }); } catch (x) {}
    throw new ErroLogin("Login no WMS não passou" + (msg ? " · WMS disse: " + msg : " (usuário/senha do .env?)"));
  }
}

// Caixa de busca do menu: o id muda a cada sessão (x-auto-NNN-input).
async function buscaDoMenu(page) {
  const candidatos = page.locator('input[id^="x-auto-"][id$="-input"]:visible');
  await candidatos.first().waitFor({ timeout: 30000 });
  return candidatos.first();
}

async function abrirTela(page, tela) {
  await page.bringToFront();
  const busca = await buscaDoMenu(page);
  const item = tela.itemSeletor
    ? page.locator(tela.itemSeletor + ":visible").first()
    : page.getByText(tela.item).first();
  // Digita devagar e confirma com Enter: sem o Enter o WMS não carrega as sugestões.
  for (let t = 1; ; t++) {
    await busca.click();
    await busca.fill("");
    await busca.pressSequentially(tela.busca, { delay: 60 });
    await busca.press("Enter");
    try { await item.waitFor({ timeout: 20000 }); break; }
    catch (e) { if (t >= 2) throw new Error("Tela \"" + (tela.item || tela.busca) + "\" não apareceu no menu"); }
  }
  await item.click();
  await page.waitForTimeout(4000);                 // deixa a tela montar antes dos filtros
}

// Fecha o aviso "Problema ao executar operação" do WMS, se estiver na tela. Devolve true se fechou.
async function fecharAvisoErro(page) {
  const aviso = page.locator('.x-window:visible:has-text("Problema ao executar")');
  if (!(await aviso.count())) return false;
  await aviso.first().getByRole("button", { name: "OK" }).click().catch(function () {});
  return true;
}

// Espera a máscara de "carregando" do grid sumir (até 18 s).
async function esperarCarregar(page, limite) {
  const mascara = page.locator(".x-mask-loading:visible, .ext-el-mask-msg:visible, .x-mask-msg:visible");
  try { await mascara.first().waitFor({ timeout: 2500 }); } catch (e) { await page.waitForTimeout(1500); return; }
  await mascara.first().waitFor({ state: "hidden", timeout: limite || ESPERA_ATUALIZAR_MS });
}

async function exportar(page, tela, pasta) {
  await page.locator("#ExportGridPlugin_exportButton:visible").first().click();
  const download = page.waitForEvent("download", { timeout: ESPERA_EXPORTAR_MS });
  await page.getByRole("link", { name: "Separado por Tabulações .tsv" }).click();
  const d = await download;                        // só espera o download COMEÇAR
  const final = path.join(pasta, "Exportacao_" + tela.id + "_" + hora() + ".tsv");
  const temp = final + ".parcial";                 // o vigia só olha .tsv: não pega pela metade
  // O arquivo termina de baixar em 2º plano enquanto o robô já vai para a próxima aba.
  // Embrulhado num objeto: se voltasse a promessa direto, o await de quem chama esperaria o download inteiro.
  return { salvo: d.saveAs(temp).then(function () { fs.renameSync(temp, final); return final; }) };
}

async function printErro(page, tela) {
  try {
    fs.mkdirSync(PASTA_ERROS, { recursive: true });
    await page.screenshot({ path: path.join(PASTA_ERROS, hora() + "_" + tela.id + ".png") });
  } catch (e) {}
}

/* ---------------- robô ---------------- */
async function iniciar(cfg, log, opcoes) {
  opcoes = opcoes || {};
  if (!cfg.WMS_USUARIO || !cfg.WMS_SENHA) throw new Error("Preencha WMS_USUARIO e WMS_SENHA no arquivo .env");
  if (!cfg.PASTA || !fs.existsSync(cfg.PASTA)) throw new Error("Pasta não encontrada: " + cfg.PASTA + " (confira PASTA no .env)");
  const { chromium } = require("playwright");
  // MOSTRAR_NAVEGADOR=nao no .env (ou --escondido): o Chrome do robô abre sem janela nenhuma (headless).
  const visivel = String(cfg.MOSTRAR_NAVEGADOR || "sim").toLowerCase() !== "nao" && !process.argv.includes("--escondido");
  // INTERVALO_MIN no .env: todos os relatórios a cada N minutos (sem ele: rápidos a cada 5, lentos a cada 10).
  const nMin = Number(cfg.INTERVALO_MIN) || 0;
  const intervalo = nMin > 0 ? { rapido: nMin * MIN, lento: nMin * MIN } : INTERVALO;
  // Usa SÓ o Chrome aberto pelo atalho "abrir-chrome-robo.bat" (porta 9222). Nunca abre outro Chrome.
  // Só um baixador por vez (dois disputam o Chrome e os downloads).
  const trava = path.join(__dirname, "baixar.lock");
  try {
    const pid = Number(fs.readFileSync(trava, "utf8"));
    if (pid && pid !== process.pid) { process.kill(pid, 0); throw new Error("Já tem um baixador rodando (processo " + pid + ")"); }
  } catch (e) { if (/Já tem/.test(e.message)) throw e; }
  fs.writeFileSync(trava, String(process.pid));
  process.on("exit", function () { try { if (fs.readFileSync(trava, "utf8") === String(process.pid)) fs.unlinkSync(trava); } catch (e) {} });
  const porta = cfg.CHROME_PORTA || "9222";
  // Uma "alça" (page) por relatório: é por ela que o robô volta em cada aba.
  const abas = {};          // id -> { page, chave }
  let browser, contexto, caiu = false;

  // Liga no Chrome do atalho. Se a janela estiver fechada, o próprio robô roda o atalho e espera.
  async function conectar() {
    let tentouAbrir = false;
    for (;;) {
      try {
        browser = await chromium.connectOverCDP("http://127.0.0.1:" + porta, { timeout: 15000, slowMo: PAUSA_MS });
        contexto = browser.contexts()[0] || await browser.newContext();
        break;
      } catch (e) {
        if (!tentouAbrir) {
          tentouAbrir = true;
          log("Abrindo o Chrome do robô (atalho abrir-chrome-robo.bat" + (visivel ? ")" : ", escondido: sem janela)"));
          require("child_process").spawn("cmd.exe", ["/c", path.join(__dirname, "abrir-chrome-robo.bat")].concat(visivel ? [] : ["escondido"]), { detached: true, stdio: "ignore", windowsHide: true }).unref();
          await new Promise(function (r) { setTimeout(r, 6000); });
          continue;
        }
        log("Chrome do robô não abriu (tento de novo em 1 min)");
        if (opcoes.umaVez) throw new Error("Chrome do robô não abriu");
        tentouAbrir = false;
        await new Promise(function (r) { setTimeout(r, 60000); });
      }
    }
    caiu = false;
    browser.on("disconnected", function () { caiu = true; });
    // Reaproveita as abas do robô que já estão abertas (cada uma guarda em window.name o relatório
    // e o filtro): ao religar, o robô só volta a recarregar com o botão, sem fechar nem logar de novo.
    // Fecha só abas do WMS sem marca ou repetidas (deixa 1 aba aberta).
    for (const id in abas) delete abas[id];
    const sobras = [];
    for (const pg of contexto.pages()) {
      if (!/siltwms/.test(pg.url())) continue;
      let nome = ""; try { nome = await pg.evaluate(function () { return window.name; }); } catch (e) {}
      const m = /^robo\|([^|]+)\|(.*)$/.exec(nome || "");
      if (m && TELAS.some(function (t) { return t.id === m[1]; }) && !abas[m[1]]) abas[m[1]] = { page: pg, chave: m[2] || null };
      else sobras.push(pg);
    }
    if (sobras.length && sobras.length === contexto.pages().length) await contexto.newPage();
    for (const pg of sobras) { try { await pg.close(); } catch (e) {} }
    const reaproveitadas = Object.keys(abas);
    log("Baixador ligado no Chrome do atalho, WMS como " + cfg.WMS_USUARIO + (reaproveitadas.length ? " · reaproveitando " + reaproveitadas.length + " aba(s) abertas" : "") +
      (nMin > 0 ? " · atualiza a cada " + nMin + " min" : "") + (visivel ? "" : " · Chrome escondido"));
  }
  await conectar();
  const doUsuario = true;
  // No Chrome do usuário só fecha as abas do robô; nunca o navegador.
  async function fechar() {
    if (!doUsuario) return browser.close();
    for (const id in abas) try { await abas[id].page.close(); } catch (e) {}
  }

  const st = { maisAntigoOp: null, pausaAte: 0 };
  // Itens de NF reaproveitado: a data inicial do filtro dele vira o "pedido mais antigo" até o próximo OP.
  if (abas.itensnf && abas.itensnf.chave) { const d = dataBR(abas.itensnf.chave.split("-")[0]); if (d) st.maisAntigoOp = d.getTime(); }

  async function prepararAba(tela) {
    let aba = abas[tela.id];
    if (!aba || aba.page.isClosed()) aba = abas[tela.id] = { page: await contexto.newPage(), chave: null };
    aba.chave = null;
    st.passo = "login"; await login(aba.page, cfg);
    st.passo = "abrir a tela pelo menu"; await abrirTela(aba.page, tela);
    st.passo = "preencher os filtros"; await tela.filtros(aba.page, st);
    st.passo = "esperar carregar"; await esperarCarregar(aba.page, ESPERA_ABRIR_MS);
    st.passo = "exportar";
    aba.chave = tela.chave(st);
    // marca a aba (sobrevive ao recarregar): é por ela que o robô reaproveita a aba quando religa
    await aba.page.evaluate(function (n) { window.name = n; }, "robo|" + tela.id + "|" + aba.chave).catch(function () {});
    log("   aba " + tela.nome + " pronta (filtro " + aba.chave + ")");
  }

  const pendentes = new Set();   // downloads terminando em 2º plano
  async function rodar(tela) {
    if (Date.now() < st.pausaAte) return;
    const t0 = Date.now();
    let aba = abas[tela.id];
    try {
      const caiu = aba && !aba.page.isClosed() && (await aba.page.locator("#LoginDialog_loginText:visible").count()) > 0;
      if (!aba || aba.page.isClosed() || caiu || aba.chave !== tela.chave(st)) {
        if (caiu) log("   aba " + tela.nome + ": sessão do WMS caiu, entrando de novo");
        await prepararAba(tela);
        aba = abas[tela.id];
      } else {
        st.passo = "atualizar";
        if (MOSTRAR) await aba.page.bringToFront();   // só na demonstração (--mostrar)
        // Sem bringToFront: no Windows ele puxa a janela do Chrome para frente e não deixa minimizar.
        // A aba atualiza e exporta em segundo plano (o Chrome do robô abre sem a economia de abas ocultas).
        await aba.page.locator(tela.refresh + ":visible").first().click();
        await esperarCarregar(aba.page);
      }
      const salvo = (await exportar(aba.page, tela, cfg.PASTA)).salvo;
      const fim = salvo.then(function (arq) {
        pendentes.delete(fim);
        log("Baixado " + tela.nome + " em " + Math.round((Date.now() - t0) / 1000) + " s · " + path.basename(arq));
        return arq;
      }, function (e) { pendentes.delete(fim); log("ERRO ao salvar " + tela.nome + ": " + e.message.split("\n")[0]); return null; });
      pendentes.add(fim);
      // Só o OP espera o arquivo: a data inicial do Itens de NF sai dele. Os outros seguem em 2º plano.
      if (tela.id === "op" && opcoes.maisAntigoOp) {
        const arq = await fim;
        if (arq) {
          try {
            const ms = await opcoes.maisAntigoOp(arq);
            if (ms) st.maisAntigoOp = ms;
          } catch (e) { log("   não li o pedido mais antigo do OP: " + e.message); }
        }
      }
    } catch (e) {
      aba = abas[tela.id];
      if (aba && !aba.page.isClosed()) await printErro(aba.page, tela);
      if (aba) aba.chave = null;     // no próximo ciclo refaz a aba
      if (e instanceof ErroLogin) {
        st.pausaAte = Date.now() + PAUSA_LOGIN_FALHOU;
        log("ERRO " + e.message + " · tento de novo em 30 min");
      } else {
        log("ERRO ao baixar " + tela.nome + " (passo: " + (st.passo || "?") + "): " + e.message.split("\n")[0]);
      }
    }
  }

  async function grupo(nome) {
    if (SO) { for (const tela of TELAS) if (tela.grupo === nome && SO.indexOf(tela.id) !== -1) await rodar(tela); return; }
    // Janela do Chrome do robô fechou no meio: abre de novo e refaz as abas.
    if (caiu || !browser.isConnected()) {
      log("Chrome do robô fechou, abrindo de novo");
      await conectar();
    }
    for (const tela of TELAS) if (tela.grupo === nome) await rodar(tela);
  }

  if (opcoes.umaVez) {
    for (let r = 1; r <= RODADAS; r++) {
      if (RODADAS > 1) log("=== " + r + "ª leva" + (r === 1 ? ": abrir as abas e exportar" : ": passar pelas abas, recarregar e exportar") + " ===");
      await grupo("rapido");
      await grupo("lento");
      await Promise.all(Array.from(pendentes));  // espera os downloads em 2º plano
    }
    if (!MANTER_ABAS) await fechar();
    return;
  }
  const proximo = { rapido: 0, lento: 0 };
  incluirOntem = !PERIODO.de;
  if (incluirOntem) log("1ª rodada: de ontem até hoje (completa o 2º turno de ontem); as próximas, só hoje");
  for (;;) {
    for (const g of ["rapido", "lento"]) {          // rápido tem prioridade
      if (Date.now() >= proximo[g]) {
        proximo[g] = Date.now() + intervalo[g];
        await grupo(g);
      }
    }
    incluirOntem = false;                           // as duas levas da 1ª rodada já foram
    await new Promise(function (r) { setTimeout(r, 5000); });
  }
}

module.exports = { iniciar: iniciar };

/* ---------------- uso sozinho: npm run baixar -- --uma-vez ---------------- */
if (require.main === module) {
  const robo = require("./robo");
  const cfg = robo.lerEnv();
  if (argumento("--pasta")) { cfg.PASTA = argumento("--pasta"); fs.mkdirSync(cfg.PASTA, { recursive: true }); }
  iniciar(cfg, robo.log, { umaVez: process.argv.includes("--uma-vez"), maisAntigoOp: robo.maisAntigoOp })
    .then(function () { process.exit(0); })
    .catch(function (e) { robo.log("ERRO: " + e.message); process.exit(1); });
}
