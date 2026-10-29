/* =========================================================================
   ROBÔ DE ENVIO — Produtividade E-commerce · Vulcabras
   -------------------------------------------------------------------------
   Vigia a pasta de downloads. Quando chega um relatório do WMS
   (Exportacao_....tsv), reconhece qual é pelas COLUNAS do cabeçalho e envia
   direto ao banco do Produtividade.

   O cálculo NÃO é reescrito aqui: este programa carrega o próprio ingest.js
   do site e chama a mesma função do botão "Enviar" do Abastecimento. Por isso
   os números são idênticos aos do site, e um ajuste de regra no ingest.js vale
   para os dois.

   Uso:
     npm start                     liga o vigia de pasta
     npm run teste -- ARQUIVO      reconhece e calcula, SEM gravar nada no banco
   ========================================================================= */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const RAIZ = __dirname;
const TESTE = process.argv.includes("--teste");
const ARQ_LOG = path.join(RAIZ, "robo.log");
const ARQ_ESTADO = path.join(RAIZ, "estado.json");
const INTERVALO_MS = 5000;          // a cada 5 s olha a pasta
const EXTENSOES = [".tsv", ".txt", ".xlsx", ".xls", ".xlsb"];

/* ---------------- log ---------------- */
function log(msg) {
  const linha = new Date().toLocaleString("pt-BR") + "  " + msg;
  console.log(linha);
  if (!TESTE) try { fs.appendFileSync(ARQ_LOG, linha + "\n"); } catch (e) {}
}

/* ---------------- configuração (.env simples, sem biblioteca) ---------------- */
function lerEnv() {
  const arq = path.join(RAIZ, ".env"), cfg = {};
  if (!fs.existsSync(arq)) return cfg;
  fs.readFileSync(arq, "utf8").split(/\r?\n/).forEach(function (l) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) cfg[m[1]] = m[2].replace(/^["']|["']$/g, "");
  });
  return cfg;
}

/* ---------------- quais relatórios o robô reconhece (pelas colunas) ---------------- */
// id = o mesmo id do card do Abastecimento no site. "todas" = colunas que precisam existir.
const RELATORIOS = [
  { id: "up-separacao-analitica",   nome: "Separação Analítica",   todas: ["Usuário", "Região Destino", "Data/Hora Início", "Peças"] },
  { id: "up-conferencia-analitica", nome: "Conferência Analítica", todas: ["Conferênte", "Data/Hora Início", "Peças"] },
  { id: "up-conf-colmeia",          nome: "Conferência Colmeia",   todas: ["Operador", "Qtde Unitária Montada", "Qtde Volumes"] },
  { id: "up-kardex-geral",          nome: "Kardex",                todas: ["Local", "Tipo do Local", "Complementar", "Estoque Antes", "Usuário"] },
  { id: "up-acompanhamento-op",     nome: "Acompanhamento OP",     todas: ["Pedido de Venda", "Status da Nota Fiscal", "Classificação Tipo Pedido", "Cancelado Pelo ERP", "Qtde. Total de Produto"] },
];
// Relatórios que o robô conhece mas ainda não envia (vão para o Report E-commerce na fase 2).
const IGNORADOS = [
  { nome: "Itens de NF de Saída", todas: ["Chave Acesso NF-e", "Barra", "Qtde. Faturada"] },
];

function normCol(s) { return String(s || "").replace(/^\uFEFF/, "").trim(); }
function cabecalhoDoArquivo(arq) {
  const ext = path.extname(arq).toLowerCase();
  if (ext === ".tsv" || ext === ".txt") {
    const fd = fs.openSync(arq, "r"), buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    return buf.slice(0, n).toString("utf8").split(/\r?\n/)[0].split("\t").map(normCol);
  }
  const XLSX = require("xlsx");
  const wb = XLSX.readFile(arq, { sheetRows: 1 });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return (XLSX.utils.sheet_to_json(ws, { header: 1 })[0] || []).map(normCol);
}
function identificar(arq) {
  const cab = cabecalhoDoArquivo(arq);
  const tem = function (lista) { return lista.every(function (c) { return cab.indexOf(c) !== -1; }); };
  const r = RELATORIOS.find(function (x) { return tem(x.todas); });
  if (r) return { rel: r, cab: cab };
  const ig = IGNORADOS.find(function (x) { return tem(x.todas); });
  return { ignorado: ig ? ig.nome : null, cab: cab };
}

/* ---------------- carrega o ingest.js do site num "navegador" mínimo ---------------- */
function arquivoComoFile(arq) {
  // Imita o File do navegador, que é o que o ingest.js recebe do <input type=file>.
  return {
    name: path.basename(arq),
    size: fs.statSync(arq).size,
    text: async function () { return fs.readFileSync(arq, "utf8"); },
    arrayBuffer: async function () { const b = fs.readFileSync(arq); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
  };
}
function carregarIngest(modoTeste) {
  const supabaseLib = require("@supabase/supabase-js");
  const inputs = {}, status = {};
  const elementoFalso = function (id) {
    return { id: id, hidden: false, textContent: "", className: "", value: "", innerHTML: "", style: {}, files: inputs[id] ? [inputs[id]] : [],
             set textContent2(v) {}, addEventListener: function () {}, querySelector: function () { return null; }, querySelectorAll: function () { return []; },
             classList: { add: function () {}, remove: function () {}, toggle: function () {} } };
  };
  const documento = {
    getElementById: function (id) {
      if (inputs[id]) return elementoFalso(id);
      if (/-status$/.test(id)) { const el = elementoFalso(id); status[id] = el; return el; }
      return null;
    },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    createElement: function () { return elementoFalso("x"); },
    addEventListener: function () {},
  };
  const janela = { supabase: supabaseLib };
  const ctx = vm.createContext({
    window: janela, document: documento, XLSX: require("xlsx"), console: console,
    localStorage: { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} },
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval,
    fetch: fetch, Headers: Headers, Request: Request, Response: Response, URL: URL, URLSearchParams: URLSearchParams,
    TextEncoder: TextEncoder, TextDecoder: TextDecoder, Blob: Blob, FormData: FormData, AbortController: AbortController,
    CompressionStream: typeof CompressionStream !== "undefined" ? CompressionStream : undefined,
    DecompressionStream: typeof DecompressionStream !== "undefined" ? DecompressionStream : undefined,
    alert: function (m) { log("aviso do ingest: " + m); }, confirm: function () { return true; },
    navigator: { userAgent: "robo-envio" }, location: { href: "robo://", reload: function () {} },
  });
  ctx.globalThis = ctx; ctx.self = ctx;
  const codigo = fs.readFileSync(path.join(RAIZ, "..", "ingest.js"), "utf8");
  vm.runInContext(codigo, ctx, { filename: "ingest.js" });
  const cliente = vm.runInContext("supabaseClient", ctx);
  if (modoTeste) bloquearEscrita(cliente);
  return { ctx: ctx, cliente: cliente, api: janela.ProdutividadeIngest, inputs: inputs, status: status };
}
// Modo teste: lê do banco normalmente, mas nenhuma gravação sai do computador.
function bloquearEscrita(cliente) {
  const fromOriginal = cliente.from.bind(cliente);
  cliente.from = function (tabela) {
    const q = fromOriginal(tabela);
    ["insert", "upsert", "update", "delete"].forEach(function (m) {
      q[m] = function (dados) {
        const resumo = Array.isArray(dados) ? dados.length + " linha(s)" : (dados && dados.pagina ? "página " + dados.pagina + " · " + Object.keys(dados.dados || {}).join(", ") : "1 linha");
        log("   [teste] NÃO gravado: " + m + " em " + tabela + " (" + resumo + ")");
        const vazio = { data: null, error: null, select: function () { return vazio; }, single: function () { return Promise.resolve({ data: null, error: null }); }, then: function (ok) { return Promise.resolve({ data: null, error: null }).then(ok); } };
        return vazio;
      };
    });
    return q;
  };
  if (cliente.storage) cliente.storage.from = function () { return { upload: async function () { log("   [teste] NÃO enviado ao Storage"); return { data: null, error: null }; } }; };
}

/* ---------------- envio de um arquivo ---------------- */
let ingest = null;
async function prepararIngest(cfg) {
  if (ingest) return ingest;
  ingest = carregarIngest(TESTE);
  if (!cfg.PROD_EMAIL || !cfg.PROD_SENHA) throw new Error("Preencha PROD_EMAIL e PROD_SENHA no arquivo .env");
  const r = await ingest.cliente.auth.signInWithPassword({ email: cfg.PROD_EMAIL, password: cfg.PROD_SENHA });
  if (r.error) { ingest = null; throw new Error("Login do robô falhou: " + r.error.message); }
  log("Conectado ao Produtividade como " + cfg.PROD_EMAIL + (TESTE ? " (modo teste: nada será gravado)" : ""));
  return ingest;
}
async function enviar(arq, cfg) {
  const id = identificar(arq);
  if (!id.rel) {
    log((id.ignorado ? "Reconhecido, mas ainda não enviado (fase 2): " + id.ignorado : "Não reconhecido") + " · " + path.basename(arq) + (id.ignorado ? "" : " · colunas: " + id.cab.slice(0, 6).join(" | ")));
    return false;
  }
  const ing = await prepararIngest(cfg);
  log("Enviando " + id.rel.nome + " · " + path.basename(arq) + " (" + Math.round(fs.statSync(arq).size / 1024) + " KB)");
  const t0 = Date.now();
  ing.inputs[id.rel.id] = arquivoComoFile(arq);
  try { await ing.api.processar(id.rel.id); } finally { delete ing.inputs[id.rel.id]; }
  const st = ing.status[id.rel.id + "-status"];
  const msg = st ? st.textContent : "";
  const ok = st && st.className.indexOf("erro") === -1 && /✓/.test(msg);
  log((ok ? "OK " : "ERRO ") + id.rel.nome + " em " + Math.round((Date.now() - t0) / 1000) + " s · " + msg);
  return ok;
}

/* ---------------- vigia de pasta ---------------- */
function lerEstado() { try { return JSON.parse(fs.readFileSync(ARQ_ESTADO, "utf8")); } catch (e) { return {}; } }
function salvarEstado(e) { try { fs.writeFileSync(ARQ_ESTADO, JSON.stringify(e, null, 1)); } catch (x) {} }

async function vigiar(cfg) {
  const pasta = cfg.PASTA;
  if (!pasta || !fs.existsSync(pasta)) throw new Error("Pasta não encontrada: " + pasta + " (confira PASTA no .env)");
  const destino = path.join(pasta, "telao-enviados");
  const mover = String(cfg.MOVER_ENVIADOS || "sim").toLowerCase() !== "nao";
  const inicio = Date.now(), tamanhos = {}, estado = lerEstado();
  let ocupado = false;
  // Reinicia a cada 6 h: o iniciar.bat baixa a versão nova do GitHub e liga de novo.
  setTimeout(function () { log("Reinício programado (6 h) para buscar atualização."); process.exit(0); }, 6 * 3600 * 1000);
  log("Vigiando " + pasta + " · baixe os relatórios do WMS normalmente. Ctrl+C para parar.");
  await prepararIngest(cfg);
  setInterval(async function () {
    if (ocupado) return; ocupado = true;
    try {
      const nomes = fs.readdirSync(pasta).filter(function (n) { return EXTENSOES.indexOf(path.extname(n).toLowerCase()) !== -1; });
      for (const n of nomes) {
        const arq = path.join(pasta, n); let st;
        try { st = fs.statSync(arq); } catch (e) { continue; }
        const chave = n + "|" + st.size + "|" + st.mtimeMs;
        if (st.mtimeMs < inicio - 2 * 60 * 1000 || estado[chave]) continue;     // só arquivos novos (até 2 min antes de ligar)
        if (tamanhos[n] !== st.size) { tamanhos[n] = st.size; continue; }      // ainda baixando: espera o tamanho parar
        estado[chave] = new Date().toISOString(); salvarEstado(estado);
        let ok = false;
        try { ok = await enviar(arq, cfg); } catch (e) { log("ERRO ao enviar " + n + ": " + e.message); }
        if (ok && mover) {
          try { fs.mkdirSync(destino, { recursive: true }); fs.renameSync(arq, path.join(destino, n)); } catch (e) { log("Não consegui mover " + n + ": " + e.message); }
        }
      }
    } catch (e) { log("ERRO no vigia: " + e.message); }
    ocupado = false;
  }, INTERVALO_MS);
}

/* ---------------- início ---------------- */
(async function () {
  const cfg = lerEnv();
  try {
    if (TESTE) {
      const arqs = process.argv.slice(2).filter(function (a) { return a !== "--teste"; });
      if (!arqs.length) { console.log("Uso: npm run teste -- C:\\caminho\\Exportacao_123.tsv"); return; }
      for (const a of arqs) await enviar(path.resolve(a), cfg);
      process.exit(0);
    }
    await vigiar(cfg);
  } catch (e) { log("ERRO: " + e.message); process.exit(1); }
})();
