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
// Como cada atividade se chama no cabeçalho do cartão
var ATIVIDADE = { Separado: "Produtividade de Separação", Conferido: "Produtividade de Conferência",
                  Expedido: "Produtividade de Expedição", Armazenado: "Produtividade de Armazenagem" };

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
// pessoas = { usuário: [24] peças por hora }; turnos (opcional) = { usuário: "T01" } acrescenta a coluna Turno
// à esquerda, usada nos e-mails de fechamento.  ->  { html, total, horas, pessoas }
function tabela(titulo, pessoas, cor, tema, turnos, extra) {
  var neutro = tema === "email";                       // e-mail: ver a nota em MODO NEUTRO, abaixo
  var T = TEMAS[tema === "escuro" ? "escuro" : "claro"];
  var nomes = Object.keys(pessoas || {});
  var horas = [];
  nomes.forEach(function (n) { pessoas[n].forEach(function (v, h) { if (v > 0 && horas.indexOf(h) === -1) horas.push(h); }); });
  horas.sort(function (a, b) { return ordemHora(a) - ordemHora(b); });
  var linhas = nomes.map(function (n) {
    return { nome: n, arr: pessoas[n], total: pessoas[n].reduce(function (s, v) { return s + v; }, 0) };
  }).filter(function (l) { return l.total > 0; });
  linhas.sort(function (a, b) { return b.total - a.total || a.nome.localeCompare(b.nome); });
  var total = linhas.reduce(function (s, l) { return s + l.total; }, 0);

  /* MODO NEUTRO (e-mail) ----------------------------------------------------
     O Teams no tema escuro troca os fundos claros mas NÃO troca a cor do texto:
     linha com fundo claro + texto escuro vira texto invisível (17/11). Então no
     e-mail não vai fundo nenhum e nem cor de texto: só tons médios, que se leem
     em fundo claro e escuro. Cor fica no cabeçalho da tabela, na coluna Total e
     na barrinha do cartão. A prévia (tema claro/escuro) segue com fundo e zebra. */
  var apoio = neutro ? "#808A99" : T.apoio;
  var borda = neutro ? "#B9C0CC" : T.borda;
  var corBorda = neutro ? mistura(cor, "#B9C0CC", .45) : mistura(cor, T.borda, T.pBorda);
  var corTotal = neutro ? null : mistura(cor, T.mistura, T.pTotal);
  var fundoCartao = neutro ? "" : "background:" + T.cartao + ";";
  var fundoFaixa = neutro ? "" : "background:" + mistura(cor, T.mistura, tema === "escuro" ? .18 : .1) + ";";
  var corTexto = neutro ? "" : "color:" + T.texto + ";";

  var cartao = FONTE + "border:1px solid " + corBorda + ";border-radius:8px;overflow:hidden;padding-bottom:10px;" + fundoCartao + "margin:0 0 30px 0;";
  var faixa = "padding:10px 16px;" + fundoFaixa + "border-bottom:1px solid " + corBorda + ";border-left:4px solid " + cor + ";";
  var tit = FONTE + "margin:0;font-size:15px;font-weight:700;" + corTexto;
  var apoioTxt = "peças" + (extra ? " · " + esc(extra) : "") + " · " + linhas.length + (linhas.length === 1 ? " pessoa" : " pessoas");
  var cabecalho = '<div style="' + faixa + '"><p style="' + tit + '">' + esc(ATIVIDADE[titulo] || titulo) +
    ': <span style="color:' + cor + '">' + fmt(total) + '</span> <span style="font-weight:400;color:' + apoio + ';font-size:13px">' +
    apoioTxt + '</span></p></div>';
  if (!linhas.length) {
    return { html: '<div style="' + cartao + '">' + cabecalho + '<p style="' + FONTE + "margin:0;padding:14px 16px;font-size:13px;color:" + apoio + '">Sem produção até agora.</p></div>',
      total: 0, horas: [], pessoas: 0 };
  }
  // HTML enxuto: o Teams corta acima de 24 KB. Estilo na tabela e na linha; atributo na célula.
  var colTurno = !!turnos;
  var linhaClara = neutro ? "" : ' bgcolor="' + T.cartao + '" style="color:' + T.texto + '"';
  var linhaZebra = neutro ? "" : ' bgcolor="' + T.zebra + '" style="color:' + T.texto + '"';
  var tbl = '<table border="1" bordercolor="' + borda + '" cellspacing="0" cellpadding="5" style="' + FONTE +
    "border-collapse:collapse;font-size:13px;width:100%;text-align:right;" + (neutro ? "" : "color:" + T.texto + ";background:" + T.cartao + ";") + '">';
  // cabeçalho: fundo cheio na cor da atividade; nas cores claras (amarelo/laranja) o texto vai escuro
  var claraDemais = ["#F6BD00", "#F5A524"].indexOf(cor) !== -1;
  var cab = '<tr bgcolor="' + cor + '" style="color:' + (claraDemais ? "#1C2333" : "#fff") + ';font-weight:600">' +
    (colTurno ? '<th align="left">Turno</th>' : "") + '<th align="left">Usuário</th>' +
    horas.map(function (h) { return "<th>" + rotHora(h) + "</th>"; }).join("") + "<th>Total</th></tr>";
  var corpo = linhas.map(function (l, i) {
    return "<tr" + (i % 2 ? linhaZebra : linhaClara) + ">" +
      (colTurno ? '<td align="left">' + esc(turnos[l.nome] || "—") + "</td>" : "") +
      '<td align="left">' + esc(l.nome) + "</td>" +
      horas.map(function (h) { return "<td>" + (l.arr[h] ? fmt(l.arr[h]) : "·") + "</td>"; }).join("") +
      '<td style="color:' + cor + ';font-weight:700">' + fmt(l.total) + "</td></tr>";
  }).join("");
  var rodape = "<tr" + (neutro ? ' style="font-weight:700"' : ' bgcolor="' + corTotal + '" style="font-weight:700;color:' + T.texto + '"') + ">" +
    (colTurno ? "<td></td>" : "") + '<td align="left">Total</td>' +
    horas.map(function (h) {
      var sm = linhas.reduce(function (a, l) { return a + (l.arr[h] || 0); }, 0);
      return "<td>" + (sm ? fmt(sm) : "·") + "</td>";
    }).join("") +
    '<td style="color:' + cor + '">' + fmt(total) + "</td></tr>";
  return {
    html: '<div style="' + cartao + '">' + cabecalho + tbl + cab + corpo + rodape + "</table></div>",
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
// Fechamento do dia: os turnos somados numa tabela só (quem trabalhou nos dois aparece uma vez,
// com as horas lado a lado). Vale para a Armazenagem (ADM + T02) e para o Outbound (T01 + T02).
function juntarTurnos() {
  var out = {};
  Array.prototype.forEach.call(arguments, function (m) { somarEm(out, m || {}); });
  return out;
}
// Quem aparece em mais de um turno no fechamento vira "ADM+T02" (ou "T01+T02").
// mapas = [["ADM", {...}], ["T02", {...}]]  ->  { usuário: "ADM" }
function rotulosTurno(mapas) {
  var r = {};
  (mapas || []).forEach(function (par) {
    Object.keys(par[1] || {}).forEach(function (u) { r[u] = r[u] ? r[u] + "+" + par[0] : par[0]; });
  });
  return r;
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

/* ---------------- os blocos (um por canal do Teams) ---------------- */
// t = { sep:{T01,T02}, conf:{T01,T02}, exp:{T01,T02}, arm:{ADM,T02} } com as peças por usuário e hora.
// Canais de setor levam a tabela só do turno deles; o canal Fechamento leva o dia inteiro, com a coluna Turno.
// Um bloco = um canal. O Outbound leva as 3 atividades na MESMA mensagem; se passar do
// limite do Teams, `mensagens()` quebra sozinho em uma mensagem por atividade.
function blocos(t) {
  var C = CORES;
  var rot = {
    sep: rotulosTurno([["T01", t.sep.T01], ["T02", t.sep.T02]]),
    conf: rotulosTurno([["T01", t.conf.T01], ["T02", t.conf.T02]]),
    exp: rotulosTurno([["T01", t.exp.T01], ["T02", t.exp.T02]]),
    arm: rotulosTurno([["ADM", t.arm.ADM], ["T02", t.arm.T02]])
  };
  return [
    { id: "out-t01", canal: "OUT_T01", tit: "Outbound · T01",
      tabelas: [["Separado", t.sep.T01, C.sep], ["Conferido", t.conf.T01, C.conf], ["Expedido", t.exp.T01, C.exp]] },
    { id: "out-t02", canal: "OUT_T02", tit: "Outbound · T02",
      tabelas: [["Separado", t.sep.T02, C.sep], ["Conferido", t.conf.T02, C.conf], ["Expedido", t.exp.T02, C.exp]] },
    { id: "in-adm", canal: "IN_ADM", tit: "Inbound · ADM", tabelas: [["Armazenado", t.arm.ADM, C.arm]] },
    { id: "in-t02", canal: "IN_T02", tit: "Inbound · T02", tabelas: [["Armazenado", t.arm.T02, C.arm]] },
    { id: "fech-dia-out", canal: "FECHAMENTO", dia: 1, tit: "Fechamento do dia · Outbound", tabelas: [
      ["Separado", juntarTurnos(t.sep.T01, t.sep.T02), C.sep, rot.sep],
      ["Conferido", juntarTurnos(t.conf.T01, t.conf.T02), C.conf, rot.conf],
      ["Expedido", juntarTurnos(t.exp.T01, t.exp.T02), C.exp, rot.exp]] },
    { id: "fech-dia-in", canal: "FECHAMENTO", dia: 1, tit: "Fechamento do dia · Inbound", tabelas: [
      ["Armazenado", juntarTurnos(t.arm.ADM, t.arm.T02), C.arm, rot.arm]] }
  ];
}
// O Teams corta e-mail acima de 24 KB (vira "Exibir email original" e a tabela some).
// Aqui se monta a(s) mensagem(ns) do bloco: uma só quando cabe, uma por atividade quando não cabe.
var LIMITE_TEAMS = 20000;   // margem de segurança sobre os 24 KB
function mensagens(bloco, dia, fech, horaTexto) {
  var html = corpoEmail(bloco, dia, fech, horaTexto);
  if (html.length <= LIMITE_TEAMS || bloco.tabelas.length < 2) {
    return [{ assunto: assuntoDe(bloco, dia), html: html, tamanho: html.length }];
  }
  return bloco.tabelas.map(function (x) {
    var b = { tit: bloco.tit + " · " + (ATIVIDADE[x[0]] || x[0]).replace("Produtividade de ", ""), tabelas: [x] };
    var h = corpoEmail(b, dia, fech, horaTexto);
    return { assunto: assuntoDe(b, dia), html: h, tamanho: h.length };
  });
}

// Corpo do e-mail: tabelas no tema claro (fundo branco do Outlook/Teams) e um rodapé curto.
function corpoEmail(bloco, dia, fech, horaTexto) {
  var ts = bloco.tabelas.map(function (x) { return tabela(x[0], x[1], x[2], "email", x[3]); });
  return '<div style="' + FONTE + 'padding:4px 2px">' + ts.map(function (t) { return t.html; }).join("") + "</div>";
}
// O assunto vira o título da mensagem no canal do Teams: só o setor, o turno e o dia.
function assuntoDe(bloco, dia) { return bloco.tit + " · " + dataBR(dia); }

module.exports = {
  TURNOS: TURNOS, CORES: CORES, TEMAS: TEMAS, FONTE: FONTE,
  ordemHora: ordemHora, rotHora: rotHora, fmt: fmt, esc: esc, dataBR: dataBR, mistura: mistura,
  blocos: blocos, corpoEmail: corpoEmail, assuntoDe: assuntoDe, mensagens: mensagens, LIMITE_TEAMS: LIMITE_TEAMS,
  tabela: tabela, porTurno: porTurno, turnoDaPessoa: turnoDaPessoa, somarEm: somarEm, juntarTurnos: juntarTurnos, rotulosTurno: rotulosTurno,
  analiticoPorUsuario: analiticoPorUsuario, colmeiaPorUsuario: colmeiaPorUsuario,
  expedicaoPorUsuario: expedicaoPorUsuario, armazenagemPorUsuario: armazenagemPorUsuario
};
