/* =========================================================================
   E-MAIL POR HORA — produtividade por colaborador, em tabela
   -------------------------------------------------------------------------
   Monta os e-mails que o robô manda depois de cada rodada:

     Outbound     (Separado · Conferido · Expedido)  T01 e T02
     Armazenagem  (Armazenado)                       ADM e T02

   Uma tabela por atividade, cada uma num cartão próprio (demarcação entre
   setores): colaborador nas linhas (do maior para o menor), as horas em
   colunas (o que a pessoa fez NAQUELA hora) e a coluna Total no fim.
   Hora extra vira coluna a mais, sem precisar de ajuste.

   Cor da atividade (padrão Vulcabras): linha de títulos cheia na cor, linha
   de totais num tom mais fraco da mesma cor, coluna Total em negrito na cor.

   Os números saem dos mesmos snapshots do telão, então batem com a TV.
   Quem envia é o enviar-outlook.ps1 (Outlook do notebook); aqui só se monta.
   ========================================================================= */
"use strict";

var TURNOS = {
  T01: { rot: "T01", ini: 5 * 60, fim: 14 * 60 + 48 },
  T02: { rot: "T02", ini: 14 * 60 + 48, fim: 24 * 60 + 16 },
  ADM: { rot: "ADM", ini: 7 * 60 + 55, fim: 17 * 60 + 33 }
};
// Cores de etapa do padrão Vulcabras (docs/padrao-vulcabras, seção 2.4)
var CORES = { sep: "#297ADF", conf: "#2EC4B6", exp: "#F6BD00", arm: "#F5A524" };

// Ordem das colunas: a madrugada (00h–04h) vem DEPOIS das 23h, porque o T02 vira o dia.
function ordemHora(h) { return h < 5 ? h + 24 : h; }
function rotHora(h) { return String(h).padStart(2, "0") + "h"; }
function fmt(n) { return (Math.round(n) || 0).toLocaleString("pt-BR"); }
function dataBR(iso) { var p = String(iso || "").split("-"); return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : String(iso || ""); }
function esc(t) { return String(t == null ? "" : t).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }

/* ---------------- tema (e-mail usa o claro; a prévia tem os dois) ---------------- */
// Aspas SIMPLES no nome da fonte: o estilo vai dentro de style="…" e uma aspa dupla cortaria o resto da regra.
var FONTE = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-variant-numeric:tabular-nums;";
var TEMAS = {
  claro:  { fundo: "#FFFFFF", cartao: "#FFFFFF", zebra: "#F6F8FB", borda: "#E1E4EA", texto: "#1C2333", apoio: "#6B7280", mistura: "#FFFFFF", pTotal: .14, pBorda: .45 },
  escuro: { fundo: "#0F1623", cartao: "#192032", zebra: "#1E2A3D", borda: "#253048", texto: "#E8EBF2", apoio: "#7C8BA8", mistura: "#192032", pTotal: .26, pBorda: .55 }
};
function hex(c) { c = String(c).replace("#", ""); return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)]; }
// mistura(cor, fundo, p): p = quanto da cor entra (0 a 1). Tom fraco da cor da atividade.
function mistura(cor, fundo, p) {
  var a = hex(cor), b = hex(fundo);
  return "#" + [0, 1, 2].map(function (i) { return Math.round(a[i] * p + b[i] * (1 - p)).toString(16).padStart(2, "0"); }).join("");
}

/* ---------------- uma tabela (um cartão por atividade) ---------------- */
// pessoas = { nome: [24] peças por hora }  ->  { html, total, horas, pessoas }
function tabela(titulo, pessoas, cor, tema) {
  var T = TEMAS[tema === "escuro" ? "escuro" : "claro"];
  var corTotal = mistura(cor, T.mistura, T.pTotal);     // linha de totais: a mesma cor, mais fraca
  var corBorda = mistura(cor, T.borda, T.pBorda);
  var nomes = Object.keys(pessoas || {});
  var horas = [];
  nomes.forEach(function (n) { pessoas[n].forEach(function (v, h) { if (v > 0 && horas.indexOf(h) === -1) horas.push(h); }); });
  horas.sort(function (a, b) { return ordemHora(a) - ordemHora(b); });
  var linhas = nomes.map(function (n) {
    return { nome: n, arr: pessoas[n], total: pessoas[n].reduce(function (s, v) { return s + v; }, 0) };
  }).filter(function (l) { return l.total > 0; });
  linhas.sort(function (a, b) { return b.total - a.total || a.nome.localeCompare(b.nome); });
  var total = linhas.reduce(function (s, l) { return s + l.total; }, 0);

  var cartao = FONTE + "border:1px solid " + corBorda + ";border-radius:8px;overflow:hidden;background:" + T.cartao + ";margin:0 0 22px 0;";
  var faixa = "padding:10px 16px;background:" + mistura(cor, T.mistura, tema === "escuro" ? .18 : .1) +
    ";border-bottom:1px solid " + corBorda + ";border-left:4px solid " + cor + ";";
  var tit = FONTE + "margin:0;font-size:15px;font-weight:700;color:" + T.texto + ";";
  var cabecalho = '<div style="' + faixa + '"><p style="' + tit + '">' + esc(titulo) +
    ' · <span style="color:' + cor + '">' + fmt(total) + '</span> <span style="font-weight:400;color:' + T.apoio + ';font-size:13px">peças · ' +
    linhas.length + (linhas.length === 1 ? " pessoa" : " pessoas") + '</span></p></div>';
  if (!linhas.length) {
    return { html: '<div style="' + cartao + '">' + cabecalho + '<p style="' + FONTE + "margin:0;padding:14px 16px;font-size:13px;color:" + T.apoio + '">Sem produção até agora.</p></div>',
      total: 0, horas: [], pessoas: 0 };
  }
  var th = "padding:7px 10px;border:1px solid " + corBorda + ";background:" + cor + ";color:#fff;font-weight:600;font-size:12px;text-align:right;white-space:nowrap;";
  var td = "padding:5px 10px;border:1px solid " + T.borda + ";text-align:right;white-space:nowrap;color:" + T.texto + ";";
  var tdTot = "padding:6px 10px;border:1px solid " + corBorda + ";background:" + corTotal + ";text-align:right;white-space:nowrap;font-weight:700;color:" + T.texto + ";";
  var cab = '<tr><th style="' + th + 'text-align:left">' + esc(titulo) + "</th>" +
    horas.map(function (h) { return '<th style="' + th + '">' + rotHora(h) + "</th>"; }).join("") +
    '<th style="' + th + '">Total</th></tr>';
  var corpo = linhas.map(function (l, i) {
    var zebra = i % 2 ? "background:" + T.zebra + ";" : "background:" + T.cartao + ";";
    return '<tr><td style="' + td + zebra + 'text-align:left">' + esc(l.nome) + "</td>" +
      horas.map(function (h) { return '<td style="' + td + zebra + '">' + (l.arr[h] ? fmt(l.arr[h]) : '<span style="color:' + T.apoio + '">·</span>') + "</td>"; }).join("") +
      '<td style="' + td + zebra + "font-weight:700;color:" + cor + '">' + fmt(l.total) + "</td></tr>";
  }).join("");
  var rodape = '<tr><td style="' + tdTot + 'text-align:left">Total</td>' +
    horas.map(function (h) {
      var s = linhas.reduce(function (a, l) { return a + (l.arr[h] || 0); }, 0);
      return '<td style="' + tdTot + '">' + (s ? fmt(s) : '<span style="color:' + T.apoio + '">·</span>') + "</td>";
    }).join("") +
    '<td style="' + tdTot + "font-weight:800;color:" + cor + '">' + fmt(total) + "</td></tr>";
  return {
    html: '<div style="' + cartao + '">' + cabecalho +
      '<table style="' + FONTE + "border-collapse:collapse;font-size:13px;width:100%;background:" + T.cartao + '">' + cab + corpo + rodape + "</table></div>",
    total: total, horas: horas, pessoas: linhas.length
  };
}

/* ---------------- quem é de qual turno ---------------- */
// Pelo horário da 1ª produção do dia: antes das 15h = turno da manhã (T01 ou ADM), a partir daí = T02.
// Quem faz hora extra continua no próprio turno; as horas a mais viram coluna.
function turnoDaPessoa(arr, manha) {
  var primeira = null;
  (arr || []).forEach(function (v, i) { if (v > 0 && (primeira === null || ordemHora(i) < ordemHora(primeira))) primeira = i; });
  if (primeira === null) return null;
  return primeira < 15 ? manha : "T02";
}
// { usuario: [24] } -> { <manha>: { nome: [24] }, T02: {...} }
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
// a cada envio. A produção da hora é a diferença entre a última marca de cada hora.
function colmeiaPorUsuario(conferencia, dia) {
  var reg = doDia((conferencia || {}).colmeiaMarcas, dia), out = {};
  if (!reg) return out;
  var ultimaDaHora = {}, anterior = {};
  (reg.marcas || []).slice().sort(function (a, b) { return a[0] - b[0]; })
    .forEach(function (mk) { ultimaDaHora[Math.floor(mk[0] / 60) % 24] = mk[1] || {}; });
  Object.keys(ultimaDaHora).map(Number).sort(function (a, b) { return ordemHora(a) - ordemHora(b); }).forEach(function (h) {
    var acum = ultimaDaHora[h];
    Object.keys(acum).forEach(function (u) {
      var arr = out[u] || (out[u] = new Array(24).fill(0));
      arr[h] = Math.max(0, (acum[u] || 0) - (anterior[u] || 0));
      anterior[u] = acum[u];
    });
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
  TURNOS: TURNOS, CORES: CORES, TEMAS: TEMAS, FONTE: FONTE,
  ordemHora: ordemHora, rotHora: rotHora, fmt: fmt, esc: esc, dataBR: dataBR, mistura: mistura,
  tabela: tabela, porTurno: porTurno, turnoDaPessoa: turnoDaPessoa, somarEm: somarEm,
  analiticoPorUsuario: analiticoPorUsuario, colmeiaPorUsuario: colmeiaPorUsuario,
  expedicaoPorUsuario: expedicaoPorUsuario, armazenagemPorUsuario: armazenagemPorUsuario
};
