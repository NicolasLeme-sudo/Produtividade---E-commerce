/* Gera os PDFs dos times para os líderes da Black: cor, atividades e nomes de cada time.
   Lê a escalação final de dentro do arquivo da Convocação (window.DATA = E-commerce, DATA_DISTR = Distribuidora),
   então os nomes NUNCA ficam gravados no repositório.
   Uso: node docs/black/gerar-lideres.js "C:\Entrega de Arquivos\Missao_Black_2026_Apresentacao_e_Convocacao.html" "C:\Entrega de Arquivos"
   Saída: <pasta>\Times_dos_Lideres.pdf (todos) + <pasta>\Times por lider\<turno>_<fonte>_<lider>.pdf (um por líder).
   Usa o Playwright instalado em robo/ e o Google Chrome. */
"use strict";
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require(path.join(__dirname, "..", "..", "robo", "node_modules", "playwright"));

const origem = process.argv[2];
const destino = process.argv[3] || ".";
if (!origem) { console.error("Informe o arquivo da Convocação."); process.exit(1); }

const CAMPO = { Vermelho: "Checkout", Azul: "Checkout", Verde: "Checkout", Amarelo: "Checkout", Laranja: "Vestuário", Branco: "Vestuário", Roxo: "Colmeia", Rosa: "Colmeia" };
const TURNO = { 1: ["1º Turno", "T01 · 05h00–14h48"], 2: ["2º Turno", "T02 · 14h48–00h16"], 3: ["Administrativo", "ADM · 08h00–17h33"] };
const ORDEM = [["E", 1], ["E", 3], ["D", 1], ["E", 2], ["D", 2]];   // mesma ordem da Convocação
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const nomeCor = c => String(c).replace(/2$/, "");
const limpa = s => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");

function pessoa(p) {
  const tags = (p.t || []).concat(p.a ? ["“" + p.a + "”"] : []);
  return '<li><i class="ck"></i><span>' + esc(p.n) + (tags.length ? ' <small>' + esc(tags.join(" · ")) + "</small>" : "") + "</span></li>";
}
function bloco(titulo, sub, pessoas, cor) {
  if (!pessoas || !pessoas.length) return "";
  return '<div class="bl"><div class="bh"><b>' + esc(titulo) + "</b>" + (sub ? "<em>" + esc(sub) + "</em>" : "") + "<span>" + pessoas.length + "</span></div><ul>" + pessoas.map(pessoa).join("") + "</ul></div>";
}
function totalTime(T) {
  let n = (T.s5 || []).length;
  (T.frentes || []).forEach(F => { n += F.sep.length + F.fat.length; F.fat.forEach(f => { n += f.emb.length; }); });
  (T.colmeia || []).forEach(c => { n += c.p.length; });
  (T.apoio || []).forEach(g => { n += g.p.length; });
  return n;
}
function htmlTime(T, fonte, HEX) {
  const cor = nomeCor(T.cor), hex = HEX[T.cor] || "#999";
  const campo = fonte === "D" ? "Distribuidora · Ressuprimento" : (CAMPO[cor] || (T.meta ? "" : ""));
  const blocos = [];
  (T.frentes || []).forEach(F => {
    blocos.push(bloco("Separação", F.sepLoc || F.loc, F.sep));
    F.fat.forEach((f, i) => {
      const n = F.fat.length > 1 ? " " + (i + 1) : "";
      blocos.push(bloco("Faturista" + n, "conferência" + (F.loc ? " · " + F.loc : ""), [f]));
      blocos.push(bloco("Embalagem" + n, "atende a faturista" + n, f.emb));
    });
  });
  if ((T.s5 || []).length) blocos.push(bloco("Organização / 5S", T.s5[0].loc || "", T.s5));
  (T.colmeia || []).forEach(c => blocos.push(bloco("Colmeia", c.loc, c.p)));
  (T.apoio || []).forEach(g => blocos.push(bloco(g.nome, "", g.p)));
  return '<section class="time" style="--c:' + hex + '"><div class="th"><span class="dot"></span><h2>' +
    (fonte === "D" ? "Distribuidora · " : "") + "Time " + esc(cor) + "</h2>" +
    '<span class="tc">' + esc(campo) + (T.meta && !campo ? esc(T.meta.replace(/^Meta:\s*/i, "")) : "") + "</span>" +
    '<span class="tn">' + totalTime(T) + " pessoas</span></div>" +
    '<div class="grade">' + blocos.join("") + "</div></section>";
}
function htmlLider(g, HEX, logo) {
  const [rot, hr] = TURNO[g.turno];
  const total = g.times.reduce((a, T) => a + totalTime(T), 0);
  const chips = g.times.map(T => '<span class="chip" style="--c:' + (HEX[T.cor] || "#999") + '"><i></i>' + esc(nomeCor(T.cor)) + "</span>").join("");
  return '<div class="pg"><header><img src="' + logo + '" alt=""><div><p class="k">Missão Black Friday 2026 · Times do líder</p><h1>' + esc(g.lider) + '</h1>' +
    '<p class="s">' + esc(rot) + " · " + esc(hr) + " · " + (g.fonte === "D" ? "Distribuidora" : "E-commerce") + '</p></div></header>' +
    '<div class="resumo"><div class="chips">' + chips + '</div><div class="tot"><b>' + total + "</b><span>pessoas nos seus times</span></div></div>" +
    g.times.map(T => htmlTime(T, g.fonte, HEX)).join("") +
    '<footer>Lista para uso da liderança. Confirme a presença na chamada e avise qualquer troca ao gestor do turno.</footer></div>';
}
const CSS = `
@page{size:A4;margin:11mm 12mm}
*{box-sizing:border-box}
body{margin:0;font-family:"Segoe UI",Roboto,Arial,sans-serif;font-size:12.5px;color:#111;line-height:1.35;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.pg{break-after:page}.pg:last-child{break-after:auto}
header{display:grid;grid-template-columns:auto 1fr;gap:14px;align-items:center;border-bottom:2px solid #111;padding-bottom:10px}
header img{width:54px;height:54px;background:#031F44;border-radius:9px;padding:8px}
.k{margin:0 0 3px;font-size:10.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
h1{margin:0;font-size:25px;font-weight:900;line-height:1.1}
.s{margin:3px 0 0;font-size:13px}
.resumo{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:11px 0 4px}
.chips{display:flex;gap:7px;flex-wrap:wrap}
.chip{display:inline-flex;align-items:center;gap:6px;border:1.3px solid #111;border-radius:999px;padding:3px 11px;font-weight:700;font-size:12.5px}
.chip i,.dot{display:inline-block;width:13px;height:13px;border-radius:50%;background:var(--c);border:1.3px solid #111}
.tot{text-align:right;white-space:nowrap}.tot b{font-size:21px;font-weight:900;margin-right:6px}.tot span{font-size:11.5px}
.time{margin-top:12px;border:1.3px solid #111;border-left:8px solid var(--c);border-radius:8px;padding:10px 13px}
.th{display:flex;align-items:center;gap:9px;border-bottom:1px dashed #888;padding-bottom:7px;margin-bottom:8px}
.th h2{margin:0;font-size:17px;font-weight:900}
.tc{font-size:12px;font-weight:600}.tn{margin-left:auto;font-size:12px;font-weight:700}
.grade{display:grid;grid-template-columns:1fr 1fr;gap:9px 16px}
.bl{break-inside:avoid}
.bh{display:flex;align-items:baseline;gap:6px;background:#EDEDED;border-radius:5px;padding:3px 8px;margin-bottom:4px}
.bh b{font-size:12px;text-transform:uppercase;letter-spacing:.04em}.bh em{font-style:normal;font-size:11px}.bh span{margin-left:auto;font-weight:800;font-size:11.5px}
ul{list-style:none;margin:0;padding:0}
li{display:flex;align-items:center;gap:7px;padding:1.5px 2px;font-size:12.5px}
li small{font-size:10.5px}
.ck{flex:none;width:11px;height:11px;border:1.3px solid #111;border-radius:2px}
footer{margin-top:14px;border-top:1px solid #999;padding-top:6px;font-size:10.5px}
`;
function docHtml(corpo) { return '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><style>' + CSS + "</style></head><body>" + corpo + "</body></html>"; }

(async function () {
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  await page.goto(pathToFileURL(path.resolve(origem)).href, { waitUntil: "load" });
  await page.waitForTimeout(500);
  const dados = await page.evaluate(() => ({ E: window.DATA, D: DATA_DISTR, HEX: HEX }));
  const logoB64 = "data:image/png;base64," + fs.readFileSync(path.join(__dirname, "..", "..", "logo-mark.png")).toString("base64");
  // um grupo por (fonte, turno, líder), na ordem da Convocação
  const grupos = [];
  ORDEM.forEach(([fonte, turno]) => {
    const mapa = new Map();
    (dados[fonte] || []).filter(T => T.turno === turno).forEach(T => {
      if (!mapa.has(T.lider)) mapa.set(T.lider, { fonte, turno, lider: T.lider, times: [] });
      mapa.get(T.lider).times.push(T);
    });
    mapa.forEach(g => grupos.push(g));
  });
  fs.mkdirSync(path.join(destino, "Times por lider"), { recursive: true });
  const pdf = async (corpo, arq) => {
    await page.setContent(docHtml(corpo), { waitUntil: "load" });
    await page.pdf({ path: arq, preferCSSPageSize: true, printBackground: true });
  };
  await pdf(grupos.map(g => htmlLider(g, dados.HEX, logoB64)).join(""), path.join(destino, "Times_dos_Lideres.pdf"));
  console.log("ok Times_dos_Lideres.pdf (" + grupos.length + " líderes)");
  for (const g of grupos) {
    const nome = TURNO[g.turno][1].split(" · ")[0] + "_" + (g.fonte === "D" ? "Distribuidora" : "E-commerce") + "_" + limpa(g.lider) + ".pdf";
    await pdf(htmlLider(g, dados.HEX, logoB64), path.join(destino, "Times por lider", nome));
    console.log("ok", nome);
  }
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
