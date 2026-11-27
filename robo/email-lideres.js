/* E-mail de produtividade por time para cada líder da Black (26/11), hora a hora, no mesmo horário dos e-mails do Outbound
   (hora cheia + fechamento do turno). Cada líder recebe só os times dele: uma tabela por time, com cada colaborador da escalação
   (competicao_times), peças por hora (separação + conferência, checkout + colmeia) e total.
   Quem recebe o quê: lideres-black.json (e-mail, turno e números dos times; NÃO vai para o repositório).
   Sem produção no horário: não manda. Erro nunca derruba a rodada. */
"use strict";
const fs = require("fs");
const path = require("path");
const E = require("./email");
const D = require("./dados-email");
const EM = require("./enviar-email");

const ARQ_LIDERES = path.join(__dirname, "lideres-black.json");
const ARQ_ESTADO = path.join(__dirname, "lideres-enviados.json");
const TURNO_ID = { "1º Turno": "out-t01", "2º Turno": "out-t02" };
const TURNO_ROT = { "1º Turno": "T01", "2º Turno": "T02" };
// cor e piso de cada time (regras-black.js: 1 Vermelho · 2 Azul · 3 Verde · 4 Amarelo · 7 Laranja · 8 Branco)
const TIME = { 1: ["Vermelho", "#E0334F", "1º piso calçado"], 2: ["Azul", "#4C95F0", "2º piso"], 3: ["Verde", "#2FA84F", "3º piso"], 4: ["Amarelo", "#F6BD00", "4º piso"],
  5: ["Rosa", "#EC4FA0", "Colmeia B"], 6: ["Roxo", "#A773EA", "Colmeia A"], 7: ["Laranja", "#F5A524", "1º confecção · caixa 1"], 8: ["Branco", "#7C8BA8", "1º confecção · caixa 2"] };
const CONECT = ["DE", "DA", "DO", "DAS", "DOS", "E"];
const norm = function (s) { return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/,/g, ".").trim().toUpperCase(); };

function chaves(r) {
  const ks = [norm(r.usuario_wms), norm(r.nome)];
  const t = norm(r.nome).split(/\s+/).filter(function (x) { return x && CONECT.indexOf(x) === -1; });
  if (t.length > 1) { t.slice(1).reverse().forEach(function (x) { ks.push(t[0] + "." + x); }); if (t.length > 2) ks.push(t[0] + "." + t[1].charAt(0) + "." + t[t.length - 1]); }
  return ks.filter(function (k, i) { return k && ks.indexOf(k) === i; });
}
function lerJson(f, vazio) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return vazio; } }

async function verificar(cfg, log, opcoes) {
  opcoes = opcoes || {};
  const lideres = lerJson(ARQ_LIDERES, []);
  if (!lideres.length) return 0;
  const agora = opcoes.agora || new Date();
  const dia = D.diaOperacional(agora), minAgora = EM.minutoOperacional(agora);
  const estado = lerJson(ARQ_ESTADO, {}), feitos = estado[dia] || (estado[dia] = {});
  // o que está na hora de mandar em cada turno (mesma agenda do Outbound); a chave de "feito" é por líder
  const pend = EM.pendentes([{ id: "out-t01" }, { id: "out-t02" }], minAgora, {}, opcoes.fimDeRodada !== false);
  const itens = []; pend.forEach(function (p) { lideres.forEach(function (l) { if (TURNO_ID[l.turno] === p.bloco.id && !feitos[l.email + "|" + p.chave]) itens.push({ l: l, p: p }); }); });
  if (!itens.length) return 0;

  const sb = opcoes.sb || await D.cliente(cfg);
  const snap = (await sb.from("dashboard_snapshots").select("dados").eq("pagina", "outbound").maybeSingle()).data;
  const cad = (await sb.from("competicao_times").select("usuario_wms,nome,turno,time")).data || [];
  if (!snap || !snap.dados || !cad.length) return 0;
  await D.atualizarCadastro(sb);
  const out = snap.dados;
  const sep = E.analiticoPorUsuario((out.separacao || {}).analitico, dia, ["checkout", "colmeia"]);
  const conf = E.somarEm(E.analiticoPorUsuario((out.conferencia || {}).analitico, dia, ["checkout"]), E.colmeiaPorUsuario(out.conferencia, dia));
  const juntar = function (m) { const o = {}; Object.keys(m).forEach(function (u) { const k = norm(E.usuarioDaChave(u)); const a = o[k] || (o[k] = new Array(24).fill(0)); (m[u] || []).forEach(function (v, h) { a[h] += v || 0; }); }); return o; };
  const prodSep = juntar(sep), prodConf = juntar(conf);   // chave normalizada -> [24]

  let n = 0;
  for (const { l, p } of itens) {
    const tabelas = []; let total = 0;
    l.times.forEach(function (t) {
      const membros = cad.filter(function (r) { return r.turno === l.turno && r.time === t && !/^(SEMWMS|REFORCO)/i.test(r.usuario_wms); });
      const pessoas = {}, ativ = {}; let sem = 0;
      membros.forEach(function (r) {
        const ks = chaves(r), ksep = ks.filter(function (x) { return prodSep[x]; })[0], kconf = ks.filter(function (x) { return prodConf[x]; })[0];
        if (ksep) { pessoas[r.usuario_wms + "S"] = prodSep[ksep]; ativ[r.usuario_wms + "S"] = "Separação"; }
        if (kconf) { pessoas[r.usuario_wms + "C"] = prodConf[kconf]; ativ[r.usuario_wms + "C"] = "Conferência"; }
        if (!ksep && !kconf) sem++;
      });
      const info = TIME[t] || ["Time " + t, "#297ADF", ""];
      const tb = E.tabela("Time " + info[0] + " · " + info[2], pessoas, info[1], "email", null, membros.length + " escalados" + (sem ? " · " + sem + " sem produção" : ""), false, null, ativ);
      total += tb.total; tabelas.push(tb.html);
    });
    if (!total) continue;     // sem produção: não manda e-mail vazio
    const cab = '<div style="' + E.FONTE + 'padding:4px 2px"><p style="' + E.FONTE + 'font-size:14px;margin:0 0 8px">Produtividade dos colaboradores dos seus times · ' + TURNO_ROT[l.turno] + " · " + E.dataBR(dia) + " · " + esc(p.horaTexto) + "</p>";
    const html = cab + tabelas.join("<br>") + '<p style="' + E.FONTE + 'font-size:11px;color:#7C8BA8;margin:8px 0 0">Separação + conferência (checkout e colmeia), peças por hora. Cada colaborador aparece uma linha por atividade em que produziu; sem produção não aparece.</p></div>';
    const cores = l.times.map(function (t) { return (TIME[t] || [t])[0]; }).join(" + ");
    const assunto = "Seu time · " + TURNO_ROT[l.turno] + " · " + cores + " · " + E.dataBR(dia) + (p.fech ? " · Fechamento" : " · " + p.horaTexto);
    if (EM.mandar(opcoes.para || l.email, assunto, html, log)) {
      n++;
      if (!opcoes.para) { feitos[l.email + "|" + p.chave] = new Date().toISOString(); }
    }
  }
  Object.keys(estado).sort().slice(0, -7).forEach(function (d) { delete estado[d]; });
  if (!opcoes.para) { try { fs.writeFileSync(ARQ_ESTADO, JSON.stringify(estado, null, 1)); } catch (e) {} }
  if (n) log("   e-mails dos líderes enviados: " + n);
  return n;
}
function esc(t) { return E.esc(t); }

module.exports = { verificar: verificar };
