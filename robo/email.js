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

// Armazenagem: a mesma pessoa pode ter recebimento e reversa no dia, e cada um vira uma linha.
// A chave do mapa carrega o tipo; a tabela mostra isso na coluna "Tipo", à esquerda do usuário.
var MARCA_REVERSA = "\u0001R";
function usuarioDaChave(k) { return String(k).split("\u0001")[0]; }
function tipoDaChave(k) { return String(k).indexOf(MARCA_REVERSA) !== -1 ? "Reversa" : "Recebimento"; }

/* ---------------- uma tabela (um cartão por atividade) ---------------- */
// pessoas = { usuário: [24] peças por hora }; turnos (opcional) = { usuário: "T01" } acrescenta a coluna Turno
// à esquerda, usada nos e-mails de fechamento.  ->  { html, total, horas, pessoas }
function tabela(titulo, pessoas, cor, tema, turnos, extra, colTipo, fonteEm) {
  var email = tema === "email";                        // e-mail: paleta clara, sem zebra (ver nota abaixo)
  var T = TEMAS[tema === "escuro" ? "escuro" : "claro"];
  var corTotal = mistura(cor, T.mistura, T.pTotal);    // barra de totais: a mesma cor, mais fraca
  var corBorda = mistura(cor, T.borda, T.pBorda);
  var nomes = Object.keys(pessoas || {});
  var horas = [];
  nomes.forEach(function (n) { pessoas[n].forEach(function (v, h) { if (v > 0 && horas.indexOf(h) === -1) horas.push(h); }); });
  horas.sort(function (a, b) { return ordemHora(a) - ordemHora(b); });
  var linhas = nomes.map(function (n) {
    return { nome: n, arr: pessoas[n], total: pessoas[n].reduce(function (s, v) { return s + v; }, 0) };
  }).filter(function (l) { return l.total > 0; });
  // Recebimento primeiro, reversa depois (a coluna Tipo agrupa); dentro de cada um, do maior para o menor
  linhas.sort(function (a, b) {
    var ta = tipoDaChave(a.nome) === "Reversa" ? 1 : 0, tb = tipoDaChave(b.nome) === "Reversa" ? 1 : 0;
    return ta - tb || b.total - a.total || a.nome.localeCompare(b.nome);
  });
  var total = linhas.reduce(function (s, l) { return s + l.total; }, 0);

  /* CORES NO E-MAIL ---------------------------------------------------------
     Fundo e cor de texto SEMPRE no mesmo style da célula: assim o Teams inverte
     os dois juntos no tema escuro e nada some. O que quebrou em 17/11 foi a
     zebra feita com o atributo bgcolor + cor herdada — por isso as linhas de
     dados do e-mail não levam fundo nenhum. Barra de título e barra de totais
     mantêm as escalas de cor da atividade. */
  var cartao = FONTE + "border:1px solid " + corBorda + ";border-radius:8px;overflow:hidden;padding-bottom:10px;background:" + T.cartao + ";margin:0 0 10px 0;";
  var faixa = "padding:12px 16px;background:" + mistura(cor, T.mistura, tema === "escuro" ? .18 : .1) +
    ";border-bottom:1px solid " + corBorda + ";border-left:4px solid " + cor + ";";
  var tit = FONTE + "margin:0;font-size:18px;font-weight:800;color:" + T.texto + ";";
  var apoioTxt = "peças" + (extra ? " · " + esc(extra) : "") + " · " + linhas.length + (linhas.length === 1 ? " pessoa" : " pessoas");
  var cabecalho = '<div style="' + faixa + '"><p style="' + tit + '">' + esc(ATIVIDADE[titulo] || titulo) +
    ': <span style="color:' + cor + '">' + fmt(total) + '</span> <span style="font-weight:400;color:' + T.apoio + ';font-size:13px">' +
    apoioTxt + '</span></p></div>';
  if (!linhas.length) {
    return { html: '<div style="' + cartao + '">' + cabecalho + '<p style="' + FONTE + "margin:0;padding:14px 16px;font-size:13px;color:" + T.apoio + '">Sem produção até agora.</p></div>',
      total: 0, horas: [], pessoas: 0 };
  }
  // Enxuto porque o Teams corta acima de 24 KB: a borda vem do atributo da tabela e o respiro do
  // cellpadding; o style da célula leva só fundo e cor, e só onde há barra colorida.
  var colTurno = !!turnos;
  colTipo = !!colTipo;
  var claraDemais = ["#F6BD00", "#F5A524"].indexOf(cor) !== -1;      // amarelo e laranja pedem texto escuro
  var eTh = 'style="background:' + cor + ";color:" + (claraDemais ? "#1C2333" : "#fff") + '"';
  var eTot = 'style="background:' + corTotal + ";color:" + T.texto + '"';
  var zebra = email ? null : T.zebra;
  var tbl = '<table border="1" bordercolor="' + T.borda + '" cellspacing="0" cellpadding="5" style="' + FONTE +
    "border-collapse:collapse;font-size:13px;width:100%;text-align:right;white-space:nowrap;color:" + T.texto + ";background:" + T.cartao + '">';
  var cab = '<tr align="right" style="font-weight:600">' +
    (colTurno ? '<th align="left" ' + eTh + ">Turno</th>" : "") +
    (colTipo ? '<th align="left" ' + eTh + ">Tipo</th>" : "") + '<th align="left" ' + eTh + ">Usuário</th>" +
    horas.map(function (h) { return "<th " + eTh + ">" + rotHora(h) + "</th>"; }).join("") + "<th " + eTh + ">Total</th></tr>";
  var corpo = linhas.map(function (l, i) {
    var fundo = zebra && i % 2 ? ' bgcolor="' + zebra + '" style="color:' + T.texto + '"' : "";
    return '<tr align="right"' + fundo + ">" +
      (colTurno ? '<td align="left">' + esc(turnos[l.nome] || "—") + "</td>" : "") +
      (colTipo ? '<td align="left">' + tipoDaChave(l.nome) + "</td>" : "") +
      '<td align="left">' + esc(usuarioDaChave(l.nome)) + "</td>" +
      horas.map(function (h) { return "<td>" + (l.arr[h] ? fmt(l.arr[h]) : "·") + "</td>"; }).join("") +
      '<td style="color:' + cor + ';font-weight:700"><b>' + fmt(l.total) + "</b></td></tr>";
  }).join("");
  var rodape = '<tr align="right" style="font-weight:700">' + (colTurno ? "<td " + eTot + "></td>" : "") +
    (colTipo ? "<td " + eTot + "></td>" : "") +
    '<td align="left" ' + eTot + ">Total</td>" +
    horas.map(function (h) {
      var sm = linhas.reduce(function (a, l) { return a + (l.arr[h] || 0); }, 0);
      return "<td " + eTot + ">" + (sm ? fmt(sm) : "·") + "</td>";
    }).join("") +
    '<td style="background:' + corTotal + ";color:" + cor + ';font-weight:800"><b>' + fmt(total) + "</b></td></tr>";
  return {
    html: '<div style="' + cartao + '">' + cabecalho + tbl + cab + corpo + rodape + "</table>" + aviso(titulo, horas, fonteEm, T) + avisoVisitas(titulo, pessoas, T) + "</div>",
    total: total, horas: horas, pessoas: linhas.length
  };
}

// Rodapé da tabela: só quando a ÚLTIMA coluna ainda NÃO fechou, isto é, quando o WMS foi
// exportado dentro dessa mesma hora. Exportação às 10h05 com a tabela indo até 09h = hora
// fechada, sem aviso (18/11). Texto curto: o longo esticava a tabela no Teams.
function hhmmDe(ms) {
  if (!ms) return null;
  var d = new Date(ms);
  return String(d.getHours()).padStart(2, "0") + "h" + String(d.getMinutes()).padStart(2, "0");
}
function aviso(titulo, horas, fonteEm, T) {
  if (!horas || !horas.length || !fonteEm) return "";
  var ultima = horas[horas.length - 1];
  if (ordemHora(new Date(fonteEm).getHours()) > ordemHora(ultima)) return "";   // a hora já fechou
  return '<p style="' + FONTE + "margin:7px 0 0;padding:0 2px;font-size:11.5px;color:" + T.apoio + '">' +
    rotHora(ultima) + " parcial · exportado às " + hhmmDe(fonteEm) + "</p>";
}

// Legenda: itens processados por usuário do 2º turno que trabalhou de manhã (carga de outro turno).
// A produção fica no dia dele, na tabela da manhã; aqui só se avisa de onde veio (qualquer atividade).
function avisoVisitas(titulo, pessoas, T) {
  var v = pessoas && pessoas._visitasT2;
  if (!v || !v.total) return "";
  var hs = v.horas.slice().sort(function (a, b) { return ordemHora(a) - ordemHora(b); }).map(rotHora).join(", ");
  return '<p style="' + FONTE + "margin:4px 0 0;padding:0 2px;font-size:11.5px;color:" + T.apoio + '">' +
    fmt(v.total) + " itens processados às " + hs + " com " + (v.pessoas === 1 ? "um usuário" : v.pessoas + " usuários") + " do 2º turno</p>";
}

/* ---------------- quem é de qual turno ---------------- */
// Cadastro do RH (robo/turnos-wms.json, gerado pelo turnos.js a partir da lista de Ativos):
// { USUARIO.WMS: "T01" | "T02" | "ADM" }. É ele que manda; o horário da produção só decide
// quem não está no cadastro (temporário, terceiro, usuário de sistema).
var CADASTRO = (function () {
  try { return JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "turnos-wms.json"), "utf8")).turnos || {}; }
  catch (e) { return {}; }
})();
function turnoCadastrado(usuario) { return CADASTRO[usuarioDaChave(usuario).replace(/,/g, ".").toUpperCase()] || null; }

// Pelo PESO da produção até as 14h48, quando o T02 entra: quem produziu mais antes disso é da
// manhã (T01 ou ADM), senão é do T02. A 1ª produção sozinha não servia (o T02 começa 14h48 e as
// peças das 14h jogavam a turma do T02 para dentro do T01), e a janela cheia do ADM também não
// (ela vai até 17h33 e puxava a turma do Inbound T02 para o e-mail do ADM — 17/11). O ADM que
// trabalha depois das 15h continua no ADM: a maior parte das peças dele é de manhã.
// Quem faz hora extra continua no próprio turno; as horas a mais viram coluna.
function turnoDaPessoa(arr, manha) {
  var cfg = TURNOS[manha] || TURNOS.T01;
  var hIni = Math.floor(cfg.ini / 60), hFim = Math.floor(TURNOS.T02.ini / 60);   // 14: a virada dos turnos
  var dentro = 0, fora = 0, primeira = null;
  (arr || []).forEach(function (v, i) {
    if (!(v > 0)) return;
    if (primeira === null || ordemHora(i) < ordemHora(primeira)) primeira = i;
    if (i >= hIni && i <= hFim) dentro += v; else fora += v;
  });
  if (primeira === null) return null;
  if (dentro !== fora) return dentro > fora ? manha : "T02";
  return ordemHora(primeira) <= hFim ? manha : "T02";   // 00h–04h = ordemHora 24+: é a virada do T02
}
// { usuario: [24] } -> { <manha>: { nome: [24] }, T02: {...} }
function porTurno(porUsuario, nomes, manha) {
  var out = {}; out[manha] = {}; out.T02 = {};
  var visitas = { total: 0, horas: [], pessoas: 0 };   // produção de usuário do 2º turno dentro da tabela da manhã (legenda)
  Object.keys(porUsuario || {}).forEach(function (u) {
    var arr = porUsuario[u], cad = turnoCadastrado(u);
    // O cadastro do RH manda, com uma exceção: quem é T02 no cadastro mas produziu SÓ antes das 14h trabalhou de
    // manhã naquele dia (troca de turno, apoio): a produção dele fica no turno da manhã, senão some do e-mail do
    // T01 e a soma não bate com o telão (CARLOS.PAIXAO, 300 peças às 9h em 19/11).
    var soDeManha = false;
    if (cad === "T02") {
      var temHora = false, tarde = false;
      (arr || []).forEach(function (v, i) { if (!(v > 0)) return; temHora = true; if (ordemHora(i) >= Math.floor(TURNOS.T02.ini / 60)) tarde = true; });
      soDeManha = temHora && !tarde;
    }
    var t = cad ? (cad === "T02" && !soDeManha ? "T02" : manha) : turnoDaPessoa(arr, manha);
    if (!t || !somaDe(arr)) return;
    var nome = (nomes && nomes[u]) || u;
    var alvo = out[t][nome] || (out[t][nome] = new Array(24).fill(0));
    arr.forEach(function (v, h) { alvo[h] += v || 0; });
    if (soDeManha) {
      visitas.pessoas++;
      arr.forEach(function (v, h) { if (v > 0) { visitas.total += v; if (visitas.horas.indexOf(h) === -1) visitas.horas.push(h); } });
    }
  });
  // não enumerável: não aparece como "usuário" em quem percorre as chaves do mapa; a tabela lê daqui
  if (visitas.total) Object.defineProperty(out[manha], "_visitasT2", { value: visitas, enumerable: false });
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
function somaDe(arr) { return (arr || []).reduce(function (s, v) { return s + (v || 0); }, 0); }
function somarEm(destino, porUsuario) {
  Object.keys(porUsuario || {}).forEach(function (u) {
    var alvo = destino[u] || (destino[u] = new Array(24).fill(0));
    (porUsuario[u] || []).forEach(function (v, h) { alvo[h] += v || 0; });
  });
  return destino;
}

/* ---------------- leitura dos snapshots ---------------- */
function doDia(lista, dia) { return (lista || []).filter(function (x) { return x.data === dia; })[0] || null; }

/* DIA OPERACIONAL × DIA DO RELATÓRIO (17/11) -------------------------------
   Os snapshots guardam a produção pela DATA CIVIL do registro. Como o T02 vai
   até 00h16, a madrugada (00h–04h) do dia civil D é, na verdade, o fim do dia
   operacional D−1. Sem isso, a produção do T02 aparecia como coluna "00h" na
   tabela do T01 do dia seguinte.
   Dia operacional D = dia civil D sem a madrugada + a madrugada do dia D+1. */
var MADRUGADA = 5;
function proximoDia(iso) {
  var p = String(iso || "").split("-");
  if (p.length !== 3) return iso;
  var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + 1);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function recorte(mapa, madrugada) {
  var out = {};
  Object.keys(mapa || {}).forEach(function (u) {
    var a = new Array(24).fill(0), tem = 0;
    (mapa[u] || []).forEach(function (v, h) { if (!v) return; if ((h < MADRUGADA) !== !!madrugada) return; a[h] = v; tem = 1; });
    if (tem) out[u] = a;
  });
  return out;
}
// mapa do dia civil D (sem madrugada) + madrugada do dia civil D+1
function doDiaOperacional(mapaD, mapaD1) { return somarEm(recorte(mapaD, false), recorte(mapaD1, true)); }

// Separação e Conferência: analítico já traz [24] por usuário (checkout e colmeia).
function analiticoPorUsuario(analitico, dia, tipos) {
  var um = function (data) {
    var d = doDia(analitico, data), o = {};
    if (d) tipos.forEach(function (t) { somarEm(o, d[t] || {}); });
    return o;
  };
  return doDiaOperacional(um(dia), um(proximoDia(dia)));
}
// Conferência Colmeia não tem hora no relatório: as marcas guardam o acumulado do dia por operador
// a cada envio. A produção da hora é a diferença entre a última marca de cada hora.
function colmeiaPorUsuario(conferencia, dia) {
  // madrugada = true: só as horas 00h–04h (a virada do T02); false: o resto do dia.
  // O acumulado é do dia civil, então a madrugada do próprio dia serve de base e não vira coluna.
  var um = function (data, madrugada) {
    var reg = doDia((conferencia || {}).colmeiaMarcas, data), out = {};
    if (!reg) return out;
    var ultimaDaHora = {}, anterior = {};
    (reg.marcas || []).slice().sort(function (a, b) { return a[0] - b[0]; })
      .forEach(function (mk) { ultimaDaHora[Math.floor(mk[0] / 60) % 24] = mk[1] || {}; });
    Object.keys(ultimaDaHora).map(Number).sort(function (a, b) { return a - b; }).forEach(function (h) {
      var acum = ultimaDaHora[h], daMadrugada = h < MADRUGADA;
      Object.keys(acum).forEach(function (u) {
        if (daMadrugada === !!madrugada) {
          var arr = out[u] || (out[u] = new Array(24).fill(0));
          arr[h] = Math.max(0, (acum[u] || 0) - (anterior[u] || 0));
        }
        anterior[u] = acum[u];
      });
    });
    return out;
  };
  return somarEm(um(dia, false), um(proximoDia(dia), true));
}
// Expedição: expNfs tem usuário, minuto e peças de cada nota embarcada (2 dias mais recentes).
function expedicaoPorUsuario(op, dia) {
  var um = function (data) {
    var nfs = ((op || {}).expNfs || {})[data], o = {};
    Object.keys(nfs || {}).forEach(function (id) {
      var x = nfs[id]; if (!x) return;
      var arr = o[x[0]] || (o[x[0]] = new Array(24).fill(0));
      arr[Math.floor(x[1] / 60) % 24] += x[2] || 0;
    });
    return o;
  };
  return doDiaOperacional(um(dia), um(proximoDia(dia)));
}
// Armazenagem: normalUsuHoraDia já vem com o nome resolvido pela Base de ativos.
// Recebimento (endereços H/I/J) + reversa (endereços S) na mesma tabela: a reversa entra com a
// marca no fim da chave e vira uma linha "Reversa" (pedido 18/11 — antes só o recebimento contava).
function armazenagemPorUsuario(inbound, dia) {
  var arm = (inbound || {}).armazenagem || {};
  var um = function (lista, data) { var d = doDia(lista, data); return d ? d.itens || {} : {}; };
  var doDois = function (lista) { return doDiaOperacional(um(lista, dia), um(lista, proximoDia(dia))); };
  var out = somarEm({}, doDois(arm.normalUsuHoraDia));
  var rev = doDois(arm.reversaUsuHoraDia);
  Object.keys(rev).forEach(function (u) { out[u + MARCA_REVERSA] = rev[u]; });
  return out;
}

/* ---------------- os blocos (um por canal do Teams) ---------------- */
// t = { sep:{T01,T02}, conf:{T01,T02}, exp:{T01,T02}, arm:{ADM,T02} } com as peças por usuário e hora.
// Canais de setor levam a tabela só do turno deles; o canal Fechamento leva o dia inteiro, com a coluna Turno.
// Um bloco = um canal. O Outbound leva as 3 atividades na MESMA mensagem; se passar do
// limite do Teams, `mensagens()` quebra sozinho em uma mensagem por atividade.
function blocos(t) {
  var C = CORES, F = t.fontes || {};
  var rot = {
    sep: rotulosTurno([["T01", t.sep.T01], ["T02", t.sep.T02]]),
    conf: rotulosTurno([["T01", t.conf.T01], ["T02", t.conf.T02]]),
    exp: rotulosTurno([["T01", t.exp.T01], ["T02", t.exp.T02]]),
    arm: rotulosTurno([["ADM", t.arm.ADM], ["T02", t.arm.T02]])
  };
  return [
    // copiaFechamento: no fim do turno, o canal Fechamento recebe a mesma tabela.
    // Só T01 e ADM: o T02 não, porque a gestão recebe o agrupado do dia logo depois (17/11).
    { id: "out-t01", canal: "OUT_T01", copiaFechamento: "FECHAMENTO", tit: "Outbound · T01",
      tabelas: [["Separado", t.sep.T01, C.sep, null, 0, F.sep], ["Conferido", t.conf.T01, C.conf, null, 0, F.conf], ["Expedido", t.exp.T01, C.exp, null, 0, F.exp]] },
    { id: "out-t02", canal: "OUT_T02", tit: "Outbound · T02",
      tabelas: [["Separado", t.sep.T02, C.sep, null, 0, F.sep], ["Conferido", t.conf.T02, C.conf, null, 0, F.conf], ["Expedido", t.exp.T02, C.exp, null, 0, F.exp]] },
    { id: "in-adm", canal: "IN_ADM", copiaFechamento: "FECHAMENTO", tit: "Inbound · ADM", tabelas: [["Armazenado", t.arm.ADM, C.arm, null, 1, F.arm]] },
    { id: "in-t02", canal: "IN_T02", tit: "Inbound · T02", tabelas: [["Armazenado", t.arm.T02, C.arm, null, 1, F.arm]] },
    { id: "fech-dia-out", canal: "FECHAMENTO", dia: 1, tit: "Fechamento do dia · Outbound", tabelas: [
      ["Separado", juntarTurnos(t.sep.T01, t.sep.T02), C.sep, rot.sep, 0, F.sep],
      ["Conferido", juntarTurnos(t.conf.T01, t.conf.T02), C.conf, rot.conf, 0, F.conf],
      ["Expedido", juntarTurnos(t.exp.T01, t.exp.T02), C.exp, rot.exp, 0, F.exp]] },
    { id: "fech-dia-in", canal: "FECHAMENTO", dia: 1, tit: "Fechamento do dia · Inbound", tabelas: [
      ["Armazenado", juntarTurnos(t.arm.ADM, t.arm.T02), C.arm, rot.arm, 1, F.arm]] }
  ];
}
// O Teams corta e-mail acima de 24 KB (vira "Exibir email original" e a tabela some).
// Aqui se monta a(s) mensagem(ns) do bloco: uma só quando cabe, uma por atividade quando não cabe.
var LIMITE_TEAMS = 23000;   // o Teams corta em 24 KB; 23 KB segura a mensagem única por mais tempo (pedido 17/11)
function mensagens(bloco, dia, fech, horaTexto) {
  var html = corpoEmail(bloco, dia, fech, horaTexto);
  if (html.length <= LIMITE_TEAMS || bloco.tabelas.length < 2) {
    return [{ assunto: assuntoDe(bloco, dia, fech, horaTexto), html: html, tamanho: html.length }];
  }
  return bloco.tabelas.map(function (x) {
    var b = { tit: bloco.tit + " · " + (ATIVIDADE[x[0]] || x[0]).replace("Produtividade de ", ""), tabelas: [x] };
    var h = corpoEmail(b, dia, fech, horaTexto);
    b.dia = bloco.dia;
    return { assunto: assuntoDe(b, dia, fech, horaTexto), html: h, tamanho: h.length };
  });
}

// Corpo do e-mail: tabelas no tema claro (fundo branco do Outlook/Teams) e um rodapé curto.
function corpoEmail(bloco, dia, fech, horaTexto) {
  var ts = bloco.tabelas.map(function (x) { return tabela(x[0], x[1], x[2], "email", x[3], null, x[4], x[5]); });
  return '<div style="' + FONTE + 'padding:4px 2px">' + ts.map(function (t) { return t.html; }).join("<br><br>") + "</div>";
}
// O assunto vira o título da mensagem no canal do Teams: setor, turno, dia e a hora que a tabela
// mostra (17/11) — na hora cheia, a hora fechada; no fim do turno, "Fechamento". O e-mail do dia
// inteiro não leva sufixo: "Fechamento do dia · …" já está no título.
function rotuloAssunto(bloco, fech, horaTexto) {
  if (bloco.dia) return "";
  var m = /(\d{2}h\d{2})/.exec(String(horaTexto || ""));
  if (!fech && m) return m[1];
  return fech ? "Fechamento" : "";
}
function assuntoDe(bloco, dia, fech, horaTexto) {
  var r = rotuloAssunto(bloco, fech, horaTexto);
  return bloco.tit + " · " + dataBR(dia) + (r ? " · " + r : "");
}

module.exports = {
  TURNOS: TURNOS, CORES: CORES, TEMAS: TEMAS, FONTE: FONTE,
  ordemHora: ordemHora, rotHora: rotHora, fmt: fmt, esc: esc, dataBR: dataBR, mistura: mistura,
  blocos: blocos, corpoEmail: corpoEmail, assuntoDe: assuntoDe, mensagens: mensagens, LIMITE_TEAMS: LIMITE_TEAMS,
  tabela: tabela, porTurno: porTurno, turnoDaPessoa: turnoDaPessoa, somarEm: somarEm, juntarTurnos: juntarTurnos, rotulosTurno: rotulosTurno,
  turnoCadastrado: turnoCadastrado, usuarioDaChave: usuarioDaChave, tipoDaChave: tipoDaChave, analiticoPorUsuario: analiticoPorUsuario, colmeiaPorUsuario: colmeiaPorUsuario,
  expedicaoPorUsuario: expedicaoPorUsuario, armazenagemPorUsuario: armazenagemPorUsuario
};
