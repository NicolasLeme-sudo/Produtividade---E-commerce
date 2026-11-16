/* =========================================================================
   E-MAIL POR HORA — produtividade por colaborador, em tabela
   -------------------------------------------------------------------------
   Monta os e-mails que o robô manda depois de cada rodada:

     Outbound     (Separado · Conferido · Expedido)  T01 e T02
     Armazenagem  (Armazenado)                       ADM e T02

   Uma tabela por assunto: colaborador nas linhas (do maior para o menor),
   as horas do turno nas colunas (o que a pessoa fez NAQUELA hora) e a coluna
   Total no fim. Hora extra vira coluna a mais, sem precisar de ajuste.

   Os números saem dos mesmos snapshots do telão, então batem com a TV.
   Quem envia é o enviar-outlook.ps1 (Outlook do notebook); aqui só se monta.
   ========================================================================= */
"use strict";

var TURNOS = {
  T01: { rot: "T01", ini: 5 * 60, fim: 14 * 60 + 48 },
  T02: { rot: "T02", ini: 14 * 60 + 48, fim: 24 * 60 + 16 },
  ADM: { rot: "ADM", ini: 7 * 60 + 55, fim: 17 * 60 + 33 }
};
// Ordem das colunas: a madrugada (00h–04h) vem DEPOIS das 23h, porque o T02 vira o dia.
function ordemHora(h) { return h < 5 ? h + 24 : h; }
function rotHora(h) { return String(h).padStart(2, "0") + "h"; }
function fmt(n) { return (Math.round(n) || 0).toLocaleString("pt-BR"); }

/* ---------------- montagem de uma tabela ---------------- */
// pessoas = { nome: [24] peças por hora }  ->  { html, total, horas }
function tabela(titulo, pessoas, cor) {
  var nomes = Object.keys(pessoas || {});
  var horas = [];
  nomes.forEach(function (n) {
    pessoas[n].forEach(function (v, h) { if (v > 0 && horas.indexOf(h) === -1) horas.push(h); });
  });
  horas.sort(function (a, b) { return ordemHora(a) - ordemHora(b); });
  var linhas = nomes.map(function (n) {
    var arr = pessoas[n], tot = arr.reduce(function (s, v) { return s + v; }, 0);
    return { nome: n, arr: arr, total: tot };
  }).filter(function (l) { return l.total > 0; });
  linhas.sort(function (a, b) { return b.total - a.total || a.nome.localeCompare(b.nome); });
  var total = linhas.reduce(function (s, l) { return s + l.total; }, 0);
  if (!linhas.length) {
    return { html: '<h3 style="' + H3 + 'border-left:4px solid ' + cor + '">' + titulo +
      '</h3><p style="' + P + '">Sem produção até agora.</p>', total: 0, horas: [] };
  }
  var cab = '<tr><th style="' + TH_N + '">' + titulo + '</th>' +
    horas.map(function (h) { return '<th style="' + TH + '">' + rotHora(h) + '</th>'; }).join("") +
    '<th style="' + TH + 'background:' + cor + ';color:#fff">Total</th></tr>';
  var corpo = linhas.map(function (l, i) {
    var zebra = i % 2 ? "background:#F4F6FA;" : "";
    return '<tr><td style="' + TD_N + zebra + '">' + esc(l.nome) + '</td>' +
      horas.map(function (h) { return '<td style="' + TD + zebra + '">' + (l.arr[h] ? fmt(l.arr[h]) : "·") + '</td>'; }).join("") +
      '<td style="' + TD + zebra + 'font-weight:700;color:' + cor + '">' + fmt(l.total) + '</td></tr>';
  }).join("");
  var rodape = '<tr><td style="' + TD_N + 'font-weight:700;background:#E8ECF4">Total</td>' +
    horas.map(function (h) {
      var s = linhas.reduce(function (a, l) { return a + (l.arr[h] || 0); }, 0);
      return '<td style="' + TD + 'font-weight:700;background:#E8ECF4">' + (s ? fmt(s) : "·") + '</td>';
    }).join("") +
    '<td style="' + TD + 'font-weight:800;background:' + cor + ';color:#fff">' + fmt(total) + '</td></tr>';
  return {
    html: '<h3 style="' + H3 + 'border-left:4px solid ' + cor + '">' + titulo + ' · <b>' + fmt(total) + '</b> peças</h3>' +
      '<table style="' + TABELA + '">' + cab + corpo + rodape + '</table>',
    total: total, horas: horas
  };
}

/* ---------------- estilo (e-mail: tudo inline) ---------------- */
var FONTE = "font-family:Segoe UI,Arial,sans-serif;";
var TABELA = FONTE + "border-collapse:collapse;font-size:13px;margin:0 0 22px 0;";
var TH = "padding:6px 10px;border:1px solid #C9D2E0;background:#1B2A4A;color:#fff;font-weight:600;text-align:right;white-space:nowrap;";
var TH_N = TH + "text-align:left;";
var TD = "padding:5px 10px;border:1px solid #DDE3EC;text-align:right;white-space:nowrap;";
var TD_N = TD + "text-align:left;";
var H3 = FONTE + "font-size:15px;margin:0 0 8px 0;padding-left:10px;";
var P = FONTE + "font-size:13px;color:#5A6782;margin:0 0 22px 0;";
function esc(t) { return String(t == null ? "" : t).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }

/* ---------------- quem é de qual turno ---------------- */
// Pelo horário da 1ª produção do dia: antes das 14h48 = turno da manhã (T01 ou ADM), depois = T02.
// Quem faz hora extra continua no próprio turno; as horas a mais viram coluna.
function turnoDaPessoa(arr, manha) {
  for (var h = 0; h < 24; h++) { var hh = h < 5 ? h + 24 : h; if (arr[hh % 24] > 0) break; }
  var primeira = null;
  [].concat(arr).forEach(function (v, i) { if (v > 0 && (primeira === null || ordemHora(i) < ordemHora(primeira))) primeira = i; });
  if (primeira === null) return null;
  return primeira < 15 ? manha : "T02";
}
// { usuario: [24] } -> { T01: { nome: [24] }, T02: {...} }
function porTurno(porUsuario, nomes, manha) {
  var out = {}; out[manha] = {}; out.T02 = {};
  Object.keys(porUsuario || {}).forEach(function (u) {
    var arr = porUsuario[u], t = turnoDaPessoa(arr, manha);
    if (!t) return;
    var nome = (nomes && nomes[u]) || u;
    var alvo = out[t][nome] || (out[t][nome] = new Array(24).fill(0));
    arr.forEach(function (v, h) { alvo[h] += v || 0; });
  });
  return out;
}
function somarEm(destino, porUsuario) {
  Object.keys(porUsuario || {}).forEach(function (u) {
    var alvo = destino[u] || (destino[u] = new Array(24).fill(0));
    (porUsuario[u] || []).forEach(function (v, h) { alvo[h] += v || 0; });
  });
  return destino;
}

/* ---------------- leitura dos snapshots ---------------- */
function doDia(lista, dia) { return (lista || []).filter(function (x) { return x.data === dia; })[0] || null; }

// Separação e Conferência: analítico já traz [24] por usuário (checkout e colmeia).
function analiticoPorUsuario(analitico, dia, tipos) {
  var d = doDia(analitico, dia), out = {};
  if (!d) return out;
  tipos.forEach(function (t) { somarEm(out, d[t] || {}); });
  return out;
}
// Conferência Colmeia não tem hora no relatório: as marcas guardam o acumulado do dia por operador
// a cada envio (de 30 em 30 min). A produção da hora é a diferença entre a última marca de cada hora.
function colmeiaPorUsuario(conferencia, dia) {
  var reg = doDia((conferencia || {}).colmeiaMarcas, dia), out = {};
  if (!reg) return out;
  var marcas = (reg.marcas || []).slice().sort(function (a, b) { return a[0] - b[0]; });
  var ultimaDaHora = {}, anterior = {};
  marcas.forEach(function (mk) { ultimaDaHora[Math.min(23, Math.floor(mk[0] / 60)) % 24] = mk[1] || {}; });
  Object.keys(ultimaDaHora).map(Number).sort(function (a, b) { return ordemHora(a) - ordemHora(b); }).forEach(function (h) {
    var acum = ultimaDaHora[h];
    Object.keys(acum).forEach(function (u) {
      var arr = out[u] || (out[u] = new Array(24).fill(0));
      arr[h] = Math.max(0, (acum[u] || 0) - (anterior[u] || 0));
    });
    Object.keys(acum).forEach(function (u) { anterior[u] = acum[u]; });
  });
  return out;
}
// Expedição: expNfs tem usuário, minuto e peças de cada nota embarcada (2 dias mais recentes).
function expedicaoPorUsuario(op, dia) {
  var nfs = ((op || {}).expNfs || {})[dia], out = {};
  Object.keys(nfs || {}).forEach(function (id) {
    var x = nfs[id]; if (!x) return;
    var arr = out[x[0]] || (out[x[0]] = new Array(24).fill(0));
    arr[Math.floor(x[1] / 60) % 24] += x[2] || 0;
  });
  return out;
}
// Armazenagem: normalUsuHoraDia já vem com o nome resolvido pela Base de ativos.
function armazenagemPorUsuario(inbound, dia) {
  var d = doDia(((inbound || {}).armazenagem || {}).normalUsuHoraDia, dia);
  return d ? d.itens || {} : {};
}

module.exports = {
  TURNOS: TURNOS, ordemHora: ordemHora, rotHora: rotHora, fmt: fmt, esc: esc,
  tabela: tabela, porTurno: porTurno, turnoDaPessoa: turnoDaPessoa, somarEm: somarEm,
  analiticoPorUsuario: analiticoPorUsuario, colmeiaPorUsuario: colmeiaPorUsuario,
  expedicaoPorUsuario: expedicaoPorUsuario, armazenagemPorUsuario: armazenagemPorUsuario,
  FONTE: FONTE
};
