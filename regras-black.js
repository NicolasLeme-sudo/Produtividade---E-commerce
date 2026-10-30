/* =========================================================================
   REGRAS-BLACK.JS — Missão Black Friday 2026 (27, 28 e 29/11)
   Único lugar com os valores da pontuação. Usado pelo telão (placar), pela
   tela de lançamento (ingest.js) e pelo documento de regras dos pisos.
   Mudou um valor aqui, muda em todos.
   ========================================================================= */
(function (global) {
'use strict';

var DIAS = [['2026-11-27', '27/11', 'Largada Black'], ['2026-11-28', '28/11', 'Superação'], ['2026-11-29', '29/11', 'Grande Final']];

// Horário de cada turno em minutos desde 00:00 (o T02 passa da meia-noite: 1456 = 00:16 do dia seguinte).
var TURNOS = {
  '1º Turno': { ini: 5 * 60, fim: 14 * 60 + 48, rot: 'T01 · 05h00–14h48' },
  '2º Turno': { ini: 14 * 60 + 48, fim: 24 * 60 + 16, rot: 'T02 · 14h48–00h16' },
  'ADM':      { ini: 7 * 60 + 55, fim: 17 * 60 + 33, rot: 'ADM · 07h55–17h33' }
};

// Pontos do piso (meta 2.000 peças/dia). A colmeia (meta 1.200) recebe os fixos × FATOR_COLMEIA.
var FATOR_COLMEIA = 0.6;
var P = {
  porPeca: 1,             // cada peça separada ou conferida
  metaBatida: 200,        // bateu 100% da meta do dia
  antecipadaHora: 50,     // por hora inteira antes do fim do turno
  antecipadaMax: 200,
  assiduidadeMax: 500,    // × presentes ÷ escalados (atestado conta como falta)
  atraso: -20,            // por pessoa atrasada
  desafiosMax: 300,       // soma dos desafios no dia
  destaque: 50,           // ao time do top separador e do top conferente do turno
  vistoriaLimpa: 100,     // vistoria do dia sem nenhum apontamento
  trincaPerfeita: 200     // 100% de presença nos 3 dias (vai para o acumulado)
};

// Checklist da vistoria — estilo autoescola. Cada item marcado desconta os pontos da gravidade.
var GRAVIDADES = { leve: { rot: 'Leve', pts: -20 }, media: { rot: 'Média', pts: -50 }, grave: { rot: 'Grave', pts: -100 }, gravissima: { rot: 'Gravíssima', pts: -200 } };
var CHECKLIST = [
  ['leve', 'Lixo, fita ou plástico no chão'],
  ['leve', 'Carrinho ou paleteira fora da vaga'],
  ['leve', 'Etiqueta solta ou caída'],
  ['leve', 'Material de apoio fora do lugar'],
  ['media', 'Caixa aberta ou avariada no picking'],
  ['media', 'Endereço misturado ou desorganizado'],
  ['media', 'Volume deixado no corredor'],
  ['media', 'EPI incompleto (luva, protetor)'],
  ['grave', 'Rota de fuga ou extintor obstruído'],
  ['grave', 'Sem EPI obrigatório (calçado, colete)'],
  ['grave', 'Empilhamento acima do limite'],
  ['gravissima', 'Subir em estante ou prateleira'],
  ['gravissima', 'Correr ou manobrar carrinho de forma perigosa'],
  ['gravissima', 'Descumprir orientação de segurança']
].map(function (x) { return { grav: x[0], item: x[1], pts: GRAVIDADES[x[0]].pts }; });

// Desafios do calendário da gerência (até 100 pts cada no piso; 3 por dia = desafiosMax).
var DESAFIOS = {
  '2026-11-27': ['Quiz relâmpago', 'Grito da equipe', 'Missão surpresa'],
  '2026-11-28': ['Golden Ticket', 'Desafio relâmpago', 'Espírito de equipe'],
  '2026-11-29': ['Quiz final', 'Desafio surpresa', 'Equipe mais engajada']
};
var PONTOS_DESAFIO = 100;

function fator(time) { return time >= 5 ? FATOR_COLMEIA : 1; }   // times 5 e 6 = colmeia
function pts(valor, time) { return Math.round(valor * fator(time)); }
function isoLocal(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

// Turno em andamento agora (T01 ou T02; o ADM só aparece se pedido) e o dia "da Black" dele:
// depois da meia-noite o T02 ainda pertence ao dia anterior.
function turnoAtual(agora, comAdm) {
  agora = agora || new Date();
  var min = agora.getHours() * 60 + agora.getMinutes(), dia = new Date(agora);
  if (comAdm && min >= TURNOS.ADM.ini && min < TURNOS.ADM.fim) return { turno: 'ADM', dia: isoLocal(dia) };
  if (min >= TURNOS['1º Turno'].ini && min < TURNOS['1º Turno'].fim) return { turno: '1º Turno', dia: isoLocal(dia) };
  if (min < TURNOS['1º Turno'].ini) { dia.setDate(dia.getDate() - 1); return { turno: '2º Turno', dia: isoLocal(dia), madrugada: true }; }
  return { turno: '2º Turno', dia: isoLocal(dia) };
}

// Peças por hora (0–23) de cada membro, a partir dos analíticos do snapshot outbound.
// chaves = { sep_checkout:'NOME.X', sep_colmeia:..., conf_checkout:... } (as achadas pela conta da competição).
function horasDoMembro(snap, dia, chaves) {
  var h = new Array(24).fill(0), s = snap || {};
  [['separacao', 'checkout', 'sep_checkout'], ['separacao', 'colmeia', 'sep_colmeia'], ['conferencia', 'checkout', 'conf_checkout']].forEach(function (f) {
    var k = chaves && chaves[f[2]];
    if (!k) return;
    ((s[f[0]] || {}).analitico || []).forEach(function (d) {
      if (String(d.data).slice(0, 10) !== dia) return;
      var porUsu = d[f[1]] || {};
      Object.keys(porUsu).forEach(function (u) {
        if (chaveUsu(u) === k) (porUsu[u] || []).forEach(function (v, i) { h[i] += v || 0; });
      });
    });
  });
  return h;
}
function chaveUsu(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/,/g, '.').trim().toUpperCase(); }

// Placar de UM dia de UM turno.
//   c         = resultado de calcularCompeticao(snap, cadastroDoTurno, dia) — times com total, meta, lista (membros com sep/conf/chaves)
//   cadastro  = linhas de competicao_times do turno (com presenca)
//   lanc      = linhas de competicao_pontos do dia/turno
//   ouro      = linhas de competicao_hora_ouro do dia/turno
function placarDoDia(o) {
  var c = o.c, dia = o.dia, turno = o.turno, T = TURNOS[turno] || TURNOS['1º Turno'];
  var agoraMin = o.agora ? o.agora.getHours() * 60 + o.agora.getMinutes() : 24 * 60;
  var times = c.times.filter(function (t) { return t.lista.length || (o.cadastro || []).some(function (r) { return r.time === t.n; }); });

  // destaques: top separador e top conferente do turno, em cada grupo (piso / colmeia)
  var destaques = {};
  [false, true].forEach(function (colmeia) {
    ['sep', 'conf'].forEach(function (g) {
      var top = null;
      times.filter(function (t) { return t.colmeia === colmeia; }).forEach(function (t) {
        t.lista.forEach(function (m) { if (m[g] > 0 && (!top || m[g] > top.m[g])) top = { t: t.n, m: m }; });
      });
      if (top) (destaques[top.t] = destaques[top.t] || []).push({ funcao: g === 'sep' ? 'Separação' : 'Conferência', nome: top.m.nome || top.m.usuario, pecas: top.m[g] });
    });
  });

  var linhas = times.map(function (t) {
    var n = t.n;
    // horas do time (soma dos membros); se o analítico não cobre tudo (ex.: conferência colmeia), escala para o total do dia
    var horas = new Array(24).fill(0);
    t.lista.forEach(function (m) { horasDoMembro(o.snap, dia, m.chaves).forEach(function (v, i) { horas[i] += v; }); });
    var somaH = horas.reduce(function (a, b) { return a + b; }, 0), esc = somaH && t.total > somaH ? t.total / somaH : 1;

    var r = { n: n, cor: t.cor, colmeia: t.colmeia, pecas: t.total, meta: t.meta, detalhe: [] };
    r.produtividade = Math.round(t.total * P.porPeca);

    // meta batida + antecipada
    r.metaBatida = t.total >= t.meta && t.meta ? pts(P.metaBatida, n) : 0;
    r.antecipada = 0; r.horaMeta = null;
    if (r.metaBatida) {
      var cum = 0;
      for (var h = 0; h < 24; h++) { cum += horas[h] * esc; if (cum >= t.meta) { r.horaMeta = h + 1; break; } }
      if (r.horaMeta != null) {
        var antes = Math.floor((T.fim - r.horaMeta * 60) / 60);
        r.antecipada = Math.min(pts(P.antecipadaMax, n), Math.max(0, antes) * pts(P.antecipadaHora, n));
      }
    }

    // hora de ouro: peças da hora valem 2× se o time bater a meta da hora (só depois que a hora termina)
    r.ouro = 0; r.ouroDetalhe = [];
    (o.ouro || []).forEach(function (g) {
      var meta = t.colmeia ? g.meta_colmeia : g.meta_piso, feitas = Math.round(horas[g.hora] * esc);
      var terminou = !o.agora || dia < isoLocal(o.agora) || agoraMin >= (g.hora + 1) * 60;
      var bateu = terminou && feitas >= meta;
      if (bateu) r.ouro += feitas;
      r.ouroDetalhe.push({ hora: g.hora, meta: meta, feitas: feitas, terminou: terminou, bateu: bateu });
    });

    // assiduidade: máximo × presentes ÷ escalados (só quem tem presença lançada no dia)
    var pessoas = {};
    (o.cadastro || []).forEach(function (row) { if (row.time === n && row.presenca && row.presenca[dia]) pessoas[row.usuario_wms] = row.presenca[dia]; });
    var marcas = Object.keys(pessoas).map(function (k) { return pessoas[k]; });
    r.escalados = marcas.length;
    r.presentes = marcas.filter(function (v) { return v === 'P' || v === 'A'; }).length;
    r.atrasos = marcas.filter(function (v) { return v === 'A'; }).length;
    r.faltas = r.escalados - r.presentes;
    r.assiduidade = r.escalados ? Math.max(0, Math.round(pts(P.assiduidadeMax, n) * r.presentes / r.escalados) + r.atrasos * pts(P.atraso, n)) : 0;
    r.presenca100 = r.escalados > 0 && r.faltas === 0;

    // lançamentos manuais
    var doTime = (o.lanc || []).filter(function (l) { return l.time === n; });
    var soma = function (cat) { return doTime.filter(function (l) { return l.categoria === cat; }).reduce(function (s, l) { return s + (l.pontos || 0); }, 0); };
    r.desafios = Math.min(pts(P.desafiosMax, n), soma('desafio'));
    r.segQual = soma('vistoria');
    r.ajustes = soma('ajuste');
    r.lancamentos = doTime;

    r.destaques = destaques[n] || [];
    r.destaque = r.destaques.length * pts(P.destaque, n);
    r.bonus = r.metaBatida + r.antecipada + r.ouro + r.destaque + r.ajustes;
    r.total = r.produtividade + r.assiduidade + r.desafios + r.segQual + r.bonus;
    return r;
  });
  return { dia: dia, turno: turno, linhas: linhas };
}

// Soma dos dias + Trinca Perfeita (100% de presença nos 3 dias).
function acumulado(placares) {
  var porTime = {};
  placares.forEach(function (p) {
    p.linhas.forEach(function (r) {
      var a = porTime[r.n] = porTime[r.n] || { n: r.n, total: 0, dias: 0, dias100: 0 };
      a.total += r.total; a.dias++; if (r.presenca100) a.dias100++;
    });
  });
  Object.keys(porTime).forEach(function (k) {
    var a = porTime[k];
    a.trinca = a.dias100 === DIAS.length ? pts(P.trincaPerfeita, a.n) : 0;
    a.total += a.trinca;
  });
  return porTime;
}

global.RegrasBlack = {
  DIAS: DIAS, TURNOS: TURNOS, P: P, FATOR_COLMEIA: FATOR_COLMEIA, GRAVIDADES: GRAVIDADES, CHECKLIST: CHECKLIST,
  DESAFIOS: DESAFIOS, PONTOS_DESAFIO: PONTOS_DESAFIO, fator: fator, pts: pts, turnoAtual: turnoAtual,
  placarDoDia: placarDoDia, acumulado: acumulado, isoLocal: isoLocal
};
})(typeof window !== 'undefined' ? window : globalThis);
