/* Prévia dos e-mails por hora, em arquivo HTML (não envia nada).
   Uso:  node previa-email.js [aaaa-mm-dd] [pasta de saída]            */
"use strict";
const fs = require("fs");
const path = require("path");
const E = require("./email");
const robo = require("./robo");

function diaOperacional(d) { d = new Date(d); if (d.getHours() < 1) d.setDate(d.getDate() - 1); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

async function cliente(cfg) {
  const ing = fs.readFileSync(path.join(__dirname, "..", "ingest.js"), "utf8");
  const url = /SUPABASE_URL\s*=\s*"([^"]+)"/.exec(ing)[1], key = /SUPABASE_ANON_KEY\s*=\s*"([^"]+)"/.exec(ing)[1];
  const sb = require("@supabase/supabase-js").createClient(url, key);
  const { error } = await sb.auth.signInWithPassword({ email: cfg.PROD_EMAIL, password: cfg.PROD_SENHA });
  if (error) throw new Error("login: " + error.message);
  return sb;
}

(async function () {
  const cfg = robo.lerEnv();
  const dia = (process.argv[2] || "").match(/^\d{4}-\d{2}-\d{2}$/) ? process.argv[2] : diaOperacional(new Date());
  const saida = process.argv[3] || "C:\\Entrega de Arquivos";   // nunca no repositório: a prévia tem nome de colaborador
  const sb = await cliente(cfg);
  const q = await sb.from("dashboard_snapshots").select("pagina, dados, atualizado_em").in("pagina", ["outbound", "inbound", "operacao"]);
  if (q.error) throw q.error;
  const pg = {}; (q.data || []).forEach(function (l) { pg[l.pagina] = l.dados || {}; });
  const out = pg.outbound || {}, inb = pg.inbound || {}, op = (pg.operacao || {});

  // peças por usuário e hora de cada assunto
  const sep = E.analiticoPorUsuario((out.separacao || {}).analitico, dia, ["checkout", "colmeia"]);
  const conf = E.somarEm(E.analiticoPorUsuario((out.conferencia || {}).analitico, dia, ["checkout"]), E.colmeiaPorUsuario(out.conferencia, dia));
  const exp = E.expedicaoPorUsuario(op, dia);
  const arm = E.armazenagemPorUsuario(inb, dia);

  // nomes da Base de ativos (a armazenagem já vem com o nome)
  const usuarios = Array.from(new Set([].concat(Object.keys(sep), Object.keys(conf), Object.keys(exp))));
  const ing = await robo.prepararIngest(cfg);          // mesma resolução de nome do site (Base de ativos)
  const mapaNome = await ing.api.resolverNomes(usuarios);

  const tSep = E.porTurno(sep, mapaNome, "T01"), tConf = E.porTurno(conf, mapaNome, "T01"), tExp = E.porTurno(exp, mapaNome, "T01");
  const tArm = E.porTurno(arm, null, "ADM");
  const COR = { sep: "#297ADF", conf: "#2EC4B6", exp: "#C79400", arm: "#F5A524" };

  function bloco(tit, tabelas) {
    return '<div style="' + E.FONTE + 'max-width:1100px;margin:0 0 40px 0">' +
      '<h2 style="' + E.FONTE + 'font-size:17px;margin:0 0 14px 0">' + tit + '</h2>' + tabelas.join("") + "</div>";
  }
  const partes = [
    bloco("Outbound · T01 · " + dia, [E.tabela("Separado", tSep.T01, COR.sep).html, E.tabela("Conferido", tConf.T01, COR.conf).html, E.tabela("Expedido", tExp.T01, COR.exp).html]),
    bloco("Outbound · T02 · " + dia, [E.tabela("Separado", tSep.T02, COR.sep).html, E.tabela("Conferido", tConf.T02, COR.conf).html, E.tabela("Expedido", tExp.T02, COR.exp).html]),
    bloco("Armazenagem · ADM · " + dia, [E.tabela("Armazenado", tArm.ADM, COR.arm).html]),
    bloco("Armazenagem · T02 · " + dia, [E.tabela("Armazenado", tArm.T02, COR.arm).html])
  ];
  const arq = path.join(saida, "previa-emails-" + dia + ".html");
  fs.writeFileSync(arq, '<!doctype html><meta charset="utf-8"><title>Prévia dos e-mails</title><body style="background:#fff;padding:24px">' + partes.join("") + "</body>");
  console.log("Prévia: " + arq);
  console.log("Pessoas: separação " + Object.keys(sep).length + " · conferência " + Object.keys(conf).length + " · expedição " + Object.keys(exp).length + " · armazenagem " + Object.keys(arm).length);
})().catch(function (e) { console.error("FALHOU: " + e.message); process.exit(1); });
