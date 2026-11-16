/* Prévia dos e-mails por hora, num HTML no padrão Vulcabras (não envia nada).
   Uso:  node previa-email.js [aaaa-mm-dd] [pasta de saída]
   A prévia tem nome de colaborador: sai em C:\Entrega de Arquivos, nunca no repositório. */
"use strict";
const fs = require("fs");
const path = require("path");
const E = require("./email");
const robo = require("./robo");

const RAIZ = path.join(__dirname, "..");
function diaOperacional(d) { d = new Date(d); if (d.getHours() < 1) d.setDate(d.getDate() - 1); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function png64(rel) { return "data:image/png;base64," + fs.readFileSync(path.join(RAIZ, rel)).toString("base64"); }

async function cliente(cfg) {
  const ing = fs.readFileSync(path.join(RAIZ, "ingest.js"), "utf8");
  const url = /SUPABASE_URL\s*=\s*"([^"]+)"/.exec(ing)[1], key = /SUPABASE_ANON_KEY\s*=\s*"([^"]+)"/.exec(ing)[1];
  const sb = require("@supabase/supabase-js").createClient(url, key);
  const { error } = await sb.auth.signInWithPassword({ email: cfg.PROD_EMAIL, password: cfg.PROD_SENHA });
  if (error) throw new Error("login: " + error.message);
  return sb;
}

(async function () {
  const cfg = robo.lerEnv();
  const dia = (process.argv[2] || "").match(/^\d{4}-\d{2}-\d{2}$/) ? process.argv[2] : diaOperacional(new Date());
  const saida = process.argv[3] || "C:\\Entrega de Arquivos";
  const sb = await cliente(cfg);
  const q = await sb.from("dashboard_snapshots").select("pagina, dados").in("pagina", ["outbound", "inbound", "operacao"]);
  if (q.error) throw q.error;
  const pg = {}; (q.data || []).forEach(function (l) { pg[l.pagina] = l.dados || {}; });
  const out = pg.outbound || {}, inb = pg.inbound || {}, op = pg.operacao || {};

  // peças por usuário e hora de cada atividade
  const sep = E.analiticoPorUsuario((out.separacao || {}).analitico, dia, ["checkout", "colmeia"]);
  const conf = E.somarEm(E.analiticoPorUsuario((out.conferencia || {}).analitico, dia, ["checkout"]), E.colmeiaPorUsuario(out.conferencia, dia));
  const exp = E.expedicaoPorUsuario(op, dia);
  const arm = E.armazenagemPorUsuario(inb, dia);

  // nomes pela Base de ativos (mesma resolução do site); a armazenagem já vem com o nome
  const usuarios = Array.from(new Set([].concat(Object.keys(sep), Object.keys(conf), Object.keys(exp))));
  const ing = await robo.prepararIngest(cfg);
  const nomes = await ing.api.resolverNomes(usuarios);

  const tSep = E.porTurno(sep, nomes, "T01"), tConf = E.porTurno(conf, nomes, "T01"), tExp = E.porTurno(exp, nomes, "T01");
  const tArm = E.porTurno(arm, null, "ADM");
  const C = E.CORES;

  // Um e-mail = um bloco; cada atividade num cartão (demarcação entre setores)
  const EMAILS = [
    { id: "out-t01", tit: "Outbound · T01", tabelas: [["Separado", tSep.T01, C.sep], ["Conferido", tConf.T01, C.conf], ["Expedido", tExp.T01, C.exp]] },
    { id: "out-t02", tit: "Outbound · T02", tabelas: [["Separado", tSep.T02, C.sep], ["Conferido", tConf.T02, C.conf], ["Expedido", tExp.T02, C.exp]] },
    { id: "arm-adm", tit: "Armazenagem · ADM", tabelas: [["Armazenado", tArm.ADM, C.arm]] },
    { id: "arm-t02", tit: "Armazenagem · T02", tabelas: [["Armazenado", tArm.T02, C.arm]] }
  ];
  function corpo(tema) {
    return EMAILS.map(function (e) {
      const ts = e.tabelas.map(function (t) { return E.tabela(t[0], t[1], t[2], tema); });
      const tot = ts.map(function (t, i) { return E.esc(e.tabelas[i][0]) + " " + E.fmt(t.total); }).join(" · ");
      return '<section class="email" id="' + e.id + "-" + tema + '">' +
        '<div class="email-hd"><div><p class="kicker">Assunto do e-mail</p><h3>' + E.esc(e.tit) + " · " + E.dataBR(dia) + "</h3></div>" +
        '<div class="resumo">' + tot + "</div></div>" +
        '<div class="email-corpo">' + ts.map(function (t) { return t.html; }).join("") + "</div></section>";
    }).join("");
  }
  const chips = EMAILS.map(function (e) { return '<a class="chip" href="#' + e.id + '-claro">' + E.esc(e.tit) + "</a>"; }).join("");

  const html = `<!DOCTYPE html>
<html lang="pt-BR" data-tema="escuro">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prévia dos e-mails por hora — Vulcabras</title>
<link rel="icon" href="${png64("docs/padrao-vulcabras/img/logo-mark.png")}" type="image/png">
<style>
[data-tema="escuro"]{--bg:#0F1623;--bg-card:#192032;--bg-input:#1E2A3D;--border:#253048;--text:#E8EBF2;
  --text-muted:#7C8BA8;--text-label:#9BAAC4;--accent:#297ADF;--accent-soft:#16283F;--shadow:0 2px 12px rgba(0,0,0,.4)}
[data-tema="claro"]{--bg:#F3F4F7;--bg-card:#FFFFFF;--bg-input:#F8F9FB;--border:#E1E4EA;--text:#1C2333;
  --text-muted:#6B7280;--text-label:#4B5563;--accent:#1A6FC4;--accent-soft:#EFF6FF;--shadow:0 2px 8px rgba(0,0,0,.08)}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
  font-variant-numeric:tabular-nums;transition:background .2s,color .2s}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;min-height:60px;
  padding:0 24px;border-bottom:1px solid var(--border);background:var(--bg-card);box-shadow:var(--shadow)}
.marca{display:flex;align-items:center;gap:12px}
.marca img{height:32px}
.topbar h2{margin:0;font-size:16px;font-weight:700;line-height:1.25}
.topbar .sub{font-size:11.5px;color:var(--text-muted);margin-top:2px}
/* tema claro usa os PNGs escuros da Vulcabras (nada de filtro) */
[data-tema="escuro"] .so-claro,[data-tema="claro"] .so-escuro{display:none}
.vb-acoes{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.vb-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:20px;cursor:pointer;
  background:rgba(127,140,170,.14);border:1px solid rgba(127,140,170,.35);color:inherit;font-family:inherit;
  font-size:12px;font-weight:600;line-height:1.2;white-space:nowrap}
.vb-btn:hover{background:rgba(127,140,170,.26)}
.vb-btn:focus-visible{outline:2px solid #297ADF;outline-offset:2px}
.marca-dir{height:30px;width:34px;object-fit:contain;opacity:.9}   /* caixa igual nos dois temas: os PNGs têm proporções diferentes */
.barra{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  padding:10px 24px;background:var(--bg-card);border-bottom:1px solid var(--border)}
.barra b{font-size:.64rem;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted)}
.chip{font-size:.72rem;border:1px solid var(--border);background:var(--bg-input);color:var(--text-label);
  padding:5px 11px;border-radius:999px;text-decoration:none}
.chip:hover{border-color:var(--accent);color:var(--accent)}
.content{padding:22px 22px 80px;display:flex;flex-direction:column;gap:90px;max-width:1500px}
.email+.email{position:relative}
.email+.email::before{content:"";position:absolute;left:0;right:0;top:-45px;border-top:1px solid var(--border)}
.email{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;overflow:hidden;scroll-margin-top:60px}
.email-hd{display:flex;justify-content:space-between;align-items:flex-end;gap:14px;flex-wrap:wrap;
  padding:14px 18px;border-bottom:1px solid var(--border);background:var(--bg-input)}
.email-hd h3{margin:0;font-size:.95rem;font-weight:700}
.kicker{font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted);margin:0 0 6px}
.resumo{font-size:.78rem;color:var(--text-muted)}
.email-corpo{padding:22px 18px 0}   /* o cartão da última atividade já traz 30 px embaixo */
.folha{display:flex;flex-direction:column;gap:90px}   /* o espaço entre e-mails vive aqui: .content só tem as duas folhas de tema */
.folha[hidden]{display:none}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
<header class="topbar">
  <div class="marca">
    <img class="so-escuro" src="${png64("tv/logo-vulcabras-cor.png")}" alt="Vulcabras">
    <img class="so-claro" src="${png64("docs/padrao-vulcabras/img/logo-vulcabras-azul.png")}" alt="Vulcabras">
    <div>
      <h2>Prévia dos e-mails por hora</h2>
      <div class="sub">Produtividade por colaborador · ${E.dataBR(dia)} · gerada em <span id="geradoEm"></span></div>
    </div>
  </div>
  <div class="vb-acoes">
    <button class="vb-btn" id="btnTelaCheia" onclick="vbTelaCheia()">⛶ Tela cheia</button>
    <button class="vb-btn" id="btnTema" onclick="alternarTema()">🌙 Tema Escuro</button>
    <img class="marca-dir so-escuro" src="${png64("docs/padrao-vulcabras/img/logo-mark.png")}" alt="">
    <img class="marca-dir so-claro" src="${png64("docs/padrao-vulcabras/img/logo-mark-azul.png")}" alt="">
  </div>
</header>
<nav class="barra"><b>E-mails do dia</b>${chips}</nav>
<main class="content">
  <div class="folha" id="folhaClaro">${corpo("claro")}</div>
  <div class="folha" id="folhaEscuro" hidden>${corpo("escuro")}</div>
</main>
<script>
function aplicarTema(t){
  document.documentElement.setAttribute('data-tema', t);
  document.getElementById('btnTema').textContent = t === 'claro' ? '☀️ Tema Claro' : '🌙 Tema Escuro';
  document.getElementById('folhaClaro').hidden = t !== 'claro';
  document.getElementById('folhaEscuro').hidden = t === 'claro';
}
function alternarTema(){
  var novo = document.documentElement.getAttribute('data-tema') === 'claro' ? 'escuro' : 'claro';
  aplicarTema(novo);
}
aplicarTema('escuro');   // o padrão é sempre o escuro; a escolha vale só enquanto a página está aberta
function vbTelaCheia(){
  var d = document, el = d.documentElement;
  if (!(d.fullscreenElement || d.webkitFullscreenElement)) {
    var f = el.requestFullscreen || el.webkitRequestFullscreen;
    if (f) { var p = f.call(el); if (p && p.catch) p.catch(function(){}); }
  } else { (d.exitFullscreen || d.webkitExitFullscreen).call(d); }
}
if (!document.documentElement.requestFullscreen && !document.documentElement.webkitRequestFullscreen) document.getElementById('btnTelaCheia').hidden = true;
document.getElementById('geradoEm').textContent = new Date().toLocaleString('pt-BR');
// os atalhos da barra levam ao bloco do tema que estiver aberto
document.querySelectorAll('.chip').forEach(function(a){ a.addEventListener('click', function(e){
  e.preventDefault();
  var id = a.getAttribute('href').replace('#','').replace(/-(claro|escuro)$/, '') + '-' + (document.documentElement.getAttribute('data-tema') === 'claro' ? 'claro' : 'escuro');
  var el = document.getElementById(id); if (el) el.scrollIntoView({ behavior:'smooth', block:'start' });
}); });
</script>
</body>
</html>`;
  const arq = path.join(saida, "previa-emails-" + dia + ".html");
  fs.writeFileSync(arq, html);
  console.log("Prévia: " + arq);
  console.log("Pessoas: separação " + Object.keys(sep).length + " · conferência " + Object.keys(conf).length +
    " · expedição " + Object.keys(exp).length + " · armazenagem " + Object.keys(arm).length);
})().catch(function (e) { console.error("FALHOU: " + e.message); process.exit(1); });
