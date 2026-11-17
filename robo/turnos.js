/* Cadastro de turno por usuário do WMS, a partir da lista de Ativos do RH.
   Uso:  node turnos.js "C:\Leitura de Arquivos\Ativos 17.11.xlsx"
   Gera robo/turnos-wms.json (fora do Git: tem nome de colaborador), lido pelo
   email.js para decidir de que turno é cada pessoa. Sem ele, o turno sai do
   horário da produção (turnoDaPessoa).
   O WMS não tem o nome completo: o casamento é "primeiro nome + um sobrenome"
   contra os usuários que já apareceram na produção dos snapshots. */
"use strict";
const fs = require("fs");
const path = require("path");
const X = require("xlsx");
const E = require("./email");
const D = require("./dados-email");

const ARQ = path.join(__dirname, "turnos-wms.json");
const CONECTIVOS = ["DA", "DE", "DO", "DAS", "DOS", "E"];
const MAPA_TURNO = { "1º TURNO": "T01", "1O TURNO": "T01", "2º TURNO": "T02", "2O TURNO": "T02", "ADM": "ADM" };

function normalizar(t) {
  return String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9º\s]/g, " ").replace(/\s+/g, " ").trim();
}
function candidatos(nome) {
  const tk = normalizar(nome).split(" ").filter(function (t) { return t && CONECTIVOS.indexOf(t) === -1; });
  if (tk.length < 2) return tk;
  const c = [];
  for (var i = 1; i < tk.length; i++) c.push(tk[0] + "." + tk[i]);
  return c;
}
// { usuário do WMS: "T01" | "T02" | "ADM" } a partir da planilha + dos usuários vistos na produção
function montar(arquivo, usuarios) {
  const wb = X.readFile(arquivo);
  const linhas = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
  // o usuário do WMS é NOME.SOBRENOME: aqui o ponto tem de sobreviver à normalização
  const vistos = new Set((usuarios || []).map(function (u) {
    return normalizar(String(u).replace(/,/g, ".").replace(/\./g, " ")).replace(/ /g, ".");
  }));
  const mapa = {}, casados = [], semUsuario = [];
  linhas.forEach(function (l) {
    const turno = MAPA_TURNO[normalizar(l["Horario"] || l["Horário"])];
    if (!turno) return;                                   // 3º turno e cargo de confiança ficam de fora
    const achou = candidatos(l["Nome"]).filter(function (c) { return vistos.has(c); });
    if (!achou.length) { semUsuario.push(l["Nome"]); return; }
    achou.forEach(function (u) { mapa[u] = turno; });      // nome que casa com mais de um usuário: os dois
    casados.push(l["Nome"]);
  });
  return { mapa: mapa, casados: casados, semUsuario: semUsuario, linhas: linhas.length };
}
module.exports = { montar: montar, ARQ: ARQ, ler: function () { try { return JSON.parse(fs.readFileSync(ARQ, "utf8")).turnos || {}; } catch (e) { return {}; } } };

if (require.main === module) {
  const arquivo = process.argv[2];
  if (!arquivo) { console.error('Uso: node turnos.js "C:\Leitura de Arquivos\Ativos dd.mm.xlsx"'); process.exit(1); }
  (async function () {
    const cfg = require("./robo").lerEnv();
    const sb = await D.cliente(cfg);
    const q = await sb.from("dashboard_snapshots").select("pagina, dados").in("pagina", ["outbound", "inbound", "operacao"]);
    if (q.error) throw q.error;
    const pg = {}; (q.data || []).forEach(function (l) { pg[l.pagina] = l.dados || {}; });
    // todos os usuários que já apareceram na produção (qualquer dia guardado)
    const usuarios = new Set();
    const addMapa = function (m) { Object.keys(m || {}).forEach(function (u) { usuarios.add(u); }); };
    [((pg.outbound || {}).separacao || {}).analitico, ((pg.outbound || {}).conferencia || {}).analitico].forEach(function (lista) {
      (lista || []).forEach(function (d) { ["checkout", "colmeia"].forEach(function (t) { addMapa(d[t]); }); });
    });
    (((pg.outbound || {}).conferencia || {}).colmeiaMarcas || []).forEach(function (d) { (d.marcas || []).forEach(function (mk) { addMapa(mk[1]); }); });
    ((((pg.inbound || {}).armazenagem || {}).normalUsuHoraDia) || []).forEach(function (d) { addMapa(d.itens); });
    Object.keys(((pg.operacao || {}).expNfs) || {}).forEach(function (dia) {
      const nfs = pg.operacao.expNfs[dia] || {};
      Object.keys(nfs).forEach(function (id) { if (nfs[id]) usuarios.add(nfs[id][0]); });
    });
    const r = montar(arquivo, Array.from(usuarios));
    const n = Object.keys(r.mapa).length;
    fs.writeFileSync(ARQ, JSON.stringify({ origem: path.basename(arquivo), em: new Date().toISOString(), turnos: r.mapa }, null, 1), "utf8");
    const conta = {}; Object.keys(r.mapa).forEach(function (u) { conta[r.mapa[u]] = (conta[r.mapa[u]] || 0) + 1; });
    console.log("Planilha: " + r.linhas + " linhas · usuários vistos na produção: " + usuarios.size);
    console.log("Casaram: " + n + " (" + Object.keys(conta).sort().map(function (k) { return k + " " + conta[k]; }).join(" · ") + ")");
    const fora = Array.from(usuarios).filter(function (u) { return !r.mapa[u]; });
    console.log("Sem turno no cadastro (seguem pelo horário): " + fora.length);
    console.log("Arquivo: " + ARQ);
    process.exit(0);
  })().catch(function (e) { console.error("FALHOU: " + e.message); process.exit(1); });
}
