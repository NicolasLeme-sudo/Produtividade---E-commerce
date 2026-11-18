/* Lê os snapshots do telão e devolve as peças por usuário e hora de cada atividade,
   já separadas por turno. Usado pela prévia (previa-email.js) e pelo envio (enviar-email.js). */
"use strict";
const fs = require("fs");
const path = require("path");
const E = require("./email");

const RAIZ = path.join(__dirname, "..");

function diaOperacional(d) {
  d = new Date(d || Date.now());
  if (d.getHours() < 1) d.setDate(d.getDate() - 1);   // 00h–01h ainda é o dia anterior (T02 vai até 00h16)
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// Cliente do Supabase com o mesmo login do robô (só leitura aqui).
async function cliente(cfg) {
  const ing = fs.readFileSync(path.join(RAIZ, "ingest.js"), "utf8");
  const url = /SUPABASE_URL\s*=\s*"([^"]+)"/.exec(ing)[1], key = /SUPABASE_ANON_KEY\s*=\s*"([^"]+)"/.exec(ing)[1];
  const sb = require("@supabase/supabase-js").createClient(url, key);
  const { error } = await sb.auth.signInWithPassword({ email: cfg.PROD_EMAIL, password: cfg.PROD_SENHA });
  if (error) throw new Error("login no Produtividade: " + error.message);
  return sb;
}

// Usuários que não entram nas tabelas (apoio da liderança, por exemplo): EXCLUIR_USUARIOS no .env.
function semExcluidos(mapa, fora) {
  if (!fora || !fora.length) return mapa;
  const out = {};
  // a chave da armazenagem pode trazer a marca da reversa: compara só o usuário
  Object.keys(mapa || {}).forEach(function (u) { if (fora.indexOf(E.usuarioDaChave(u).trim().toUpperCase()) === -1) out[u] = mapa[u]; });
  return out;
}

// -> { sep:{T01,T02}, conf:{T01,T02}, exp:{T01,T02}, arm:{ADM,T02}, vazio }
async function carregar(sb, dia, excluir) {
  const fora = String(excluir || "").split(",").map(function (x) { return x.trim().toUpperCase(); }).filter(Boolean);
  const q = await sb.from("dashboard_snapshots").select("pagina, dados").in("pagina", ["outbound", "inbound", "operacao"]);
  if (q.error) throw q.error;
  const pg = {}; (q.data || []).forEach(function (l) { pg[l.pagina] = l.dados || {}; });
  const out = pg.outbound || {}, inb = pg.inbound || {}, op = pg.operacao || {};
  const sep = semExcluidos(E.analiticoPorUsuario((out.separacao || {}).analitico, dia, ["checkout", "colmeia"]), fora);
  const conf = semExcluidos(E.somarEm(E.analiticoPorUsuario((out.conferencia || {}).analitico, dia, ["checkout"]), E.colmeiaPorUsuario(out.conferencia, dia)), fora);
  const exp = semExcluidos(E.expedicaoPorUsuario(op, dia), fora);
  const arm = semExcluidos(E.armazenagemPorUsuario(inb, dia), fora);
  const t = {
    sep: E.porTurno(sep, null, "T01"), conf: E.porTurno(conf, null, "T01"),
    exp: E.porTurno(exp, null, "T01"), arm: E.porTurno(arm, null, "ADM")
  };
  t.vazio = !Object.keys(sep).length && !Object.keys(conf).length && !Object.keys(exp).length && !Object.keys(arm).length;
  return t;
}

module.exports = { cliente: cliente, carregar: carregar, diaOperacional: diaOperacional, RAIZ: RAIZ };
