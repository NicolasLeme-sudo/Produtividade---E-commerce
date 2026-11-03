/* =========================================================================
   REGRAS-BLACK.JS — Missão Black Friday 2026 (27, 28 e 29/11)
   Único lugar com os valores da pontuação e com a conta da competição usada
   pelo telão (Corrida) e pela planilha de pontos da tela de lançamento
   (ingest.js). Também alimenta o documento de regras dos pisos.
   Mudou um valor aqui, muda em todos.
   ========================================================================= */
(function (global) {
'use strict';

var DIAS = [['2026-11-27', '27/11', 'Largada Black'], ['2026-11-28', '28/11', 'Superação'], ['2026-11-29', '29/11', 'Grande Final']];

// Horário de cada turno em minutos desde 00:00 (o T02 passa da meia-noite: 1456 = 00:16 do dia seguinte).
var TURNOS = {
// almoco = [início, fim] em minutos: não conta como hora trabalhada na meta antecipada (T02 ainda sem horário).
  '1º Turno': { ini: 5 * 60, fim: 14 * 60 + 48, almoco: [11 * 60 + 30, 12 * 60 + 30], rot: 'T01 · 05h00–14h48' },
  '2º Turno': { ini: 14 * 60 + 48, fim: 24 * 60 + 16, almoco: null, rot: 'T02 · 14h48–00h16' },
  'ADM':      { ini: 7 * 60 + 55, fim: 17 * 60 + 33, almoco: [12 * 60 + 15, 13 * 60 + 15], rot: 'ADM · 07h55–17h33' }
};

// Pontos do piso (meta 2.000 peças/dia). A colmeia (meta 1.200) recebe os fixos × FATOR_COLMEIA.
var FATOR_COLMEIA = 0.6;
var P = {
  porPeca: 1,             // cada peça separada ou conferida
  metaBatida: 200,        // bateu 100% da meta do dia
  antecipadaHora: 100,    // por hora antes do fim do turno, proporcional aos minutos (sem teto)
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
// Banco de gincanas entre pisos (qualquer dia).
var GINCANAS = ['Acerte o alvo', 'Corrida do palete', 'Montagem relâmpago', 'Quebra-cabeça da Black', 'Quem canta ganha',
  'Corrida de entregas', 'Desafio dos líderes', 'TikTok dos líderes', 'Grito de guerra do time'];
var GINCANAS_DESC = {
  'Acerte o alvo': 'Caixas de sapato abertas coladas num palete: ganha quem acertar mais bolinhas.',
  'Corrida do palete': 'Empurrar um palete vazio de um ponto ao outro no menor tempo.',
  'Montagem relâmpago': 'Montar o maior número de caixas corretamente em 1 minuto.',
  'Quebra-cabeça da Black': 'Cada equipe monta o quebra-cabeça com o tema da campanha: ganha quem terminar primeiro.',
  'Quem canta ganha': '5 segundos de música e o grupo precisa adivinhar o nome.',
  'Corrida de entregas': 'Levar todas as caixas vazias até o ponto final sem deixar cair.',
  'Desafio dos líderes': 'Provas rápidas entre líderes, como a corrida da colher com bolinha.',
  'TikTok dos líderes': 'Os líderes dançam a coreografia escolhida pela equipe e o público vota no "Líder do Ritmo".',
  'Grito de guerra do time': 'Cada time cria e apresenta o seu grito de guerra.'
};

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

/* ---------- Conta da competição (filtros fixos: separação + conferência, checkout + colmeia) ----------
   Usada pelo telão (Corrida) e pela planilha "Extrair descontos e adições" (ingest.js).
   O index.html tem a versão dele, com os filtros da tela. */
var NUM_TIMES = [1, 2, 3, 4, 5, 6], TIMES_COLMEIA = { 5: true, 6: true };
var META_DIA_TIME = { 1: 2000, 2: 2000, 3: 2000, 4: 2000, 5: 1200, 6: 1200 };   // provisória
var CONECTIVOS = ['DE', 'DA', 'DO', 'DAS', 'DOS', 'E'];
function chavesDoMembro(r) {
  var ks = [chaveUsu(r.usuario_wms), chaveUsu(r.nome)];
  var t = chaveUsu(r.nome).split(/\s+/).filter(function (x) { return x && CONECTIVOS.indexOf(x) === -1; });
  if (t.length > 1) { t.slice(1).reverse().forEach(function (x) { ks.push(t[0] + '.' + x); }); if (t.length > 2) ks.push(t[0] + '.' + t[1].charAt(0) + '.' + t[t.length - 1]); }
  return ks.filter(function (k, i) { return k && ks.indexOf(k) === i; });
}
// Filtro "Dia": de cada série, só o último dia que existe nela.
function ultimoDia(serie) { if (!serie || !serie.length) return []; var o = serie.slice().sort(function (a, b) { return String(a.data).localeCompare(String(b.data)); }); return o.slice(-1); }
function producaoDaFonte(snap, fonte, diaAlvo) {
  var o = snap || {}, sep = o.separacao || {}, conf = o.conferencia || {};
  var f = { sep_checkout: { v: sep.checkoutDia }, sep_colmeia: { v: sep.colmeiaDia }, conf_checkout: { v: conf.confCheckoutDia }, conf_colmeia: { v: conf.confColmeiaUnitDia } }[fonte];
  var m = new Map(), datas = [];
  var serie = diaAlvo ? (f.v || []).filter(function (d) { return String(d.data).slice(0, 10) === diaAlvo; }) : ultimoDia(f.v);
  serie.forEach(function (d) { datas.push(String(d.data).slice(0, 10)); Object.keys(d.itens || {}).forEach(function (n) { var k = chaveUsu(n); m.set(k, (m.get(k) || 0) + (d.itens[n] || 0)); }); });
  return { valores: m, datas: datas, temDados: !!(f.v && f.v.length) };
}
function grupoDoCadastro(r) { return /^sep/.test(r.atividade) ? 'sep' : 'conf'; }
function obsColmeia(r) { return r.observacao === 'Colmeia' || r.atividade === 'conf_colmeia' || r.atividade === 'sep_colmeia'; }
function opsDoCadastro(r) { return (!r.lider && (TIMES_COLMEIA[r.time] || obsColmeia(r))) ? ['colmeia'] : ['checkout', 'colmeia']; }
// snap = dados do snapshot outbound · cadastro = linhas de competicao_times · diaAlvo = 'aaaa-mm-dd' (vazio = último dia)
function calcularCompeticao(snap, cadastro, diaAlvo) {
  var ops = ['checkout', 'colmeia'], grupos = ['sep', 'conf'], prod = {};
  ['sep_checkout', 'sep_colmeia', 'conf_checkout', 'conf_colmeia'].forEach(function (f) { prod[f] = producaoDaFonte(snap, f, diaAlvo); });
  var times = NUM_TIMES.map(function (n) { return { n: n, colmeia: !!TIMES_COLMEIA[n], membros: new Map() }; });
  var linhas = (cadastro || []).filter(function (r) { return times[r.time - 1]; });
  var exatos = {}; linhas.forEach(function (r) { exatos[chaveUsu(r.usuario_wms)] = r.usuario_wms; });
  function achar(r, mapa) { var achada = null; chavesDoMembro(r).some(function (k, i) { if (i > 0 && exatos[k] && exatos[k] !== r.usuario_wms) return false; if (mapa.has(k)) { achada = k; return true; } return false; }); return achada; }
  var porCadastro = new Map();
  linhas.forEach(function (r) { var k = r.usuario_wms + '|' + grupoDoCadastro(r); if (!porCadastro.has(k)) porCadastro.set(k, r); });
  porCadastro.forEach(function (r) {
    var t = times[r.time - 1], g = grupoDoCadastro(r);
    var m = t.membros.get(r.usuario_wms) || { usuario: r.usuario_wms, nome: r.nome, sep: 0, conf: 0, grupos: {}, chaves: {} };
    m.grupos[g] = true;
    opsDoCadastro(r).forEach(function (o) { var f = g + '_' + o, k = achar(r, prod[f].valores); if (k) { m[g] += prod[f].valores.get(k) || 0; m.chaves[f] = k; } });
    if (r.lider && !t.membros.has(r.usuario_wms) && !(m.sep + m.conf)) return;   // líder sem produção não entra como membro
    t.membros.set(r.usuario_wms, m);
  });
  var datas = {};
  times.forEach(function (t) {
    t.lista = Array.from(t.membros.values()).filter(function (m) { return m.grupos.sep || m.grupos.conf; }).map(function (m) { m.valor = m.sep + m.conf; return m; }).sort(function (a, b) { return b.valor - a.valor; });
    t.sep = t.lista.reduce(function (s, m) { return s + m.sep; }, 0); t.conf = t.lista.reduce(function (s, m) { return s + m.conf; }, 0); t.total = t.sep + t.conf;
  });
  grupos.forEach(function (g) { ops.forEach(function (o) { prod[g + '_' + o].datas.forEach(function (d) { datas[d] = 1; }); }); });
  [times.filter(function (t) { return !t.colmeia; }), times.filter(function (t) { return t.colmeia; })].forEach(function (gr) {
    gr.slice().sort(function (a, b) { return (b.lista.length ? 1 : 0) - (a.lista.length ? 1 : 0) || b.total - a.total; }).forEach(function (t, i) { t.pos = t.lista.length ? i + 1 : null; });
  });
  var dias = Math.max(1, Object.keys(datas).length);
  times.forEach(function (t) { t.meta = META_DIA_TIME[t.n] * dias; });
  var dia = Object.keys(datas).sort().pop() || null;
  var temDados = grupos.some(function (g) { return ops.some(function (o) { return prod[g + '_' + o].temDados; }); });
  return { times: times, dia: dia, temDados: temDados };
}

// Minutos de trabalho entre dois minutos do dia, sem o intervalo de almoço do turno.
function minutosTrabalhados(de, ate, almoco) {
  var total = Math.max(0, ate - de);
  if (almoco) total -= Math.max(0, Math.min(ate, almoco[1]) - Math.max(de, almoco[0]));
  return Math.max(0, total);
}

// Minuto do dia (0 = 00:00; T02 passa de 1440 depois da meia-noite) em que o time passou da meta.
// Usa as peças por minuto (Data/Hora Fim) da Separação e da Conferência Analítica e, para a
// Conferência Colmeia (que não tem hora), as marcas que o robô grava a cada exportação (~5 min).
// Devolve null quando o dia não tem minutos gravados.
function minutoDaMeta(snap, dia, turno, t) {
  var s = snap || {}, sep = (s.separacao || {}).analitico || [], conf = (s.conferencia || {}).analitico || [];
  var proximo = isoLocal(new Date(new Date(dia + 'T12:00:00').getTime() + 864e5));
  var eventos = [], temMin = false;
  function dosMinutos(lista, campo, d, desloc, chaveFonte) {
    var reg = lista.filter(function (x) { return String(x.data).slice(0, 10) === d; })[0];
    var porUsu = reg && reg[campo];
    if (!porUsu) return;
    temMin = true;
    t.lista.forEach(function (m) {
      var k = m.chaves && m.chaves[chaveFonte];
      if (!k) return;
      Object.keys(porUsu).forEach(function (u) {
        if (chaveUsu(u) !== k) return;
        (porUsu[u] || []).forEach(function (par) { if (desloc === 0 || par[0] < 120) eventos.push([par[0] + desloc, par[1]]); });
      });
    });
  }
  [[dia, 0]].concat(turno === '2º Turno' ? [[proximo, 1440]] : []).forEach(function (dd) {
    dosMinutos(sep, 'checkoutMin', dd[0], dd[1], 'sep_checkout');
    dosMinutos(sep, 'colmeiaMin', dd[0], dd[1], 'sep_colmeia');
    dosMinutos(conf, 'checkoutMin', dd[0], dd[1], 'conf_checkout');
  });
  if (!temMin) return null;
  // Conferência Colmeia: degraus pelas marcas (acumulado do dia por operador em cada exportação)
  var marcas = [];
  var regM = ((s.conferencia || {}).colmeiaMarcas || []).filter(function (x) { return x.data === dia; })[0];
  if (regM) (regM.marcas || []).forEach(function (mk) {
    var tot = 0;
    t.lista.forEach(function (m) {
      var k = m.chaves && m.chaves.conf_colmeia;
      if (!k) return;
      Object.keys(mk[1] || {}).forEach(function (u) { if (chaveUsu(u) === k) tot += mk[1][u] || 0; });
    });
    marcas.push([mk[0], tot]);
  });
  marcas.sort(function (a, b) { return a[0] - b[0]; });
  eventos.sort(function (a, b) { return a[0] - b[0]; });
  var minutos = eventos.map(function (e) { return e[0]; }).concat(marcas.map(function (mk) { return mk[0]; }));
  minutos = minutos.filter(function (x, i) { return minutos.indexOf(x) === i; }).sort(function (a, b) { return a - b; });
  var cum = 0, ie = 0, confCol = 0, im = 0;
  for (var i = 0; i < minutos.length; i++) {
    var mm = minutos[i];
    while (ie < eventos.length && eventos[ie][0] <= mm) cum += eventos[ie++][1];
    while (im < marcas.length && marcas[im][0] <= mm) confCol = marcas[im++][1];
    if (cum + confCol >= t.meta) return mm;
  }
  return null;
}

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

    // meta batida + antecipada: +antecipadaHora por hora antes do fim do turno, contando os minutos.
    // Minuto da meta = minuto exato (Data/Hora Fim das tarefas + marcas da colmeia); sem minutos, cai no fim da hora.
    r.metaBatida = t.total >= t.meta && t.meta ? pts(P.metaBatida, n) : 0;
    r.antecipada = 0; r.horaMeta = null; r.minutoMeta = null;
    if (r.metaBatida) {
      r.minutoMeta = minutoDaMeta(o.snap, dia, turno, t);
      if (r.minutoMeta == null) {
        var cum = 0;
        for (var h = 0; h < 24; h++) { cum += horas[h] * esc; if (cum >= t.meta) { r.horaMeta = h + 1; break; } }
        if (r.horaMeta != null) r.minutoMeta = r.horaMeta * 60;
      }
      if (r.minutoMeta != null) r.antecipada = Math.round(pts(P.antecipadaHora, n) * minutosTrabalhados(r.minutoMeta, T.fim, T.almoco) / 60);
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
  DESAFIOS: DESAFIOS, GINCANAS: GINCANAS, GINCANAS_DESC: GINCANAS_DESC, PONTOS_DESAFIO: PONTOS_DESAFIO, fator: fator, pts: pts, turnoAtual: turnoAtual,
  placarDoDia: placarDoDia, minutosTrabalhados: minutosTrabalhados, acumulado: acumulado, isoLocal: isoLocal,
  META_DIA_TIME: META_DIA_TIME, calcularCompeticao: calcularCompeticao, ultimoDia: ultimoDia, chaveUsu: chaveUsu
};
})(typeof window !== 'undefined' ? window : globalThis);
