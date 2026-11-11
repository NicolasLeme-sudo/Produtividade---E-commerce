/* =========================================================================
   INGEST.JS — Produtividade E-commerce · Vulcabras
   -------------------------------------------------------------------------
   O QUE ESTE ARQUIVO FAZ (e só ele faz isso — index.html nunca recalcula
   regra de negócio, só formata o que já vem pronto do Supabase):
     1) Constrói a tela de "Abastecimento de base" (só Admin acessa).
     2) Lê os arquivos que o Admin sobe (TSV/XLSX/XLSB via SheetJS/XLSX.js).
     3) Aplica as 14 regras de negócio validadas com a operação.
     4) Grava o resultado já calculado em dashboard_snapshots (uma linha por
        página: outbound / inbound / estoque / reversa) e em base_ativos.

   Este script SEMPRE fica carregado (o <script src="ingest.js"> do
   index.html não tem condição), mas só EXECUTA algo quando o Admin abre a
   tela de Abastecimento — em qualquer outra tela ele só fica parado.
   ========================================================================= */

// -------------------------------------------------------------------------
// 0) CONEXÃO COM O SUPABASE
// -------------------------------------------------------------------------
const SUPABASE_URL = "https://vehfchdfbukrbcedciiy.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZlaGZjaGRmYnVrcmJjZWRjaWl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAwMDI5NjksImV4cCI6MjEwNTU3ODk2OX0.zuHswp3JIts2jeA_AOj7DIXo7no7Ql33BPNVX4oePL8";
// persistSession: false — mesmo padrão do Report E-commerce. Sem sessão
// persistida, todo F5 volta pra tela de login (mesmo com usuário/senha
// salvos no navegador), o que é o comportamento que a operação já usa.
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

(function () {
"use strict";

// =========================================================================
// 1) HELPERS GENÉRICOS DE TEXTO / DATA
// =========================================================================

// Maiúsculo + sem acento — base de toda comparação de texto neste arquivo.
function normalizarTexto(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().trim();
}

// Lê um campo de uma linha tentando várias grafias possíveis de coluna
// (o WMS às vezes exporta com pequenas variações de nome/acentuação).
function obterCampo(row, candidatos) {
  if (!row) return undefined;
  var chaves = Object.keys(row);
  for (var i = 0; i < candidatos.length; i++) {
    var alvo = normalizarTexto(candidatos[i]);
    for (var j = 0; j < chaves.length; j++) {
      if (normalizarTexto(chaves[j]) === alvo) return row[chaves[j]];
    }
  }
  return undefined;
}

function numero(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return v;
  var n = Number(String(v).replace(/\./g, "").replace(",", "."));
  if (!isNaN(n)) return n;
  n = Number(v);
  return isNaN(n) ? 0 : n;
}

function excelSerialParaData(serial) {
  var epoch = new Date(Date.UTC(1899, 11, 30));
  return new Date(epoch.getTime() + serial * 86400000);
}

function paraDataISOLocal(date) {
  var ano = date.getFullYear(), mes = String(date.getMonth() + 1).padStart(2, "0"), dia = String(date.getDate()).padStart(2, "0");
  return ano + "-" + mes + "-" + dia;
}

// Converte "dd/mm/yyyy HH:mm:ss", serial do Excel ou Date já parseada em "yyyy-mm-dd".
// Retorna null se vazio — nunca inventa uma data.
function paraDataISO(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  if (valor instanceof Date) return isNaN(valor.getTime()) ? null : paraDataISOLocal(valor);
  if (typeof valor === "number") return paraDataISOLocal(excelSerialParaData(valor));
  var str = String(valor).trim();
  if (!str) return null;
  var dataParte = str.split(" ")[0];
  var partes = dataParte.split("/");
  if (partes.length === 3) {
    var dd = Number(partes[0]), mm = Number(partes[1]), yyyy = Number(partes[2]);
    if (dd && mm && yyyy) return paraDataISOLocal(new Date(yyyy, mm - 1, dd));
  }
  // formato yyyy-mm-dd já pronto
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  return null;
}

// -------------------------------------------------------------------------
// Parsers de arquivo (padrão idêntico ao ingest.js do Report E-commerce)
// -------------------------------------------------------------------------
function parseTSVSelecionado(texto, colunasDesejadas) {
  var linhas = texto.split("\n");
  var header = linhas[0].replace(/\r$/, "").split("\t");
  var idx = {};
  colunasDesejadas.forEach(function (c) { idx[c] = header.indexOf(c); });
  var registros = [];
  for (var i = 1; i < linhas.length; i++) {
    if (!linhas[i]) continue;
    var campos = linhas[i].replace(/\r$/, "").split("\t");
    var registro = {};
    for (var k = 0; k < colunasDesejadas.length; k++) {
      var c = colunasDesejadas[k];
      registro[c] = idx[c] >= 0 ? campos[idx[c]] : "";
    }
    registros.push(registro);
  }
  return registros;
}

// Lê a 1ª aba de um XLSX/XLSB via SheetJS (window.XLSX precisa estar carregado).
async function parseXLSXPrimeiraAba(file) {
  var buffer = await file.arrayBuffer();
  var wb = XLSX.read(buffer, { type: "array", cellDates: true });
  var ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: "" });
}

// Lê uma aba específica pelo nome (usado na "Base Geral Corte/Pula", que tem
// as abas "Pulas - Colmeia" e "Corte Físico - Checkout Express" no mesmo arquivo).
async function parseXLSXAba(file, nomeAba) {
  var buffer = await file.arrayBuffer();
  var wb = XLSX.read(buffer, { type: "array", cellDates: true });
  var nomeReal = wb.SheetNames.find(function (n) { return normalizarTexto(n) === normalizarTexto(nomeAba); }) || wb.SheetNames[0];
  var ws = wb.Sheets[nomeReal];
  return XLSX.utils.sheet_to_json(ws, { defval: "" });
}

// Detecta pela extensão se deve usar parser TSV (texto) ou XLSX (binário).
async function parseArquivoGenerico(file) {
  var nome = file.name.toLowerCase();
  if (nome.endsWith(".tsv") || nome.endsWith(".txt")) {
    var texto = await file.text();
    var linhas = texto.split("\n");
    var header = linhas[0].replace(/\r$/, "").split("\t");
    return parseTSVSelecionado(texto, header);
  }
  return parseXLSXPrimeiraAba(file); // .xlsx / .xlsb / .xls
}

// =========================================================================
// 2) BASE DE ATIVOS — casamento Usuário do WMS → colaborador
// =========================================================================

// Palavras de conectivo que nunca entram como token de "sobrenome" no
// usuário do WMS (ex.: "GABRIEL DE SOUZA" -> candidatos usam SOUZA, não DE).
var CONECTIVOS_NOME = ["DE", "DA", "DO", "DAS", "DOS", "E"];

// Gera os candidatos de username no padrão PRIMEIRO.TOKEN a partir do nome
// completo do colaborador — o mesmo padrão que o WMS usa (ex.: "JACKSON
// SANTOS SILVA" -> ["JACKSON.SANTOS", "JACKSON.SILVA"]).
function candidatosDoNome(nomeCompleto) {
  var tokens = normalizarTexto(nomeCompleto).split(/\s+/).filter(function (t) {
    return t && CONECTIVOS_NOME.indexOf(t) === -1;
  });
  if (!tokens.length) return [];
  var primeiro = tokens[0];
  var candidatos = [];
  for (var i = 1; i < tokens.length; i++) candidatos.push(primeiro + "." + tokens[i]);
  if (!candidatos.length) candidatos.push(primeiro);
  return candidatos;
}

// O WMS grava o usuário ora com "." ora com "," como separador (ex.:
// "JACKSON,SANTOS"). Normaliza os dois formatos para o mesmo padrão antes
// de comparar.
function normalizarUsuarioWMS(raw) {
  return normalizarTexto(String(raw || "").replace(/,/g, "."));
}

// Normaliza o setor da Base de Ativos: a base tem "Gestão de Estoque" e
// "Gestão de estoque" como valores distintos (case diferente) — aqui viram
// o mesmo valor canônico.
function normalizarSetor(raw) {
  var norm = normalizarTexto(raw);
  if (norm === "GESTAO DE ESTOQUE") return "Gestão de Estoque";
  if (!norm) return "";
  // Mantém a grafia original (com acento) para exibição, só re-capitaliza
  // a partir do valor normalizado quando reconhecido; senão devolve como veio.
  return String(raw).trim();
}

// Carrega base_ativos do Supabase e monta o índice de casamento:
// candidato normalizado (ex.: "JACKSON.SANTOS") -> registro do colaborador.
// Um mesmo colaborador entra com TODOS os candidatos gerados do nome dele,
// não só o principal — assim casa mesmo se o WMS usou o 2º ou 3º token.
async function carregarIndiceBaseAtivos() {
  var { data, error } = await supabaseClient.from("base_ativos").select("*");
  if (error) { console.error("Erro ao carregar base_ativos", error); return { indice: new Map(), indicePorPrimeiroNome: new Map(), lista: [] }; }
  var lista = data || [];
  var indice = new Map();
  // Índice auxiliar só pelo primeiro nome (ex.: "DARA" -> [registro,...]) —
  // usado quando o texto de origem só traz um nome sem sobrenome (ex.: campo
  // Veiculo da Vinculação Reversa). Se mais de um colaborador compartilha o
  // primeiro nome, fica ambíguo de propósito (nunca adivinha errado).
  var indicePorPrimeiroNome = new Map();
  lista.forEach(function (registro) {
    candidatosDoNome(registro.nome).forEach(function (cand) { indice.set(cand, registro); });
    // também indexa o próprio usuario_wms gravado, caso tenha sido ajustado manualmente
    if (registro.usuario_wms) indice.set(normalizarUsuarioWMS(registro.usuario_wms), registro);
    var tokens = normalizarTexto(registro.nome).split(/\s+/).filter(function (t) { return t && CONECTIVOS_NOME.indexOf(t) === -1; });
    if (tokens[0]) {
      var lista2 = indicePorPrimeiroNome.get(tokens[0]) || [];
      lista2.push(registro);
      indicePorPrimeiroNome.set(tokens[0], lista2);
    }
  });
  return { indice: indice, indicePorPrimeiroNome: indicePorPrimeiroNome, lista: lista };
}

// Resolve um "Usuário" cru do WMS para o colaborador da Base de Ativos.
// Nunca lança erro: quando não encontra, devolve um registro "não cadastrado"
// com o texto original preservado, para nunca sumir com a linha.
function resolverColaborador(usuarioRaw, indiceBaseAtivos) {
  var chave = normalizarUsuarioWMS(usuarioRaw);
  var achado = indiceBaseAtivos.get(chave);
  if (achado) return achado;
  return { usuario_wms: usuarioRaw, nome: usuarioRaw || "(sem usuário)", setor: "", turno: "", gestor: "", naoCadastrado: true };
}

// =========================================================================
// 3) GRAVAÇÃO NO SUPABASE — única fronteira de escrita deste arquivo
// =========================================================================
// =========================================================================
// SEPARAÇÃO / CONFERÊNCIA ANALÍTICAS -> produção por usuário e HORA
// Uma linha por tarefa, com Data/Hora Início. A hora (0 a 23) e o dia vêm do
// início da tarefa (tarefa que cruza a meia-noite fica no dia/hora em que começou).
// Formato salvo: [{ data, checkout: { USUARIO: [24 valores] }, colmeia: {...} }]
// =========================================================================
function horaDoTexto(v) {
  var m = /\s(\d{1,2}):/.exec(String(v == null ? "" : v));
  var h = m ? Number(m[1]) : NaN;
  return h >= 0 && h <= 23 ? h : null;
}
function acumularHora(dias, data, tipo, usuario, hora, valor) {
  var dia = dias.get(data) || { data: data, checkout: new Map(), colmeia: new Map() };
  dias.set(data, dia);
  var arr = dia[tipo].get(usuario) || new Array(24).fill(0);
  arr[hora] += valor;
  dia[tipo].set(usuario, arr);
}
// minutos (opcional): Map(data -> { checkout: Map(usuario -> Map(minuto -> peças)), colmeia }) -> checkoutMin/colmeiaMin = { USUARIO: [[minuto, peças], ...] }
function diasHoraParaArray(dias, minutos) {
  return Array.from(dias.values()).map(function (d) {
    var o = { data: d.data, checkout: {}, colmeia: {} };
    ["checkout", "colmeia"].forEach(function (t) { d[t].forEach(function (arr, u) { o[t][u] = arr; }); });
    var dm = minutos && minutos.get(d.data);
    if (dm) ["checkout", "colmeia"].forEach(function (t) {
      var porU = {};
      dm[t].forEach(function (mp, u) { porU[u] = Array.from(mp.entries()).sort(function (a, b) { return a[0] - b[0]; }); });
      o[t + "Min"] = porU;
    });
    return o;
  }).sort(function (a, b) { return a.data.localeCompare(b.data); });
}
// Cada relatório analítico gera, no mesmo passe: a produção por HORA (pelo
// horário de início da tarefa) e as mesmas visões por DIA que o relatório
// sintético antigo gerava, já separando Checkout de Colmeia. O dia dos totais é
// o da coluna "Data" do WMS (igual ao sintético); a hora vem do início da tarefa.
// Tempo trabalhado = último "fim" − primeiro "início" de cada pessoa no dia
// (conferido: bate exatamente com o "Tempo em Segundos" do sintético).
function segundosDoTexto(v) {
  var m = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(v == null ? "" : v));
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)) / 1000 : null;
}
function novoAcumuladorAnalitico() {
  return { horas: new Map(), minutos: new Map(), pecas: { checkout: new Map(), colmeia: new Map() }, spans: new Map(), totais: { checkout: new Map(), colmeia: new Map() } };
}
function registrarSpan(ac, chave, ini, fim) {
  var sp = ac.spans.get(chave);
  if (!sp) ac.spans.set(chave, [ini, fim]);
  else { if (ini < sp[0]) sp[0] = ini; if (fim > sp[1]) sp[1] = fim; }
}
function acumularAnalitico(ac, row, tipo, usuario) {
  var ini = obterCampo(row, ["Data/Hora Início", "Data/Hora Inicio"]);
  var fimTxt = obterCampo(row, ["Data/Hora Fim"]);
  var dataInicio = paraDataISO(ini), hora = horaDoTexto(ini);
  var dataDia = paraDataISO(obterCampo(row, ["Data"])) || dataInicio;
  if (!dataInicio || hora === null || !dataDia) return;
  var pecas = numero(obterCampo(row, ["Peças", "Pecas"]));
  acumularHora(ac.horas, dataInicio, tipo, usuario, hora, pecas);
  somarNoDia(ac.pecas[tipo], dataDia, usuario, pecas);
  ac.totais[tipo].set(usuario, (ac.totais[tipo].get(usuario) || 0) + pecas);
  var i0 = segundosDoTexto(ini), i1 = segundosDoTexto(fimTxt);
  // Minuto do dia em que a tarefa terminou (Data/Hora Fim), contado a partir do dia de início
  // (passa de 1440 se terminou depois da meia-noite). Usado na meta antecipada da Missão Black.
  var fimSeg = i1 !== null ? i1 : i0;
  if (fimSeg !== null) {
    var p0 = dataInicio.split("-"), minuto = Math.floor((fimSeg - Date.UTC(+p0[0], +p0[1] - 1, +p0[2]) / 1000) / 60);
    if (minuto >= 0 && minuto < 2880) {
      var dm = ac.minutos.get(dataInicio) || { checkout: new Map(), colmeia: new Map() };
      ac.minutos.set(dataInicio, dm);
      var mu = dm[tipo].get(usuario) || new Map();
      mu.set(minuto, (mu.get(minuto) || 0) + pecas);
      dm[tipo].set(usuario, mu);
    }
  }
  if (i0 !== null && i1 !== null) {
    registrarSpan(ac, dataDia + "|" + tipo + "|" + usuario, i0, i1);
    registrarSpan(ac, dataDia + "|geral|" + usuario, i0, i1);
  }
}
// spans -> { checkout, colmeia, geral }: Map(dia -> Map(usuario -> segundos))
function segundosPorTipoDia(ac) {
  var out = { checkout: new Map(), colmeia: new Map(), geral: new Map() };
  ac.spans.forEach(function (sp, chave) {
    var p = chave.split("|");
    somarNoDia(out[p[1]], p[0], p.slice(2).join("|"), Math.max(0, sp[1] - sp[0]));
  });
  return out;
}
function processarSeparacaoAnalitica(rows) {
  var ac = novoAcumuladorAnalitico();
  rows.forEach(function (row) {
    // Confirmado no export real (Separação Analítico): Região Destino = CHECKOUT ou COLMEIA - <cor>.
    var destino = normalizarTexto(obterCampo(row, ["Região Destino", "Regiao Destino"]));
    var tipo = destino.indexOf("COLMEIA") !== -1 ? "colmeia" : (destino.indexOf("CHECKOUT") !== -1 ? "checkout" : null);
    var usuario = String(obterCampo(row, ["Usuário", "Usuario"]) || "").trim();
    if (!tipo || !usuario) return;
    acumularAnalitico(ac, row, tipo, usuario);
  });
  ac.seg = segundosPorTipoDia(ac);
  return ac;
}
function processarConferenciaAnalitica(rows) {
  var ac = novoAcumuladorAnalitico();
  rows.forEach(function (row) {
    var usuario = String(obterCampo(row, ["Conferênte", "Conferente"]) || "").trim();
    if (!usuario) return;
    acumularAnalitico(ac, row, "checkout", usuario);
  });
  ac.seg = segundosPorTipoDia(ac);
  return ac;
}

// Turno de cada pessoa vem da Base de Ativos. É gravado junto do snapshot de
// Outbound porque o perfil Gestão não tem acesso à tabela base_ativos.
var TURNOS_VALIDOS = ["1º Turno", "2º Turno", "3º Turno", "ADM"];
var baseTurnos = null; // { indice, lista } — preenchido em processar()
function nomesDoOutbound(d) {
  var nomes = {};
  function dias(arr) { (arr || []).forEach(function (x) { Object.keys(x.itens || {}).forEach(function (n) { nomes[n] = 1; }); }); }
  function analitico(arr) { (arr || []).forEach(function (x) { ["checkout", "colmeia"].forEach(function (t) { Object.keys(x[t] || {}).forEach(function (n) { nomes[n] = 1; }); }); }); }
  var sep = d.separacao || {}, conf = d.conferencia || {};
  dias(sep.checkoutDia); dias(sep.colmeiaDia); analitico(sep.analitico);
  dias(conf.confCheckoutDia); dias(conf.confColmeiaUnitDia); analitico(conf.analitico);
  return Object.keys(nomes);
}
function anexarTurnos(d) {
  if (!baseTurnos) return;
  var porNomeCompleto = new Map();
  baseTurnos.lista.forEach(function (r) { porNomeCompleto.set(normalizarUsuarioWMS(r.nome), r); });
  var mapa = Object.assign({}, d.turnoPorUsuario || {});
  nomesDoOutbound(d).forEach(function (nome) {
    var chave = normalizarUsuarioWMS(nome);
    var reg = baseTurnos.indice.get(chave) || porNomeCompleto.get(chave);
    var turno = reg ? String(reg.turno || "").trim() : "";
    if (TURNOS_VALIDOS.indexOf(turno) !== -1) mapa[chave] = turno;
  });
  d.turnoPorUsuario = mapa;
}

async function salvarSnapshot(pagina, dadosNovos) {
  if (pagina === "outbound") anexarTurnos(dadosNovos);
  var { data: sessao } = await supabaseClient.auth.getSession();
  // atualizado_por é uuid (references auth.users.id) — precisa do id da sessão, não do e-mail.
  var userId = sessao && sessao.session ? sessao.session.user.id : null;
  var { error } = await supabaseClient.from("dashboard_snapshots").upsert({
    pagina: pagina,
    dados: dadosNovos,
    atualizado_em: new Date().toISOString(),
    atualizado_por: userId,
  }, { onConflict: "pagina" });
  if (error) throw new Error("Falha ao gravar snapshot de " + pagina + ": " + error.message);
}

async function lerSnapshot(pagina) {
  var { data, error } = await supabaseClient.from("dashboard_snapshots").select("dados").eq("pagina", pagina).maybeSingle();
  if (error) { console.error(error); return {}; }
  return (data && data.dados) || {};
}

async function mergeSnapshot(pagina, chave, valor) {
  var atual = await lerSnapshot(pagina);
  atual[chave] = valor;
  await salvarSnapshot(pagina, atual);
}

// =========================================================================
// 4) REGRAS DE NEGÓCIO — uma função por indicador da lista validada
// =========================================================================

// ---- 1/3/6) Kardex de Movimentações -> Separação Colmeia + Pula + Pendente ----
// Regra: Tipo do Local = COLMÉIA + Complementar contém "ADICIONADO ESTOQUE"
// (excluindo linhas de PESAGEM) -> Estoque Após − Estoque Antes, por Usuário.
// Pula = mesma regra, só para usuários cujo Setor na Base de Ativos é
// "Gestão de Estoque". Pendente de fechamento = Σ ADICIONADO − Σ (PESAGEM/
// RETIRADO ESTOQUE).
function processarKardexMovimentacoes(rows, indiceBaseAtivos) {
  var porUsuarioColmeia = new Map(); // separação colmeia (setor != Gestão de Estoque)
  var porUsuarioPula = new Map();    // pula (setor == Gestão de Estoque)
  var porDiaColmeia = new Map();     // data -> total colmeia (checkout entra depois)
  var colmeiaDia = new Map(), pulaDia = new Map();
  var somaAdicionado = 0, somaPesagemRetirado = 0;
  var separadoresDistintos = new Set();

  rows.forEach(function (row) {
    var tipoLocal = normalizarTexto(obterCampo(row, ["Tipo do Local"]));
    var complementar = normalizarTexto(obterCampo(row, ["Complementar"]));
    var usuarioRaw = obterCampo(row, ["Usuário", "Usuario"]);
    var estoqueAntes = numero(obterCampo(row, ["Estoque Antes"]));
    var estoqueApos = numero(obterCampo(row, ["Estoque Após", "Estoque Apos"]));
    // Confirmado no export real (Kardex 21.09): a coluna é só "Data".
    var dataISO = paraDataISO(obterCampo(row, ["Data"]));

    var ehColmeia = tipoLocal.indexOf("COLMEIA") !== -1; // COLMÉIA sem acento após normalizarTexto
    var ehPesagem = complementar.indexOf("PESAGEM") !== -1;
    var ehAdicionado = complementar.indexOf("ADICIONADO ESTOQUE") !== -1 && !ehPesagem;
    var ehRetiradoPesagem = ehPesagem && complementar.indexOf("RETIRADO ESTOQUE") !== -1;

    if (!ehColmeia) return;

    if (ehAdicionado) {
      var delta = estoqueApos - estoqueAntes;
      somaAdicionado += delta;
      var colaborador = resolverColaborador(usuarioRaw, indiceBaseAtivos);
      var ehGestaoEstoque = normalizarTexto(normalizarSetor(colaborador.setor)) === "GESTAO DE ESTOQUE";
      var mapa = ehGestaoEstoque ? porUsuarioPula : porUsuarioColmeia;
      mapa.set(colaborador.nome, (mapa.get(colaborador.nome) || 0) + delta);
      somarNoDia(ehGestaoEstoque ? pulaDia : colmeiaDia, dataISO, colaborador.nome, delta);
      if (!ehGestaoEstoque) separadoresDistintos.add(colaborador.nome);
      if (dataISO) porDiaColmeia.set(dataISO, (porDiaColmeia.get(dataISO) || 0) + delta);
    } else if (ehRetiradoPesagem) {
      somaPesagemRetirado += (estoqueAntes - estoqueApos);
    }
  });

  return {
    separacaoColmeiaPorUsuario: porUsuarioColmeia,
    pulaPorUsuario: porUsuarioPula,
    pendenteFechamento: somaAdicionado - somaPesagemRetirado,
    somaAdicionadoColmeia: somaAdicionado,
    somaPesagemRetirado: somaPesagemRetirado,
    porDiaColmeia: porDiaColmeia,
    colmeiaDia: colmeiaDia, pulaDia: pulaDia,
    separadoresColmeiaDistintos: separadoresDistintos.size,
  };
}

// ---- 7) Kardex de Endereço -> Armazenagem ----
// Estoque Antes − Estoque Após, onde Local começa com H/I/J (normal) ou S
// (reversa) — mesma regra do report-ecommerce, agora quebrada por Usuário.
// Hora (0-23) da coluna Data do Kardex: "dd/mm/yyyy HH:mm:ss", serial do Excel ou Date.
// Retorna null quando o valor não traz hora — nunca inventa uma hora.
function horaDoValor(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  if (valor instanceof Date) return isNaN(valor.getTime()) ? null : valor.getHours();
  if (typeof valor === "number") { var fr = valor - Math.floor(valor); return fr > 0 ? Math.min(23, Math.floor(fr * 24 + 1e-6)) : null; }
  var m = String(valor).match(/\s(\d{1,2}):\d{2}/);
  return m ? Math.min(23, Number(m[1])) : null;
}

function processarKardexEndereco(rows, indiceBaseAtivos, embalas) {
  var segDia = {};              // data -> { C: peças de calçados, V: peças de vestuário } (armazenagem normal)
  var porUsuarioNormal = new Map();
  var porUsuarioReversa = new Map();
  var totalNormal = 0, totalReversa = 0;
  var normalDia = new Map(), reversaDia = new Map();
  var normalHora = new Map();   // data -> [24] peças armazenadas por hora (só armazenagem normal)
  var normalMin = new Map();    // data -> { minuto do dia: peças } (previsão "nesta hora"; não é gravado)

  rows.forEach(function (row) {
    var dataBruta = obterCampo(row, ["Data"]);
    var dataISO = paraDataISO(dataBruta);
    var local = String(obterCampo(row, ["Local"]) || "").trim();
    if (!local) return;
    // Armazenagem = saída do pulmão/stage de origem: Complementar "ESTOQUE
    // SUBTRAÍDO…" + Tipo do Local PULMÃO. Fica de fora a "ALOCAÇÃO DO LOTE"
    // (entrada no destino, sinal invertido) e o "ADICIONAR SUBTRAÍDO" do picking.
    var complementar = normalizarTexto(obterCampo(row, ["Complementar"]));
    var tipoLocal = normalizarTexto(obterCampo(row, ["Tipo do Local"]));
    if (complementar.indexOf("ESTOQUE SUBTRAIDO") !== 0 || tipoLocal.indexOf("PULMAO") === -1) return;
    var prefixo = local.charAt(0).toUpperCase();
    var usuarioRaw = obterCampo(row, ["Usuário", "Usuario"]);
    var estoqueAntes = numero(obterCampo(row, ["Estoque Antes"]));
    var estoqueApos = numero(obterCampo(row, ["Estoque Após", "Estoque Apos"]));
    var delta = estoqueAntes - estoqueApos;
    if (delta === 0) return;

    var colaborador = resolverColaborador(usuarioRaw, indiceBaseAtivos);
    if ("HIJ".indexOf(prefixo) !== -1) {
      porUsuarioNormal.set(colaborador.nome, (porUsuarioNormal.get(colaborador.nome) || 0) + delta);
      totalNormal += delta;
      somarNoDia(normalDia, dataISO, colaborador.nome, delta);
      if (dataISO) {
        var sgd = segDia[dataISO] || (segDia[dataISO] = { C: 0, V: 0 });
        sgd[segmentoDoProduto(obterCampo(row, ["Código do Produto", "Codigo do Produto"]), obterCampo(row, ["Produto"]), embalas)] += delta;
      }
      var hora = horaDoValor(dataBruta);
      if (dataISO && hora !== null) {
        var horas = normalHora.get(dataISO) || new Array(24).fill(0);
        horas[hora] += delta;
        normalHora.set(dataISO, horas);
        var minuto = minutoDoValor(dataBruta);
        if (minuto !== null) { var mm = normalMin.get(dataISO) || {}; mm[minuto] = (mm[minuto] || 0) + delta; normalMin.set(dataISO, mm); }
      }
    } else if (prefixo === "S") {
      porUsuarioReversa.set(colaborador.nome, (porUsuarioReversa.get(colaborador.nome) || 0) + delta);
      totalReversa += delta;
      somarNoDia(reversaDia, dataISO, colaborador.nome, delta);
    }
  });

  return { porUsuarioNormal: porUsuarioNormal, porUsuarioReversa: porUsuarioReversa, totalNormal: totalNormal, totalReversa: totalReversa, normalDia: normalDia, reversaDia: reversaDia, normalHora: normalHora, normalMin: normalMin, segDia: segDia };
}
// Minuto do dia (0-1439) da coluna Data: "dd/mm/yyyy HH:mm:ss", serial do Excel ou Date. Sem hora = null.
function minutoDoValor(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  if (valor instanceof Date) return isNaN(valor.getTime()) ? null : valor.getHours() * 60 + valor.getMinutes();
  if (typeof valor === "number") { var fr = valor - Math.floor(valor); return fr > 0 ? Math.min(1439, Math.floor(fr * 1440 + 1e-6)) : null; }
  var m = String(valor).match(/\s(\d{1,2}):(\d{2})/);
  return m ? Math.min(1439, Number(m[1]) * 60 + Number(m[2])) : null;
}
// { data: {minuto: peças} } do calendário -> minutos do dia operacional (00h–01h do dia seguinte entra como 1440+).
function minutosOperacionais(porData, dia) {
  var out = Object.assign({}, porData.get(dia) || {}), seg = porData.get(diaSeguinteISO(dia)) || {};
  Object.keys(seg).forEach(function (k) { if (+k < 60) out[+k + 1440] = (out[+k + 1440] || 0) + seg[k]; });
  return out;
}

// ---- Expedição (embarque) pelo Kardex ----
// Bipagem na doca: Tipo do Local DOCA + Complementar "NOTA FISCAL PROCESSADA, RETIRADO ESTOQUE PARA
// NOTAFISCAL ID:<id>". O id é o idNotaFiscal do Itens de NF (1 nota = 1 pedido). Vale o ÚLTIMO evento
// de cada nota: processada = embarcada (usuário e horário desse evento; peças = Estoque Antes − Após das
// linhas desse momento); estorno ("PROCESSAMENTO DE NOTA FISCAL ESTORNADO") ou cancelamento depois = não conta.
// Dia operacional: 00h–01h ainda é o dia anterior (minuto 1440+).
// Retorna { dias: { dia: { idNF: [usuario, minuto, peças] } }, estornadas: [idNF] }
function processarExpedicaoKardex(rows) {
  var ev = {};
  rows.forEach(function (row) {
    if (normalizarTexto(obterCampo(row, ["Tipo do Local"])) !== "DOCA") return;
    var comp = normalizarTexto(obterCampo(row, ["Complementar"]));
    var m = /NOTAFISCAL ID:\s*(\d+)/.exec(comp);
    if (!m) return;
    var tipo = comp.indexOf("NOTA FISCAL PROCESSADA, RETIRADO ESTOQUE") === 0 ? "P"
      : (comp.indexOf("ESTORNADO, ADICIONADO ESTOQUE") !== -1 || comp.indexOf("CANCELADA, REMOVIDO ESTOQUE") !== -1) ? "E" : null;
    if (!tipo) return;
    var ms = dataHoraParaMs(obterCampo(row, ["Data"]));
    if (ms === null) return;
    var pecas = tipo === "P" ? numero(obterCampo(row, ["Estoque Antes"])) - numero(obterCampo(row, ["Estoque Após", "Estoque Apos"])) : 0;
    (ev[m[1]] || (ev[m[1]] = [])).push([ms, tipo, String(obterCampo(row, ["Usuário", "Usuario"]) || "").trim().toUpperCase(), pecas]);
  });
  var out = { dias: {}, estornadas: [] };
  Object.keys(ev).forEach(function (id) {
    var l = ev[id].sort(function (a, b) { return a[0] - b[0] || (a[1] === "E" ? 1 : -1); }), ult = l[l.length - 1];
    if (ult[1] !== "P") { out.estornadas.push(id); return; }
    var pecas = l.reduce(function (s, x) { return s + (x[1] === "P" && x[0] === ult[0] ? x[3] : 0); }, 0);
    var d = new Date(ult[0]), min = d.getHours() * 60 + d.getMinutes();
    if (d.getHours() < 1) { d.setDate(d.getDate() - 1); min += 1440; }
    var dia = paraDataISOLocal(d);
    (out.dias[dia] || (out.dias[dia] = {}))[id] = [ult[2] || "(sem usuário)", min, pecas];
  });
  return out;
}
// Itens de NF -> { idNF: [transportadora, "S" | "M" | "", status] } (SINGLE = checkout, MULTI = colmeia)
function processarInfoNf(rows) {
  var info = {};
  rows.forEach(function (row) {
    var id = String(obterCampo(row, ["idNotaFiscal"]) || "").trim();
    if (!id || info[id]) return;
    var cl = normalizarTexto(obterCampo(row, ["Classificação Tipo Pedido", "Classificacao Tipo Pedido"]));
    info[id] = [String(obterCampo(row, ["Transportadora"]) || "").trim(), cl.indexOf("MULTI") !== -1 ? "M" : cl.indexOf("SINGLE") !== -1 ? "S" : "", normalizarTexto(obterCampo(row, ["Status"])),
      paraDataISO(obterCampo(row, ["Data de Cadastro"])) || ""];
  });
  return info;
}

// ---- 5) Conferência Colmeia ----
// Conferência Colmeia não tem hora: cada envio (o robô exporta a cada 5 min) vira uma marca
// [minuto do envio, { OPERADOR: acumulado do dia }]. Só para hoje (e ontem até 02h, por causa do T02).
// Formato: [{ data, marcas: [[minuto, {...}], ...] }], guarda os 7 dias mais recentes.
function marcarColmeia(anterior, unitDia) {
  var agora = new Date(), minAgora = agora.getHours() * 60 + agora.getMinutes();
  var hojeISO = paraDataISOLocal(agora), ontem = new Date(agora); ontem.setDate(ontem.getDate() - 1);
  var ontemISO = paraDataISOLocal(ontem);
  var lista = (anterior || []).slice();
  unitDia.forEach(function (porOp, dia) {
    var minuto = dia === hojeISO ? minAgora : (dia === ontemISO && agora.getHours() < 2 ? 1440 + minAgora : null);
    if (minuto === null) return;
    var itens = {}; porOp.forEach(function (v, op) { itens[op] = v; });
    var reg = lista.filter(function (x) { return x.data === dia; })[0];
    if (!reg) { reg = { data: dia, marcas: [] }; lista.push(reg); }
    reg.marcas = reg.marcas.filter(function (mk) { return mk[0] !== minuto; }).concat([[minuto, itens]]).sort(function (a, b) { return a[0] - b[0]; });
  });
  return lista.sort(function (a, b) { return a.data.localeCompare(b.data); }).slice(-7);
}
function processarConferenciaColmeia(rows) {
  var porOperador = new Map(); // nome -> { unitaria, volumes }
  var unitDia = new Map(), volDia = new Map();
  rows.forEach(function (row) {
    var operador = obterCampo(row, ["Operador"]) || "(sem operador)";
    var unit = numero(obterCampo(row, ["Qtde Unitária Montada", "Qtde. Unitária Montada"]));
    var vol = numero(obterCampo(row, ["Qtde Volumes", "Qtde. Volumes"]));
    var atual = porOperador.get(operador) || { unitaria: 0, volumes: 0 };
    atual.unitaria += unit; atual.volumes += vol;
    porOperador.set(operador, atual);
    var dataISO = paraDataISO(obterCampo(row, ["Data"]));
    somarNoDia(unitDia, dataISO, operador, unit);
    somarNoDia(volDia, dataISO, operador, vol);
  });
  return { total: porOperador, unitDia: unitDia, volDia: volDia };
}

// ---- 8) Gerenciador de OR (geral) -> Recebimento ----
// ORs conferidas por Data da Conferência (não a de cadastro), separadas por
// tipo de recebimento (normal x reversa), produtividade por Usuário da Conferência.
function processarGerenciadorOR(rows) {
  var normal = { orsPeriodo: 0, orsConferidas: 0 };
  var reversa = { orsPeriodo: 0, orsConferidas: 0 };
  var rankingPorUsuario = new Map(); // usuario -> qtd ORs conferidas
  var porDiaConferencia = new Map();
  var rankingDia = new Map();
  var resumoDia = new Map(); // data -> contagens por tipo (cadastro e conferência)
  function regDia(d) {
    var r = resumoDia.get(d) || { data: d, normalPeriodo: 0, reversaPeriodo: 0, normalConferidas: 0, reversaConferidas: 0 };
    resumoDia.set(d, r); return r;
  }

  rows.forEach(function (row) {
    // Confirmado no export real (Gerenciador de OR 21.09): coluna "Tipo do
    // Recebimento", valores "COMPRA/TRANSFERÊNCIA - POR VOLUMES" (normal) e
    // "REVERSA - DEVOLUÇÃO DE CLIENTE FINAL" (reversa).
    var tipoRaw = normalizarTexto(obterCampo(row, ["Tipo do Recebimento"]));
    var ehReversa = tipoRaw.indexOf("REVERSA") !== -1;
    var bucket = ehReversa ? reversa : normal;
    bucket.orsPeriodo++;
    var dataCadISO = paraDataISO(obterCampo(row, ["Data de Cadastro"]));
    if (dataCadISO) regDia(dataCadISO)[ehReversa ? "reversaPeriodo" : "normalPeriodo"]++;

    // Confirmado: "Data da Conferência" preenchida bate 1:1 com "Conferida" = S.
    var dataConferenciaRaw = obterCampo(row, ["Data da Conferência"]);
    var dataConferenciaISO = paraDataISO(dataConferenciaRaw);
    var conferida = !!dataConferenciaRaw && String(dataConferenciaRaw).trim() !== "";
    if (conferida) {
      bucket.orsConferidas++;
      var usuario = obterCampo(row, ["Usuário da Conferência", "Usuario da Conferencia"]) || "(sem usuário)";
      rankingPorUsuario.set(usuario, (rankingPorUsuario.get(usuario) || 0) + 1);
      if (dataConferenciaISO) porDiaConferencia.set(dataConferenciaISO, (porDiaConferencia.get(dataConferenciaISO) || 0) + 1);
      somarNoDia(rankingDia, dataConferenciaISO, usuario, 1);
      if (dataConferenciaISO) regDia(dataConferenciaISO)[ehReversa ? "reversaConferidas" : "normalConferidas"]++;
    }
  });

  return { normal: normal, reversa: reversa, rankingPorUsuario: rankingPorUsuario, porDiaConferencia: porDiaConferencia, rankingDia: rankingDia, resumoDia: Array.from(resumoDia.values()).sort(function (a, b) { return a.data.localeCompare(b.data); }) };
}

// ---- 9) Bipagens + Diferença por Local -> Inventário ----
// Curva Real = soma das colunas 1ª..10ª Contagem ÷ soma de Qtde. Inventário
// (idêntico ao gerador.html do dashboard de Inventário). Mapeamento Bloco->
// Segmento: A/B/C = Calçados (pisos 1-4), E/F/G = Vestuário (só piso 1).
var COLUNAS_CONTAGEM = ["1ª Contagem", "2ª Contagem", "3ª Contagem", "4ª Contagem", "5ª Contagem", "6ª Contagem", "7ª Contagem", "8ª Contagem", "9ª Contagem", "10ª Contagem"];
var SEGMENTO_POR_BLOCO = { A: "Calçados", B: "Calçados", C: "Calçados", E: "Vestuário", F: "Vestuário", G: "Vestuário" };

function processarInventario(bipagensRows, diferencaRows) {
  var somaContagens = 0;
  var somaQtdeInventario = 0;
  var heatmap = new Map(); // bloco -> { p1,p2,p3,p4 }

  bipagensRows.forEach(function (row) {
    var qtdeInv = numero(obterCampo(row, ["Qtde. Inventário", "Qtde Inventário", "Qtde. Inventario"]));
    somaQtdeInventario += qtdeInv;
    var somaLinha = 0;
    COLUNAS_CONTAGEM.forEach(function (col) { somaLinha += numero(obterCampo(row, [col])); });
    somaContagens += somaLinha;

    var bloco = normalizarTexto(obterCampo(row, ["Bloco"]));
    var piso = numero(obterCampo(row, ["Piso", "Piso/Andar", "Andar"]));
    if (bloco && SEGMENTO_POR_BLOCO[bloco] && piso >= 1 && piso <= 4) {
      var reg = heatmap.get(bloco) || { p1: null, p2: null, p3: null, p4: null };
      var chave = "p" + piso;
      reg[chave] = (reg[chave] || 0) + somaLinha;
      heatmap.set(bloco, reg);
    }
  });

  var curvaReal = somaQtdeInventario ? (somaContagens / somaQtdeInventario) : null;

  var divergenciaGanhos = 0, divergenciaPerdas = 0;
  (diferencaRows || []).forEach(function (row) {
    // Confirmado no export real (Diferença por Local 21.09): coluna "Diferença".
    var diff = numero(obterCampo(row, ["Diferença"]));
    if (diff > 0) divergenciaGanhos += diff; else divergenciaPerdas += Math.abs(diff);
  });

  var heatmapArray = [];
  Object.keys(heatmap.entries ? {} : {}); // no-op para manter estilo função pura
  heatmap.forEach(function (reg, bloco) {
    var total = (reg.p1 || 0) + (reg.p2 || 0) + (reg.p3 || 0) + (reg.p4 || 0);
    heatmapArray.push({ bloco: bloco, segmento: SEGMENTO_POR_BLOCO[bloco], pisos: reg, total: total });
  });
  heatmapArray.sort(function (a, b) { return a.bloco.localeCompare(b.bloco); });

  return {
    bipagens: somaContagens,
    itensContados: somaQtdeInventario,
    curvaReal: curvaReal,
    divergenciaGanhos: divergenciaGanhos,
    divergenciaPerdas: divergenciaPerdas,
    heatmap: heatmapArray,
  };
}

// ---- Inventário acumulado por arquivo (a data vem do nome: "2909 PISO 3B RUA 01 A 05" = 29/09) ----
function dataDoNomeArquivo(nome) {
  var m = /^\s*(\d{2})(\d{2})/.exec(nome);
  if (!m) return null;
  var dd = Number(m[1]), mm = Number(m[2]);
  if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;
  var hoje = new Date(), ano = hoje.getFullYear();
  // Contagem de dezembro subida em janeiro pertence ao ano anterior.
  if (new Date(ano, mm - 1, dd).getTime() > hoje.getTime() + 86400000) ano--;
  return paraDataISOLocal(new Date(ano, mm - 1, dd));
}

// Meta Dia = Headcount × Produtividade/pessoa do setor (mesma regra do Dashboard de Inventário).
function metaDiaDeConfig(cfg) {
  cfg = cfg || {};
  var prod = cfg.setor === "Vestuário" ? (Number(cfg.prodVestuario) || 1500) : (Number(cfg.prodCalcados) || 4500);
  return Math.round((Number(cfg.headcount) || 0) * prod);
}

// Refaz KPIs, heatmap e série diária somando todos os arquivos já enviados no ciclo.
function recalcularInventario(inv) {
  var arquivos = inv.arquivos || {};
  var bip = 0, itens = 0;
  var heat = new Map();
  var porDia = new Map();
  Object.keys(arquivos).forEach(function (nome) {
    var a = arquivos[nome];
    bip += a.bipagens; itens += a.itensContados;
    var d = porDia.get(a.data) || { data: a.data, bipagens: 0, itens: 0 };
    d.bipagens += a.bipagens; d.itens += a.itensContados;
    porDia.set(a.data, d);
    (a.heatmap || []).forEach(function (l) {
      var reg = heat.get(l.bloco) || { bloco: l.bloco, segmento: l.segmento, pisos: { p1: null, p2: null, p3: null, p4: null }, total: 0 };
      ["p1", "p2", "p3", "p4"].forEach(function (pk) {
        if (l.pisos[pk] != null) reg.pisos[pk] = (reg.pisos[pk] || 0) + l.pisos[pk];
      });
      reg.total += l.total;
      heat.set(l.bloco, reg);
    });
  });
  var metaPorDia = inv.metaPorDia || {};
  inv.serieDias = Array.from(porDia.values()).sort(function (a, b) { return a.data.localeCompare(b.data); }).map(function (d) {
    return { data: d.data, bipagens: d.bipagens, itens: d.itens, meta: metaPorDia[d.data] || 0, curva: d.itens ? d.bipagens / d.itens : 0 };
  });
  inv.heatmap = Array.from(heat.values()).sort(function (a, b) { return a.bloco.localeCompare(b.bloco); });
  inv.kpis = Object.assign({}, inv.kpis, { bipagens: bip, itensContados: itens, curvaReal: itens ? bip / itens : null });
  return inv;
}

// ---- 10) Corte e Pula ----
// Fonte manual "Base Geral Corte/Pula" (abas Pulas-Colmeia / Corte Físico):
// cortesAtendidos/pulasAtendidos = total tratado (todos os status somados);
// "maiores agressores" = % Σ QTDE STATUS=NO ENDEREÇO ÷ Σ QTDE total do colaborador.
// Fontes reais do WMS "Corte em Tela" e "Corte Resolvido" (STATUS ACEITO/RECUSADO):
// cortesEmTela = linhas do relatório em tela.
// ACEITO = aceitamos o corte porque NÃO tínhamos o produto — é furo de
// estoque, não uma resolução (mantido no campo cortesAceitos por
// compatibilidade com snapshots antigos, mas o rótulo na tela deixa isso claro).
// RECUSADO = recusamos o corte porque achamos o produto pra separar — só
// isso; o relatório não informa se foi no endereço, fora dele ou já
// atendido (mantido no campo cortesNoEndereco por compatibilidade).
function processarBaseGeralCortePula(pulasRows, corteFisicoRows) {
  function somarQtde(rows) { var s = 0; rows.forEach(function (r) { s += numero(obterCampo(r, ["QTDE", "Qtde", "Quantidade"])); }); return s; }
  var pulasAtendidos = somarQtde(pulasRows);
  var cortesAtendidos = somarQtde(corteFisicoRows);

  var porColaborador = new Map(); // nome -> { localizado, total }
  var agressoresDia = new Map();  // data -> Map(nome -> { localizado, total })
  var atendidosDia = new Map();   // data -> { cortes, pulas }
  function dataDaLinha(row) {
    return paraDataISO(obterCampo(row, ["DATA CORTE", "DATA DE OPERAÇÃO", "DATA DE OPERACAO"]));
  }
  function contarAtendidosDia(rows, campo) {
    rows.forEach(function (row) {
      var d = dataDaLinha(row);
      if (!d) return;
      var reg = atendidosDia.get(d) || { data: d, cortes: 0, pulas: 0 };
      reg[campo] += numero(obterCampo(row, ["QTDE", "Qtde", "Quantidade"]));
      atendidosDia.set(d, reg);
    });
  }
  contarAtendidosDia(pulasRows, "pulas");
  contarAtendidosDia(corteFisicoRows, "cortes");
  function acumularAgressores(rows) {
    rows.forEach(function (row) {
      // A aba Corte Físico vem com o cabeçalho "Nome do Usuário" (às vezes com acento corrompido).
      var usuario = obterCampo(row, ["USUÁRIO", "Usuário", "Usuario", "Nome do Usuário", "Nome do UsuÃ¡rio"]) || "(sem usuário)";
      var status = normalizarTexto(obterCampo(row, ["STATUS", "Status"]));
      var qtde = numero(obterCampo(row, ["QTDE", "Qtde", "Quantidade"]));
      var atual = porColaborador.get(usuario) || { localizado: 0, total: 0 };
      atual.total += qtde;
      if (status === "NO ENDERECO") atual.localizado += qtde; // "NO ENDEREÇO" sem acento após normalizarTexto
      porColaborador.set(usuario, atual);
      var dRow = dataDaLinha(row);
      if (dRow) {
        var mDia = agressoresDia.get(dRow) || new Map();
        var aDia = mDia.get(usuario) || { localizado: 0, total: 0 };
        aDia.total += qtde;
        if (status === "NO ENDERECO") aDia.localizado += qtde;
        mDia.set(usuario, aDia); agressoresDia.set(dRow, mDia);
      }
    });
  }
  acumularAgressores(pulasRows);
  acumularAgressores(corteFisicoRows);

  var agressoresDiaArr = [];
  agressoresDia.forEach(function (m, data) {
    var itens = {};
    m.forEach(function (v, k) { itens[k] = v; });
    agressoresDiaArr.push({ data: data, itens: itens });
  });
  agressoresDiaArr.sort(function (a, b) { return a.data.localeCompare(b.data); });
  var atendidosArr = Array.from(atendidosDia.values()).sort(function (a, b) { return a.data.localeCompare(b.data); });
  return { pulasAtendidos: pulasAtendidos, cortesAtendidos: cortesAtendidos, porColaborador: porColaborador, agressoresDia: agressoresDiaArr, atendidosDia: atendidosArr };
}

// ---- 10) Corte em Tela -> KPI "Cortes em tela" + conjunto de pedidos com corte aberto ----
// Quando um corte atinge mais de um pedido, a mesma linha lista todos os
// "Pedido de Venda" juntos, separados por vírgula (ex.: "8266323,8266455")
// — cada um conta como um pedido distinto sinalizado com corte ainda aberto.
function processarCorteEmTela(rows) {
  var pedidos = new Set();
  var porDia = new Map();
  rows.forEach(function (row) {
    // "Data Corte" no Relatório de Corte Físico; "Data" no export Corte Físico Em tela.
    var dataISO = paraDataISO(obterCampo(row, ["Data Corte", "Data"]));
    if (dataISO) porDia.set(dataISO, (porDia.get(dataISO) || 0) + 1);
    String(obterCampo(row, ["Pedido de Venda", "Pedido"]) || "").split(",").forEach(function (p) {
      p = p.trim();
      if (p) pedidos.add(p);
    });
  });
  return { total: rows.length, pedidos: Array.from(pedidos), serie: mapParaSerieDia(porDia, "total") };
}

function processarCorteResolvido(rows) {
  var aceitos = 0, noEndereco = 0;
  var porDia = new Map();
  rows.forEach(function (row) {
    var status = normalizarTexto(obterCampo(row, ["STATUS", "Status"]));
    // Confirmado no export real (Corte Físico Resolvido 21.09): "Data Resolução".
    var dataISO = paraDataISO(obterCampo(row, ["Data Resolução", "Data Resolucao", "Data Resolução Corte"]));
    var reg = dataISO ? (porDia.get(dataISO) || { data: dataISO, aceitos: 0, recusados: 0 }) : null;
    if (reg) porDia.set(dataISO, reg);
    if (status === "ACEITO") { aceitos++; if (reg) reg.aceitos++; }
    else if (status === "RECUSADO") { noEndereco++; if (reg) reg.recusados++; }
  });
  return { aceitos: aceitos, noEndereco: noEndereco, porDia: Array.from(porDia.values()).sort(function (a, b) { return a.data.localeCompare(b.data); }) };
}

// ---- 11) Cancelamentos WMS ----
// Controle de Nota Fiscal: linhas com Data de Cancelamento preenchida,
// agrupadas por Motivo e por Usuário Cancelamento, quebra SINGLE/MULTI.
// Filtro de data usa a coluna Data de Cancelamento (não a de cadastro).
function processarCancelamentosWMS(rows) {
  var porMotivo = new Map();
  var porUsuario = new Map();
  var single = 0, multi = 0, total = 0;
  var porDiaMap = new Map(); // data ISO -> { total, single, multi, motivos, usuarios }
  rows.forEach(function (row) {
    var dataCancRaw = obterCampo(row, ["Data de Cancelamento", "Data Cancelamento"]);
    if (!dataCancRaw || !String(dataCancRaw).trim()) return;
    total++;
    var dataISO = paraDataISO(dataCancRaw);
    var dia = null;
    if (dataISO) {
      dia = porDiaMap.get(dataISO) || { data: dataISO, total: 0, single: 0, multi: 0, motivos: {}, usuarios: {}, cruz: {}, smMotivo: {}, smUsuario: {} };
      porDiaMap.set(dataISO, dia);
      dia.total++;
    }
    // Confirmado no export real (Controle de NF Cancelamento 21.09): coluna
    // "Motivo de Cancelamento" (não "Motivo"). Os valores vêm com grafia
    // inconsistente (ex.: "Cancelado ERP" / "CANCELADO PELO ERP" / minúsculo),
    // então agrupamos pela forma normalizada (sem acento, maiúscula).
    var motivoRaw = obterCampo(row, ["Motivo de Cancelamento"]) || "(sem motivo)";
    var motivo = normalizarTexto(motivoRaw).replace(/^CANCELADO PELO ERP$/, "CANCELADO ERP");   // mesma coisa, grafias diferentes
    var usuario = obterCampo(row, ["Usuário Cancelamento", "Usuario Cancelamento"]) || "(sem usuário)";
    porMotivo.set(motivo, (porMotivo.get(motivo) || 0) + 1);
    porUsuario.set(usuario, (porUsuario.get(usuario) || 0) + 1);
    // Confirmado no export real: coluna "Classificação Tipo Pedido", valores SINGLE/MULTI.
    var classificacao = normalizarTexto(obterCampo(row, ["Classificação Tipo Pedido"]));
    if (classificacao.indexOf("MULTI") !== -1) multi++; else if (classificacao.indexOf("SINGLE") !== -1) single++;
    if (dia) {
      dia.motivos[motivo] = (dia.motivos[motivo] || 0) + 1;
      dia.usuarios[usuario] = (dia.usuarios[usuario] || 0) + 1;
      if (classificacao.indexOf("MULTI") !== -1) dia.multi++; else if (classificacao.indexOf("SINGLE") !== -1) dia.single++;
      // Cruzamento motivo × usuário e quebra Single/Multi de cada um (detalhe ao clicar na tela).
      var cm = dia.cruz[motivo] || (dia.cruz[motivo] = {});
      cm[usuario] = (cm[usuario] || 0) + 1;
      var tipo = classificacao.indexOf("MULTI") !== -1 ? "m" : (classificacao.indexOf("SINGLE") !== -1 ? "s" : null);
      if (tipo) {
        var a = dia.smMotivo[motivo] || (dia.smMotivo[motivo] = { s: 0, m: 0 }); a[tipo]++;
        var b = dia.smUsuario[usuario] || (dia.smUsuario[usuario] = { s: 0, m: 0 }); b[tipo]++;
      }
    }
  });
  var porDia = Array.from(porDiaMap.values()).sort(function (a, b) { return a.data.localeCompare(b.data); });
  return { total: total, porMotivo: porMotivo, porUsuario: porUsuario, single: single, multi: multi, porDia: porDia };
}

// ---- 12) Integração Reversa ----
// Controle de NF Reversa + Itens de NF de Entrada, junção OR -> NF (campo
// Ordem de Recebimento) -> Itens (idNotaFiscal). KPIs do topo mostram só o
// que está em tela (Importada + Em Carga/OR); gráfico mostra volume total/dia.
function processarIntegracaoReversa(nfReversaRows) {
  var emTela = 0, importadas = 0, emCarga = 0, processadasHoje = 0;
  var porDia = new Map();
  var hojeISO = paraDataISOLocal(new Date());
  nfReversaRows.forEach(function (row) {
    // O Controle de NF agora vem sem filtro e traz também as NFs de venda
    // (Tipo SAIDA), que usam os mesmos status IMPORTADA / EM CARGA/OR.
    // Confirmado no export real de reversa: Operação = "REVERSA" (Tipo ENTRADA).
    if (normalizarTexto(obterCampo(row, ["Operação", "Operacao"])).indexOf("REVERSA") === -1) return;
    var status = normalizarTexto(obterCampo(row, ["Status"]));
    if (status === "IMPORTADA") { importadas++; emTela++; }
    else if (status === "EM CARGA/OR" || status === "EM CARGA / OR") { emCarga++; emTela++; }
    // Confirmado no export real (Controle de NF Reversa 21.09): "Data de
    // Processamento" só vem preenchida quando Status = PROCESSADA (bateu
    // 1:1 nas contagens), então é o campo certo pra "processadas hoje".
    var dataProcRaw = obterCampo(row, ["Data de Processamento"]);
    var dataProcISO = paraDataISO(dataProcRaw);
    if (dataProcISO === hojeISO) processadasHoje++;

    // "Data de Cadastro" é preenchida em 100% das linhas (é quando a NF
    // entra no WMS) — é essa a data usada na série "NFs integradas por dia".
    // Não existe campo separado de "Data de Integração" neste relatório.
    var dataIntegracaoISO = paraDataISO(obterCampo(row, ["Data de Cadastro"]));
    if (dataIntegracaoISO) porDia.set(dataIntegracaoISO, (porDia.get(dataIntegracaoISO) || 0) + 1);
  });
  return { emTela: emTela, importadas: importadas, emCarga: emCarga, processadasHoje: processadasHoje, porDia: porDia };
}

// ---- 13) Vinculação Reversa ----
// Gerenciador de OR - Reversa: OR com Nota Fiscal preenchida = vinculada.
// O WMS não grava quem vinculou (Cadastrado pelo Usuário = sempre "SILT"),
// então o nome é extraído do campo Veiculo por texto livre, removendo
// palavras de categoria e cruzando com a Base de Ativos. Sem nome
// identificável entra como "não identificado", nunca descartado. Só entram
// linhas com a palavra "REVERSA" no Veiculo — "QUALIDADE" sozinho é outro
// time (bipagem de material validado pela Qualidade), fora do escopo aqui.

// Confirmado no export real (Gerenciador de OR - Reversa): o campo Veiculo
// mistura a categoria da ocorrência com o primeiro nome do colaborador, em
// separadores variados ("REVERSA - DARA", "REVERSA-EVELYN", "QUALIDADE_ROSANEA",
// "REVERSA, CONFECCÇÃO - RENATO"...). Palavras de categoria observadas nos
// dados reais: REVERSA, QUALIDADE, AVARIA, CONFECÇÃO (e a grafia errada
// "CONFECCÇÃO"), OUTLET, INVENTARIO/INVERSÃO, SOLICITAÇÃO, NFD/NFS.
var PALAVRAS_CATEGORIA_VEICULO = [
  "QUALIDADE", "REVERSA", "AVARIA", "CONFECCAO", "CONFECCCAO", "OUTLET",
  "INVENTARIO", "INVERSAO", "SOLICITACAO", "NFD", "NFS",
  "DEVOLUCAO", "TROCA", "DEFEITO", "GARANTIA", "VEICULO", "CAMINHAO", "TRANSPORTADORA"
];

// Só nome(s) restante(s) depois de tirar as palavras de categoria — tenta par
// (primeiro+sobrenome, quando o Veiculo trouxer dois nomes) e, se sobrar um
// único token (o caso mais comum aqui: só o primeiro nome), tenta casar pelo
// índice de primeiro nome. Só resolve se o primeiro nome for único na Base de
// Ativos — se mais de um colaborador tiver o mesmo primeiro nome, fica
// ambíguo de propósito (nunca adivinha errado).
function extrairNomeDoVeiculo(textoVeiculo, indiceBaseAtivos, indicePorPrimeiroNome) {
  var tokens = normalizarTexto(textoVeiculo).split(/[^A-Z]+/).filter(function (t) {
    return t && PALAVRAS_CATEGORIA_VEICULO.indexOf(t) === -1 && CONECTIVOS_NOME.indexOf(t) === -1;
  });
  for (var i = 0; i < tokens.length; i++) {
    for (var j = i + 1; j < tokens.length; j++) {
      var chave1 = tokens[i] + "." + tokens[j];
      var chave2 = tokens[j] + "." + tokens[i];
      if (indiceBaseAtivos.has(chave1)) return indiceBaseAtivos.get(chave1);
      if (indiceBaseAtivos.has(chave2)) return indiceBaseAtivos.get(chave2);
    }
  }
  if (tokens.length && indicePorPrimeiroNome) {
    for (var k = 0; k < tokens.length; k++) {
      var candidatos = indicePorPrimeiroNome.get(tokens[k]);
      if (candidatos && candidatos.length === 1) return candidatos[0];
    }
  }
  return null;
}

// O foco deste indicador é sempre a produtividade do time de Reversa — por
// isso só entram linhas cujo Veiculo contém a palavra "REVERSA". Linhas só
// com "QUALIDADE" (ou outra categoria sem "REVERSA") são de um time à parte,
// que bipa material validado pela Qualidade, e não entram nem no total nem
// no "não identificado" desta tela.
// Cada OR traz várias notas fiscais no campo "Nota Fiscal", separadas por vírgula; cada
// nota é a devolução de um pedido. O ranking conta as NOTAS DISTINTAS que cada pessoa
// vinculou (pedidos), e não uma OR por linha. A mesma nota em duas ORs da mesma pessoa
// conta uma vez; em ORs de pessoas diferentes conta para as duas no ranking, e o total
// geral conta cada nota uma vez só. Linhas com Nota Fiscal vazia seguem de fora.
function listarNotasFiscais(valor) {
  var vistas = new Set(), lista = [];
  String(valor == null ? "" : valor).split(/[,;]+/).forEach(function (nf) {
    nf = nf.trim();
    if (nf && !vistas.has(nf)) { vistas.add(nf); lista.push(nf); }
  });
  return lista;
}
function processarVinculacaoReversa(orReversaRows, indiceBaseAtivos, indicePorPrimeiroNome) {
  var totalOR = 0, naoIdentificadoOR = 0;
  var nfGeral = new Set(), nfNaoIdent = new Set();
  var nfPessoa = new Map();    // nome -> Set de notas
  var nfPessoaDia = new Map(); // "data|nome" -> { data, nome, notas:Set }
  var diaInfo = new Map();     // data -> { data, nfs:Set, nfsNaoIdent:Set, ors, orsNaoIdentificado }
  orReversaRows.forEach(function (row) {
    var notas = listarNotasFiscais(obterCampo(row, ["Nota Fiscal"]));
    if (!notas.length) return; // só ORs vinculadas
    var veiculo = obterCampo(row, ["Veiculo", "Veículo"]) || "";
    if (normalizarTexto(veiculo).indexOf("REVERSA") === -1) return; // fora do time de Reversa
    totalOR++;
    // Data em que a OR foi cadastrada/vinculada (Gerenciador de OR, "Data de Cadastro").
    var dataISO = paraDataISO(obterCampo(row, ["Data de Cadastro"]));
    var dia = null;
    if (dataISO) {
      dia = diaInfo.get(dataISO) || { data: dataISO, nfs: new Set(), nfsNaoIdent: new Set(), ors: 0, orsNaoIdentificado: 0 };
      diaInfo.set(dataISO, dia); dia.ors++;
    }
    notas.forEach(function (nf) { nfGeral.add(nf); if (dia) dia.nfs.add(nf); });
    var colaborador = extrairNomeDoVeiculo(veiculo, indiceBaseAtivos, indicePorPrimeiroNome);
    if (colaborador) {
      var setP = nfPessoa.get(colaborador.nome) || new Set(); nfPessoa.set(colaborador.nome, setP);
      notas.forEach(function (nf) { setP.add(nf); });
      if (dataISO) {
        var chave = dataISO + "|" + colaborador.nome;
        var reg = nfPessoaDia.get(chave) || { data: dataISO, nome: colaborador.nome, notas: new Set() };
        nfPessoaDia.set(chave, reg);
        notas.forEach(function (nf) { reg.notas.add(nf); });
      }
    } else {
      naoIdentificadoOR++;
      notas.forEach(function (nf) { nfNaoIdent.add(nf); if (dia) dia.nfsNaoIdent.add(nf); });
      if (dia) dia.orsNaoIdentificado++;
    }
  });
  var ranking = new Map(), rankingDia = new Map();
  nfPessoa.forEach(function (set, nome) { ranking.set(nome, set.size); });
  nfPessoaDia.forEach(function (reg) { somarNoDia(rankingDia, reg.data, reg.nome, reg.notas.size); });
  var resumoDia = Array.from(diaInfo.values()).map(function (d) {
    return { data: d.data, total: d.nfs.size, naoIdentificado: d.nfsNaoIdent.size, ors: d.ors, orsNaoIdentificado: d.orsNaoIdentificado };
  }).sort(function (a, b) { return a.data.localeCompare(b.data); });
  return {
    totalPedidos: nfGeral.size, naoIdentificadoPedidos: nfNaoIdent.size,
    totalOR: totalOR, naoIdentificadoOR: naoIdentificadoOR,
    ranking: ranking, rankingDia: rankingDia, resumoDia: resumoDia,
  };
}

// ---- 14) Acompanhamento_Op -> Itens em separação + Aguardando geração de onda ----
// Mesmo relatório e mesmos status do Report E-commerce (ver calcularStatus()
// do ingest.js de lá) — mais confiável que o Gerenciador de Ondas em tela
// porque cobre o pedido do início ("01 - Gerar") ao fim.
var STATUS_AGUARDANDO_ONDA = ["IMPORTADO", "AG. FORMACAO DE ROMANEIO/ONDA", "QUARENTENA"].map(normalizarTexto);
var STATUS_EM_SEPARACAO = ["AG. SEPARACAO", "SEPARACAO INICIADA", "AG. RESOLUCAO QUEBRA - SEPARACAO"].map(normalizarTexto);

function processarAcompanhamentoOp(rows, pedidosComCorte) {
  var setCorte = new Set(pedidosComCorte || []);
  var emSeparacao = { single: 0, multi: 0, comCorte: 0, pedidos: [] };
  var aguardandoOnda = { single: 0, multi: 0, superExpresso: 0 };
  rows.forEach(function (row) {
    var cancelado = normalizarTexto(obterCampo(row, ["Cancelado Pelo ERP"]));
    if (cancelado === "SIM" || cancelado === "S" || cancelado === "TRUE" || cancelado === "1") return;

    var status = normalizarTexto(obterCampo(row, ["Status da Nota Fiscal"]));
    var classificacao = normalizarTexto(obterCampo(row, ["Classificação Tipo Pedido"]));
    var ehSingle = classificacao.indexOf("SINGLE") !== -1;
    var ehMulti = classificacao.indexOf("MULTI") !== -1;

    if (STATUS_EM_SEPARACAO.indexOf(status) !== -1) {
      var qtde = numero(obterCampo(row, ["Qtde. Total de Produto"]));
      if (ehSingle) emSeparacao.single += qtde;
      else if (ehMulti) emSeparacao.multi += qtde;
      // Cruza com o Corte em Tela (mesmo campo Pedido de Venda) pra saber
      // quantos pedidos em separação já estão com corte sinalizado e ainda
      // não resolvido. Só conta se o Corte em Tela já tiver sido abastecido.
      var pedido = String(obterCampo(row, ["Pedido de Venda"]) || "").trim();
      if (pedido) emSeparacao.pedidos.push(pedido);
      if (pedido && setCorte.has(pedido)) emSeparacao.comCorte++;
    } else if (STATUS_AGUARDANDO_ONDA.indexOf(status) !== -1) {
      if (ehSingle) aguardandoOnda.single++;
      else if (ehMulti) aguardandoOnda.multi++;
      // Confirmado no export real: "SUPER EXPRESSO" aparece na coluna
      // "Serviço da Transportadora" (a coluna "Prioridade" existe mas vem
      // sempre vazia neste relatório).
      var superExpresso = normalizarTexto(obterCampo(row, ["Serviço da Transportadora"]));
      if (superExpresso.indexOf("SUPER EXPRESSO") !== -1) aguardandoOnda.superExpresso++;
    }
  });
  return { emSeparacao: emSeparacao, aguardandoOnda: aguardandoOnda };
}

// ---- 15) Operação agora, em ITENS (Tela C do telão) ----
// Acompanhamento_Op diz a etapa e os itens de cada pedido; Itens de NF de
// Saída diz a marca. Fica no snapshot "operacao": os pedidos e as marcas
// (para recalcular quando só um dos dois relatórios chega) + o resumo que o
// telão lê. Etapas iguais às do Report E-commerce (calcularStatus de lá).
var ETAPAS_OPERACAO = ["01 - Gerar", "02 - Em Separação", "03 - Separado - Aguardando NF", "04 - Separado - Conferir", "05 - Conferido - Despachar"];

// "dd/mm/aaaa HH:mm:ss", Date ou serial do Excel -> milissegundos (null se vazio).
function dataHoraParaMs(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  if (valor instanceof Date) return isNaN(valor.getTime()) ? null : valor.getTime();
  if (typeof valor === "number") return excelSerialParaData(valor).getTime();
  var m = String(valor).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
}

// Índice em ETAPAS_OPERACAO, ou -1 (cancelado, despachado ou status desconhecido).
function etapaDoPedido(row) {
  var cancelado = normalizarTexto(obterCampo(row, ["Cancelado Pelo ERP"]));
  if (cancelado === "SIM" || cancelado === "S" || cancelado === "TRUE" || cancelado === "1") return -1;
  var status = normalizarTexto(obterCampo(row, ["Status da Nota Fiscal"]));
  var tem = function (col) { var v = obterCampo(row, [col]); return v !== undefined && v !== null && String(v).trim() !== ""; };
  if (STATUS_AGUARDANDO_ONDA.indexOf(status) !== -1) return 0;
  if (STATUS_EM_SEPARACAO.indexOf(status) !== -1) return 1;
  if (status === "ENVIADO PARA FATURAMENTO" && !tem("Faturado em")) return 2;
  if ((status === "ENVIADO PARA FATURAMENTO" || status === "FATURADO") && !tem("Conferido em")) return 3;
  return tem("Processado em") ? -1 : 4;   // conferido, aguardando coleta (processado = despachado, sai)
}

// ---- Dias úteis: cópia da regra do Report E-commerce (report-ecommerce/ingest.js) ----
// Seg a sex, sem os feriados oficiais (nacional + municipal de Extrema-MG). Atualizar a lista todo ano.
var FERIADOS_2026 = new Set(["2026-01-01", "2026-04-18", "2026-04-21", "2026-05-01", "2026-05-22", "2026-09-07",
  "2026-09-18", "2026-10-12", "2026-11-02", "2026-11-15", "2026-11-20", "2026-12-25"]);
function ehDiaUtil(date) {
  var dow = date.getDay();
  if (dow === 0 || dow === 6) return false;
  return !FERIADOS_2026.has(paraDataISOLocal(date));
}
// Dias úteis completos entre duas datas (como no Backlog FIFO do Report): hoje ou ontem = 0/1, 2+ = fora do prazo.
function diferencaDiasUteis(dataInicial, dataFinal) {
  var d = new Date(dataInicial.getFullYear(), dataInicial.getMonth(), dataInicial.getDate());
  var fim = new Date(dataFinal.getFullYear(), dataFinal.getMonth(), dataFinal.getDate()), contados = 0;
  while (d <= fim) { if (ehDiaUtil(d)) contados++; d.setDate(d.getDate() + 1); }
  return contados - 1;
}

// Pedido -> [etapa, itens, importado em (ms), separado sem conferir (1/0), faturado sem coleta (0 = não, 1 = checkout/SINGLE, 2 = colmeia/MULTI)]
// Separado sem conferir = status ENVIADO PARA FATURAMENTO e "Conferido em" vazio: a separação
// terminou, mas o pedido ainda não passou no caixa de faturamento (lá vira FATURADO com a data).
// Faturado sem coleta = status FATURADO com "Faturado em" e coluna Carga vazia: conferido e faturado, mas
// ainda não entrou em nenhuma coleta (ao embarcar vira PROCESSADA no Itens de NF e sai do OP).
// Transportadora e SINGLE/MULTI das notas que estão no OP (mesmo formato do processarInfoNf, status "OP"):
// a nota sai do OP só depois de embarcar, então o Kardex que mostra o embarque já acha a transportadora.
function infoNfDoOp(rows) {
  var info = {};
  rows.forEach(function (row) {
    var id = String(obterCampo(row, ["idNotaFiscal"]) || "").trim();
    if (!id) return;
    var cl = normalizarTexto(obterCampo(row, ["Classificação Tipo Pedido", "Classificacao Tipo Pedido"]));
    info[id] = [String(obterCampo(row, ["Transportadora"]) || "").trim(), cl.indexOf("MULTI") !== -1 ? "M" : cl.indexOf("SINGLE") !== -1 ? "S" : "", "OP", ""];
  });
  return info;
}
function processarOperacaoOp(rows) {
  var pedidos = {};
  rows.forEach(function (row) {
    var pedido = String(obterCampo(row, ["Pedido de Venda"]) || "").trim();
    var etapa = etapaDoPedido(row);
    if (!pedido || etapa < 0) return;
    var conferidoEm = obterCampo(row, ["Conferido em"]);
    var semConf = normalizarTexto(obterCampo(row, ["Status da Nota Fiscal"])) === "ENVIADO PARA FATURAMENTO" && (conferidoEm == null || String(conferidoEm).trim() === "") ? 1 : 0;
    var vazio = function (col) { var v = obterCampo(row, [col]); return v == null || String(v).trim() === ""; };
    var semColeta = normalizarTexto(obterCampo(row, ["Status da Nota Fiscal"])) === "FATURADO" && !vazio("Faturado em") && vazio("Carga")
      ? (normalizarTexto(obterCampo(row, ["Classificação Tipo Pedido", "Classificacao Tipo Pedido"])).indexOf("MULTI") !== -1 ? 2 : 1) : 0;
    var clTipo = normalizarTexto(obterCampo(row, ["Classificação Tipo Pedido", "Classificacao Tipo Pedido"]));
    pedidos[pedido] = [etapa, numero(obterCampo(row, ["Qtde. Total de Produto"])), dataHoraParaMs(obterCampo(row, ["Importado em"])), semConf, semColeta,
      clTipo.indexOf("MULTI") !== -1 ? "M" : clTipo.indexOf("SINGLE") !== -1 ? "S" : ""];
  });
  return pedidos;
}

// Marca do produto: 1) base Embalas pelo Artigo do código (Artigo -> MARCA, card up-embalas); 2) fora da
// Embalas, palavra-chave no nome (mesma regra do Report E-commerce); 3) sem as duas, Olympikus.
var MARCA_DA_LETRA = { O: "Olympikus", M: "Mizuno", U: "Under Armour", P: "Opanka" };
function marcaPorNome(descricao) {
  var d = normalizarTexto(descricao);
  if (/MIZUNO|\bMIZ\b/.test(d)) return "Mizuno";
  if (/UNDER ARMOUR|\bUA\b|UNDERARMOUR|\bUNDER\b/.test(d)) return "Under Armour";
  if (/OLYMPIKUS|\bOLY\b|\bOLK\b/.test(d)) return "Olympikus";
  if (/OPANKA/.test(d)) return "Opanka";
  return null;
}
function marcaPorDescricao(descricao, codigo, embalas) {
  var art = String(codigo || "").trim().split("_")[0];
  return (embalas && MARCA_DA_LETRA[String(embalas[art] || "").charAt(0)]) || marcaPorNome(descricao) || "Olympikus";
}

// Segmento do produto (armazenagem no telão): só Calçados (C, com chinelos e chuteiras) ou Vestuário (V, com
// meias e acessórios). 1) Embalas pelo Artigo (2ª letra do valor gravado); 2) palavra-chave no nome; 3) Calçados.
function segmentoDoProduto(codigo, descricao, embalas) {
  var cod = String(codigo || "").trim();
  var v = embalas ? String(embalas[cod.split("_")[0]] || embalas[cod.split("-")[0]] || "").charAt(1) : "";
  if (v === "C" || v === "V") return v;
  var d = normalizarTexto(descricao);
  if (/TENIS|CHUTEIRA|CHINELO|SANDALIA|SAPATILHA|SAPATO|\bBOTA\b|\bSLIDE\b/.test(d)) return "C";
  if (/\bMEIA|CAMIS|BERMUDA|SHORT|\bCALCA|JAQUETA|BLUSA|REGATA|\bTOP\b|LEGGING|\bBONE\b|MOCHILA|BOLSA|VISEIRA|MANGUITO|SQUEEZE|GARRAFA|POCHETE|AGASALHO|MOLETOM|VENTO|\bSAIA\b|VESTIDO|MACAQU|SUTIA|CUECA|\bLUVA|GORRO|TOALHA|SACOLA|\bBOLA\b|CANELEIRA|MEIAO/.test(d)) return "V";
  return "C";
}

// Embalas (base de embalagem, aba Base Final) -> { Artigo: letra da marca }
function processarEmbalas(rows) {
  var mapa = {};
  rows.forEach(function (row) {
    var art = String(obterCampo(row, ["Artigo"]) || "").trim() || String(obterCampo(row, ["SKU"]) || "").trim().split("_")[0];
    var m = normalizarTexto(obterCampo(row, ["MARCA", "Marca"]));
    var letra = m.indexOf("MIZUNO") !== -1 ? "M" : m.indexOf("UNDER") !== -1 ? "U" : m.indexOf("OPANKA") !== -1 ? "P" : m.indexOf("OLYMPIKUS") !== -1 ? "O" : null;
    // Valor = letra da marca ("-" sem marca) + letra do segmento: C (calçados, chinelos) ou V (vestuários, meias, acessórios)
    var s = normalizarTexto(obterCampo(row, ["SEGMENTO", "Segmento"]));
    var seg = !s ? "" : /VESTU|MEIA|ACESS/.test(s) ? "V" : "C";
    if (art && (letra || seg)) mapa[art] = (letra || "-") + seg;
  });
  return mapa;
}

// Pedido -> marca com mais peças no pedido. "abertos" = pedidos cuja nota ainda não foi processada nem
// cancelada (seguem em operação): a marca deles fica guardada mesmo se ainda não estavam no último OP.
function processarMarcasItensNf(rows, embalas) {
  var somas = {}, abertos = {};
  rows.forEach(function (row) {
    var pedido = String(obterCampo(row, ["Pedido de Venda"]) || "").trim();
    if (!pedido) return;
    var marca = marcaPorDescricao(obterCampo(row, ["Produto"]), obterCampo(row, ["Código do Produto", "Codigo do Produto"]), embalas);
    var s = somas[pedido] || (somas[pedido] = {});
    s[marca] = (s[marca] || 0) + (numero(obterCampo(row, ["Quantidade"])) || 1);
    var st = normalizarTexto(obterCampo(row, ["Status"]));
    if (st !== "PROCESSADA" && st.indexOf("CANCELAD") !== 0) abertos[pedido] = 1;
  });
  var marcas = {};
  Object.keys(somas).forEach(function (p) {
    var s = somas[p];
    marcas[p] = Object.keys(s).sort(function (a, b) { return s[b] - s[a]; })[0];
  });
  return { marcas: marcas, abertos: abertos };
}

function resumoOperacao(op) {
  var pedidos = op.pedidos || {}, marcas = op.marcas || {};
  var r = { itens: 0, pedidos: 0, maisAntigo: null, maisAntigoPedido: null, semMarca: 0, semMarcaPedidos: [], marcas: {}, semConferir: { itens: 0, pedidos: 0 }, semColeta: { itens: 0, pedidos: 0, checkout: 0, colmeia: 0 },
    single: 0, multi: 0,   // itens por tipo de pedido (Classificação Tipo Pedido)
    etapas: ETAPAS_OPERACAO.map(function (nome) { return { nome: nome, itens: 0, pedidos: 0, single: 0, multi: 0, marcas: {} }; }),
    idade: ["Hoje", "Ontem", "2 dias", "3+ dias"].map(function (l) { return { label: l, itens: 0, pedidos: 0, single: 0, multi: 0 }; }),
    opEm: op.opEm || null, nfEm: op.nfEm || null };
  // Idade em DIAS ÚTEIS, mesma regra do Report E-commerce (diferencaDiasUteis): seg a sex sem feriados.
  var ref = new Date(op.opEm || Date.now()), cacheIdade = {};
  function idadeDias(imp) {
    var d = new Date(imp), k = paraDataISOLocal(d);
    if (cacheIdade[k] == null) cacheIdade[k] = Math.max(0, diferencaDiasUteis(d, ref));
    return cacheIdade[k];
  }
  Object.keys(pedidos).forEach(function (p) {
    var e = pedidos[p], etapa = r.etapas[e[0]], itens = e[1], imp = e[2], marca = marcas[p] || "Olympikus";   // sem produto no Itens de NF: mesma reserva da regra de marca
    r.itens += itens; r.pedidos++;
    etapa.itens += itens; etapa.pedidos++;
    var tp = e[5] === "M" ? "multi" : e[5] === "S" ? "single" : null;
    if (tp) { r[tp] += itens; etapa[tp] += itens; }
    etapa.marcas[marca] = (etapa.marcas[marca] || 0) + itens;
    r.marcas[marca] = (r.marcas[marca] || 0) + itens;
    if (!marcas[p]) { r.semMarca += itens; if (r.semMarcaPedidos.length < 10) r.semMarcaPedidos.push(p); }
    if (e[3]) { r.semConferir.itens += itens; r.semConferir.pedidos++; }
    if (e[4]) { r.semColeta.itens += itens; r.semColeta.pedidos++; r.semColeta[e[4] === 2 ? "colmeia" : "checkout"] += itens; }
    if (imp) {
      if (r.maisAntigo === null || imp < r.maisAntigo) { r.maisAntigo = imp; r.maisAntigoPedido = p; }
      var faixa = r.idade[Math.min(3, idadeDias(imp))];
      faixa.itens += itens; faixa.pedidos++;
      if (tp) faixa[tp] += itens;
    }
  });
  r.maisAntigoDias = r.maisAntigo === null ? null : idadeDias(r.maisAntigo);
  r.expedicao = resumoExpedicao(op);
  return r;
}

// ---- Expedição no snapshot "operacao" ----
// op.expNfs  = { dia: { idNF: [usuario, minuto, peças] } } das notas embarcadas nos 2 dias mais recentes
//              (cada Kardex JUNTA com o que já tinha, então um Kardex parcial não apaga o dia)
// op.expDias = resumo congelado dos dias que saíram dos 2 crus (até 31 dias)
// op.nfInfo  = { t: [transportadoras], n: { idNF: [índice da transportadora, "S"|"M"|""] } } das notas
//              EM CARGA/OR (vão embarcar) + as notas já embarcadas em op.expNfs
// op.expPrev = previsão da expedição, calculada na hora em que o Kardex chegou
var EXP_SEM_INFO = "Aguardando Itens de NF";
function lerInfoNf(op) {
  var ni = op.nfInfo || {}, t = ni.t || [], o = {};
  Object.keys(ni.n || {}).forEach(function (id) { var x = ni.n[id]; o[id] = [t[x[0]], x[1]]; });
  return o;
}
function agregarExpedicaoDia(data, nfs, info) {
  var a = { data: data, pecas: 0, pedidos: 0, horas: new Array(24).fill(0), usuarios: {}, transp: {}, tipo: { checkout: [0, 0], colmeia: [0, 0], semInfo: [0, 0] } };
  Object.keys(nfs || {}).forEach(function (id) {
    var x = nfs[id]; if (!x) return;
    var p = x[2] || 0, inf = info[id];
    a.pecas += p; a.pedidos++;
    a.horas[Math.min(23, Math.floor(x[1] / 60))] += p;   // depois da meia-noite (T02) entra na última coluna
    var u = a.usuarios[x[0]] || (a.usuarios[x[0]] = [0, 0]); u[0] += p; u[1]++;
    var nt = inf ? (inf[0] || "Sem transportadora") : EXP_SEM_INFO, t = a.transp[nt] || (a.transp[nt] = [0, 0]); t[0] += p; t[1]++;
    var k = !inf ? "semInfo" : inf[1] === "M" ? "colmeia" : inf[1] === "S" ? "checkout" : "semInfo";
    a.tipo[k][0] += p; a.tipo[k][1]++;
  });
  return a;
}
function resumoExpedicao(op) {
  if (!op.expNfs && !op.expDias) return null;
  var info = lerInfoNf(op), porDia = {};
  (op.expDias || []).forEach(function (d) { porDia[d.data] = d; });
  Object.keys(op.expNfs || {}).forEach(function (dia) { porDia[dia] = agregarExpedicaoDia(dia, op.expNfs[dia], info); });
  var dias = Object.keys(porDia).sort().slice(-31).map(function (k) { return porDia[k]; });
  return { dias: dias, previsao: op.expPrev || null, kardexEm: op.kardexEm || null };
}
function juntarExpedicao(op, exp, agora) {
  var raw = op.expNfs || {};
  (exp.estornadas || []).forEach(function (id) { Object.keys(raw).forEach(function (d) { delete raw[d][id]; }); });
  Object.keys(exp.dias || {}).forEach(function (dia) {
    var alvo = raw[dia] || (raw[dia] = {});
    Object.keys(exp.dias[dia]).forEach(function (id) {
      Object.keys(raw).forEach(function (d) { if (d !== dia) delete raw[d][id]; });   // reprocessada em outro dia: fica só no último
      alvo[id] = exp.dias[dia][id];
    });
  });
  // Só os 2 dias mais recentes ficam crus; os outros viram resumo congelado.
  var dias = Object.keys(raw).sort(), info = lerInfoNf(op), congelados = {};
  (op.expDias || []).forEach(function (d) { congelados[d.data] = d; });
  dias.slice(0, -2).forEach(function (d) { congelados[d] = agregarExpedicaoDia(d, raw[d], info); delete raw[d]; });
  op.expDias = Object.keys(congelados).sort().slice(-31).map(function (k) { return congelados[k]; });
  op.expNfs = raw;
  // Previsão (dia + nesta hora) com o que acabou de chegar.
  var hoje = diaOperacionalIngest(agora), lista = (resumoExpedicao(op) || { dias: [] }).dias;
  var porMin = {};
  Object.keys(raw[hoje] || {}).forEach(function (id) { var x = raw[hoje][id]; if (x) porMin[x[1]] = (porMin[x[1]] || 0) + (x[2] || 0); });
  var deHoje = lista.filter(function (d) { return d.data === hoje; })[0];
  op.expPrev = previsaoDoDia(lista.map(function (d) { return { data: d.data, horas: d.horas }; }), agora, deHoje ? deHoje.pecas : 0, 1, porMin);
}
function guardarInfoNf(op, novo, opIds) {
  var emRaw = {};
  Object.keys(op.expNfs || {}).forEach(function (d) { Object.keys(op.expNfs[d]).forEach(function (id) { emRaw[id] = 1; }); });
  var velho = lerInfoNf(op), nomes = [], idx = {}, n = {};
  function poe(id, t, c) { if (!(t in idx)) { idx[t] = nomes.length; nomes.push(t); } n[id] = [idx[t], c]; }
  // OP só acrescenta (não apaga nada). O Itens de NF limpa: ficam as embarcadas nos dias crus + o que ele mesmo traz abaixo.
  Object.keys(velho).forEach(function (id) { if (opIds || emRaw[id]) poe(id, velho[id][0], velho[id][1]); });
  // EM CARGA/OR = vai embarcar; PROCESSADA recente = pode ter embarcado depois do último Kardex (ele ainda vai chegar)
  var corte = new Date(); corte.setDate(corte.getDate() - 3); corte = paraDataISOLocal(corte);
  Object.keys(novo).forEach(function (id) {
    var x = novo[id];
    if (!x[0] && n[id]) return;   // sem transportadora: não apaga a que já está guardada
    if (x[2] === "OP" || x[2].indexOf("EM CARGA") === 0 || emRaw[id] || (x[2] === "PROCESSADA" && (x[3] || "") >= corte)) poe(id, x[0], x[1]);
  });
  op.nfInfo = { t: nomes, n: n };
}

// Junta o que chegou (pedidos do OP, marcas/infos do Itens de NF, expedição do Kardex) e regrava o resumo.
async function atualizarOperacao(novo) {
  var exp = novo.expedicao, info = novo.nfInfo, linhasNf = novo.linhasItensNf;
  var op = await lerSnapshot("operacao");
  Object.keys(novo).forEach(function (k) { if (k !== "expedicao" && k !== "nfInfo" && k !== "linhasItensNf") op[k] = novo[k]; });
  if (linhasNf) {   // Itens de NF: marca pelo nome do produto, depois pela Embalas já gravada
    var rm = processarMarcasItensNf(linhasNf, op.embalas);
    // guarda as marcas dos pedidos em operação + os ainda abertos no Itens de NF (assim o próximo OP já acha a marca)
    // começa pelas marcas já conhecidas dos pedidos que seguem em operação: um pedido que saiu do
    // Itens de NF desta rodada (ex.: fora do período baixado) não perde a marca e não vira "Aguardando NF"
    var m = {}, ant = op.marcas || {};
    Object.keys(ant).forEach(function (p) { if (op.pedidos && op.pedidos[p]) m[p] = ant[p]; });
    Object.keys(rm.marcas).forEach(function (p) { if ((op.pedidos && op.pedidos[p]) || rm.abertos[p]) m[p] = rm.marcas[p]; });
    op.marcas = m;
    info = processarInfoNf(linhasNf);
  }
  if (exp) juntarExpedicao(op, exp, new Date());
  if (info) guardarInfoNf(op, info, novo.pedidos ? info : null);
  op.resumo = resumoOperacao(op);
  await salvarSnapshot("operacao", op);
  return op.resumo;
}

// =========================================================================
// 5) MONTAGEM DOS PAYLOADS (Map -> array ordenado, formato que index.html espera)
// =========================================================================
function mapParaRanking(mapa, limite) {
  var arr = Array.from(mapa.entries()).map(function (e) { return { nome: e[0], valor: e[1] }; });
  arr.sort(function (a, b) { return b.valor - a.valor; });
  return limite ? arr.slice(0, limite) : arr;
}
// Rankings por dia: Map(data -> Map(nome -> valor)) vira [{data, itens:{nome:valor}}].
// A tela soma só os dias do filtro escolhido. Um novo upload substitui os dias
// que traz e preserva os demais (assim o histórico acumula entre envios).
function somarNoDia(mapaDia, data, nome, valor) {
  if (!data) return;
  var m = mapaDia.get(data) || new Map();
  m.set(nome, (m.get(nome) || 0) + valor);
  mapaDia.set(data, m);
}
function diaMapParaArray(mapaDia) {
  var arr = [];
  mapaDia.forEach(function (m, data) {
    var itens = {};
    m.forEach(function (v, k) { itens[k] = v; });
    arr.push({ data: data, itens: itens });
  });
  arr.sort(function (a, b) { return a.data.localeCompare(b.data); });
  return arr;
}
// Peças por minuto pesam: ficam só nos 4 dias mais recentes (as horas continuam nos 31).
function podarMinutos(lista) {
  return lista.map(function (d, i) {
    if (i >= lista.length - 4 || (!d.checkoutMin && !d.colmeiaMin)) return d;
    var c = Object.assign({}, d); delete c.checkoutMin; delete c.colmeiaMin; return c;
  });
}
// Por hora (analítico): o arquivo só substitui os dias que são dele pela coluna Data. Tarefas que
// começaram num dia anterior (poucas peças) não apagam o hora a hora completo desse dia já salvo.
function mesclarHoras(anterior, novos, diasDoArquivo) {
  var salvos = new Set((anterior || []).map(function (d) { return d.data; }));
  return mesclarDias(anterior, (novos || []).filter(function (d) { return diasDoArquivo.has(d.data) || !salvos.has(d.data); }));
}
function diasDasPecas(pecas) {
  var s = new Set(); ["checkout", "colmeia"].forEach(function (t) { (pecas[t] || new Map()).forEach(function (m, dia) { s.add(dia); }); }); return s;
}
function mesclarDias(anterior, novoArray) {
  var mapa = new Map((anterior || []).map(function (d) { return [d.data, d]; }));
  (novoArray || []).forEach(function (d) { mapa.set(d.data, d); });
  return Array.from(mapa.values()).sort(function (a, b) { return a.data.localeCompare(b.data); });
}
function somaMapa(mapa) { var s = 0; mapa.forEach(function (v) { s += v; }); return s; }

// ---- Curva de planejamento (telão): previsão do dia e da próxima hora ----
// Dia operacional: entre 00h e 01h ainda é o dia anterior (o T02 vai até 00h16).
function diaOperacionalIngest(agora) {
  var d = new Date(agora); if (d.getHours() < 1) d.setDate(d.getDate() - 1);
  return paraDataISOLocal(d);
}
function somaArr(a) { return (a || []).reduce(function (s, v) { return s + (v || 0); }, 0); }
// Operação do dia: do início do T01 (05h00) ao fim do T02 (00h16); almoço do T01 e janta do T02 não contam.
var OPERACAO_FIM_MIN = 24 * 60 + 16, OPERACAO_PAUSAS = [[11 * 60 + 30, 12 * 60 + 30], [18 * 60 + 40, 19 * 60 + 40]];
// Minutos trabalhados entre dois minutos do dia (sem as pausas).
function minutosDeOperacao(de, ate) {
  var t = Math.max(0, ate - de);
  OPERACAO_PAUSAS.forEach(function (p) { t -= Math.max(0, Math.min(ate, p[1]) - Math.max(de, p[0])); });
  return Math.max(0, t);
}
// Previsão da hora em andamento ("nesta hora"): o que já saiu na hora + média por minuto × minutos
// trabalhados que faltam nela. Média por minuto = a da própria hora, a partir de 10 min trabalhados nela;
// antes disso, a dos últimos 15 min trabalhados (pega o fim da hora anterior). Pausas não contam.
// porMinuto = { minuto do dia operacional (passa de 1440 depois da meia-noite): peças }
function previsaoDaHora(porMinuto, minAgora, fator) {
  fator = fator || 1;
  var ini = Math.floor(minAgora / 60) * 60, fimH = Math.min(ini + 60, OPERACAO_FIM_MIN);
  var chaves = Object.keys(porMinuto || {});
  function soma(de, ate) { var s = 0; chaves.forEach(function (k) { var m = +k; if (m >= de && m < ate) s += porMinuto[k] || 0; }); return s; }
  var feito = soma(ini, minAgora + 1);
  var decorridos = minutosDeOperacao(ini, minAgora), faltam = minutosDeOperacao(minAgora, fimH), media;
  if (decorridos >= 10) media = feito / decorridos;
  else {
    var de = minAgora; while (de > 0 && minutosDeOperacao(de, minAgora) < 15) de--;
    media = soma(de, minAgora) / 15;
  }
  return Math.round((feito + media * faltam) * fator);
}
// Minutos do analítico (Data/Hora Fim, soma dos usuários) no dia operacional: { minuto: peças }.
// As tarefas que começaram depois da meia-noite estão no dia seguinte e entram como 1440+.
function diaSeguinteISO(iso) { var p = iso.split("-"); return paraDataISOLocal(new Date(+p[0], +p[1] - 1, +p[2] + 1)); }
function minutosDoAnaliticoIngest(analitico, dia, tipos) {
  var out = {}, seg = diaSeguinteISO(dia);
  (analitico || []).forEach(function (d) {
    var desloc = d.data === dia ? 0 : d.data === seg ? 1440 : null;
    if (desloc === null) return;
    tipos.forEach(function (t) {
      var porU = d[t + "Min"] || {};
      Object.keys(porU).forEach(function (u) { (porU[u] || []).forEach(function (mp) {
        var m = mp[0] + desloc; if (desloc && mp[0] >= 60) return;
        out[m] = (out[m] || 0) + (mp[1] || 0);
      }); });
    });
  });
  return out;
}
// Previsão do dia e da hora em andamento, pelo que já foi feito HOJE:
//   média por hora = peças das horas completas de hoje ÷ horas trabalhadas nelas (desde a 1ª hora com produção)
//   previsão do dia = realizado + média por hora × horas trabalhadas que faltam até 00h16
//   nesta hora      = previsaoDaHora (média por minuto da hora atual)
// Começo do turno (menos de 1 hora de produção hoje): usa o dia anterior no mesmo horário —
//   previsão = realizado + o que o dia anterior fez daqui até o fim.
// horasPorDia = [{data, horas:[24]}] · realizadoDia = total do dia mostrado na tela · fator = ajuste (colmeia na conferência)
// porMinuto = peças por minuto de hoje (ver previsaoDaHora)
function previsaoDoDia(horasPorDia, agora, realizadoDia, fator, porMinuto) {
  agora = agora || new Date(); fator = fator || 1;
  var dia = diaOperacionalIngest(agora);
  var lista = horasPorDia || [];
  var hojeH = (lista.filter(function (d) { return d.data === dia; })[0] || {}).horas || new Array(24).fill(0);
  var real = realizadoDia != null ? realizadoDia : somaArr(hojeH);
  // minuto atual no dia operacional (depois da meia-noite continua contando: 24h05 = 1445)
  var minAgora = agora.getHours() * 60 + agora.getMinutes() + (paraDataISOLocal(agora) === dia ? 0 : 1440);
  var r = { data: dia, realizado: real, calculadoEm: agora.getTime() };
  if (minAgora >= OPERACAO_FIM_MIN) { r.previsto = real; r.hora = null; r.nestaHora = 0; r.base = "fim"; return r; }
  var H = Math.floor(minAgora / 60);
  var primeira = hojeH.findIndex(function (v) { return v > 0; });
  var feitoCompleto = 0; for (var h = Math.max(0, primeira); h < Math.min(H, 24); h++) feitoCompleto += hojeH[h] || 0;
  var minCompletos = primeira >= 0 ? minutosDeOperacao(primeira * 60, Math.min(H, 24) * 60) : 0;
  var minRestantes = minutosDeOperacao(minAgora, OPERACAO_FIM_MIN);
  r.hora = H % 24;
  r.nestaHora = porMinuto ? previsaoDaHora(porMinuto, minAgora, fator) : null;
  if (minCompletos >= 60 && feitoCompleto > 0) {
    var porHora = feitoCompleto / (minCompletos / 60);
    r.base = "hoje";
    r.previsto = Math.round(real + porHora * minRestantes / 60 * fator);
    return r;
  }
  // começo do turno: o dia anterior com produção, no mesmo horário
  var ant = lista.filter(function (d) { return d.data < dia && somaArr(d.horas) > 0; }).pop();
  if (!ant) return r;   // sem base: a tela mostra "—"
  var fracH = (minAgora % 60) / 60, daquiAteFim = 0, antAteAgora = 0;
  for (var k = 0; k < 24; k++) {
    if (k < H) antAteAgora += ant.horas[k] || 0;
    else daquiAteFim += (ant.horas[k] || 0) * (k === H ? 1 - fracH : 1);
  }
  if (antAteAgora > 0) antAteAgora += (ant.horas[H] || 0) * fracH;
  // Nenhuma peça hoje e o dia anterior já produzia até este horário: dia sem operação, previsão 0.
  if (real === 0 && antAteAgora > 0) { r.base = "sem produção hoje"; r.previsto = 0; r.nestaHora = 0; return r; }
  r.base = "dia anterior (" + ant.data + ")";
  r.previsto = Math.round(real + daquiAteFim * fator);
  return r;
}
// Horas do analítico (soma de todos os usuários) por dia: [{data, horas:[24]}]
function horasDoAnaliticoIngest(analitico, tipos) {
  return (analitico || []).map(function (d) {
    var h = new Array(24).fill(0);
    tipos.forEach(function (t) { Object.keys(d[t] || {}).forEach(function (u) { (d[t][u] || []).forEach(function (v, i) { h[i] += v || 0; }); }); });
    return { data: d.data, horas: h };
  });
}
function totalDoDia(series, dia) {
  var s = 0;
  series.forEach(function (sr) { (sr || []).forEach(function (d) { if (String(d.data).slice(0, 10) === dia) Object.keys(d.itens || {}).forEach(function (n) { s += d.itens[n] || 0; }); }); });
  return s;
}
// Separação (checkout + colmeia, com hora) e Conferência (curva do checkout; a colmeia segue o mesmo ritmo, na proporção de hoje).
function atualizarPrevisoesOutbound(snap) {
  var agora = new Date(), dia = diaOperacionalIngest(agora), sep = snap.separacao, conf = snap.conferencia;
  if (sep && sep.analitico) sep.previsao = previsaoDoDia(horasDoAnaliticoIngest(sep.analitico, ["checkout", "colmeia"]), agora,
    totalDoDia([sep.checkoutDia, sep.colmeiaDia], dia), 1, minutosDoAnaliticoIngest(sep.analitico, dia, ["checkout", "colmeia"]));
  if (conf && conf.analitico) {
    var hc = horasDoAnaliticoIngest(conf.analitico, ["checkout"]);
    var chk = totalDoDia([conf.confCheckoutDia], dia), tot = totalDoDia([conf.confCheckoutDia, conf.confColmeiaUnitDia], dia);
    conf.previsao = previsaoDoDia(hc, agora, tot, chk > 0 ? tot / chk : 1, minutosDoAnaliticoIngest(conf.analitico, dia, ["checkout"]));
  }
}
function mapParaSerieDia(mapa, campoValor) {
  var arr = Array.from(mapa.entries()).map(function (e) { var o = { data: e[0] }; o[campoValor] = e[1]; return o; });
  arr.sort(function (a, b) { return a.data.localeCompare(b.data); });
  return arr;
}

// =========================================================================
// 6) INTERFACE DE ABASTECIMENTO — só chamada quando perfilAtual === 'admin'
// =========================================================================
function caixaUpload(id, titulo, descricao, aceitaMultiplos, desabilitado) {
  var dis = desabilitado ? " disabled" : "";
  var avisoDesabilitado = desabilitado ? ' <em>(fora do ciclo de contagens — ative o interruptor acima para abastecer)</em>' : "";
  return '<div class="panel' + (desabilitado ? " panel-disabled" : "") + '" id="' + id + '-card"><div class="panel-head"><div><p class="kicker">Upload</p><h4>' + titulo + ' <span class="badge-feito" id="' + id + '-badge" hidden>✓ Feito</span></h4></div></div>' +
    '<div class="upload-box">' + (desabilitado ? '<p>' + avisoDesabilitado + '</p>' : '') +
    '<input type="file" id="' + id + '" ' + (aceitaMultiplos ? "multiple" : "") + dis + ' accept=".tsv,.txt,.xlsx,.xlsb,.xls">' +
    '<button class="btn"' + dis + ' onclick="window.ProdutividadeIngest.processar(\'' + id + '\')">Enviar</button>' +
    '<div class="upload-status" id="' + id + '-status"></div></div></div>';
}

// Guarda no navegador (localStorage) a última vez que cada card foi
// abastecido com sucesso, com data e hora — assim a confirmação continua
// visível mesmo depois de sair da tela/recarregar a página, até o próximo
// envio daquele mesmo relatório. É só um registro de conveniência local
// (não precisa ir pro banco, é por pessoa/navegador).
function definirStatus(id, texto, classe) {
  var el = document.getElementById(id + "-status");
  var badge = document.getElementById(id + "-badge");
  if (classe === "ok") {
    var agora = new Date();
    var quando = agora.toLocaleDateString("pt-BR") + " às " + agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    var textoFinal = texto + " · " + quando;
    try { localStorage.setItem("abastecimento_" + id, textoFinal); } catch (e) {}
    if (el) { el.textContent = textoFinal; el.className = "upload-status ok"; }
    registrarAbastecimento(id, texto);   // grava no banco: vale em qualquer navegador
  } else {
    if (el) { el.textContent = texto; el.className = "upload-status" + (classe ? " " + classe : ""); }
  }
  if (badge) badge.hidden = (classe !== "ok");
}

// Chamado depois de renderizar a tela de Abastecimento: relê o localStorage
// e repõe a última confirmação de cada card, já que o innerHTML foi recriado
// do zero (sem isso, a mensagem "some" ao sair e voltar pra tela).
// ---- Registro de abastecimentos no banco (tabela abastecimentos) ----
// Último dia com dado de cada upload, lido do snapshot recém-gravado.
var ULTIMO_DIA_FONTES = {
  "up-kardex-geral": [["inbound", ["armazenagem", "normalDia"]], ["inbound", ["armazenagem", "reversaDia"]], ["estoque", ["pula", "rankingDia"]]],
  "up-gerenciador-or-geral": [["inbound", ["recebimento", "resumoDia"]], ["reversa", ["vinculacao", "resumoDia"]]],
  "up-controle-nf-geral": [["estoque", ["cancelamentos", "porDia"]], ["reversa", ["integracao", "serieDia"]]],
  "up-separacao-analitica": [["outbound", ["separacao", "checkoutDia"]], ["outbound", ["separacao", "colmeiaDia"]]],
  "up-conferencia-analitica": [["outbound", ["conferencia", "confCheckoutDia"]]],
  "up-conf-colmeia": [["outbound", ["conferencia", "confColmeiaUnitDia"]]],
  "up-corte-tela": [["estoque", ["corte", "serieTela"]]],
  "up-corte-resolvido": [["estoque", ["corte", "resolvidoDia"]]],
};
async function ultimoDiaDosDados(id) {
  var fontes = ULTIMO_DIA_FONTES[id];
  if (!fontes) return null;
  var cache = {}, maior = null;
  for (var i = 0; i < fontes.length; i++) {
    var pag = fontes[i][0];
    if (!cache[pag]) cache[pag] = await lerSnapshot(pag);
    var no = cache[pag];
    fontes[i][1].forEach(function (k) { no = no && no[k]; });
    if (!Array.isArray(no)) continue;
    no.forEach(function (x) {
      var d = x && (x.data || x.dia);
      if (d && /^\d{4}-\d{2}-\d{2}/.test(String(d))) { d = String(d).slice(0, 10); if (!maior || d > maior) maior = d; }
    });
  }
  return maior;
}
async function registrarAbastecimento(id, resumo) {
  try {
    var ultimo = await ultimoDiaDosDados(id);
    var { data: sessao } = await supabaseClient.auth.getSession();
    var usuario = sessao && sessao.session ? sessao.session.user.email : null;
    var linha = { id: id, enviado_em: new Date().toISOString(), usuario: usuario, resumo: String(resumo || "").replace(/^✓\s*/, ""), ultimo_dia: ultimo };
    var { error } = await supabaseClient.from("abastecimentos").upsert(linha, { onConflict: "id" });
    if (error) throw error;
    mostrarAbastecimento(linha);
  } catch (e) { console.error("Não foi possível registrar o abastecimento", e); }
}
function mostrarAbastecimento(l) {
  var el = document.getElementById(l.id + "-status");
  if (!el) return;
  var q = new Date(l.enviado_em);
  var quando = q.toLocaleDateString("pt-BR") + " às " + q.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  var html = "✓ " + htmlSeguro(l.resumo || "Enviado") + " · enviado em " + quando;
  if (l.usuario) html += " por " + htmlSeguro(l.usuario);
  if (l.ultimo_dia) {
    html += " · dados até <strong>" + fmtDataBRIngest(l.ultimo_dia) + "</strong>";
    var p = String(l.ultimo_dia).slice(0, 10).split("-"), hoje = new Date();
    var atraso = Math.floor((new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()) - new Date(+p[0], +p[1] - 1, +p[2])) / 86400000);
    if (atraso > 3) html += ' <span class="comp-aviso" style="border:none;padding:0;margin:0">⚠ ' + atraso + " dias sem dados novos</span>";
  }
  el.innerHTML = html; el.className = "upload-status ok";
  var badge = document.getElementById(l.id + "-badge"); if (badge) badge.hidden = false;
}
async function carregarAbastecimentos() {
  try {
    var { data, error } = await supabaseClient.from("abastecimentos").select("*");
    if (error) throw error;
    (data || []).forEach(mostrarAbastecimento);
  } catch (e) { console.error("Não foi possível ler os abastecimentos", e); }
}

function restaurarStatusAbastecimento() {
  carregarAbastecimentos();
  document.querySelectorAll('[id$="-status"]').forEach(function (el) {
    var id = el.id.replace(/-status$/, "");
    var salvo;
    try { salvo = localStorage.getItem("abastecimento_" + id); } catch (e) { salvo = null; }
    if (!salvo) return;
    el.textContent = salvo; el.className = "upload-status ok";
    var badge = document.getElementById(id + "-badge");
    if (badge) badge.hidden = false;
  });
}

function renderAdmin() {
  renderAbastecimento();
  renderAtivos();
}

// Interruptor "estamos em ciclo de contagens?" — fica guardado no Supabase
// (tabela config_geral, linha única), não no navegador: vira regra pra todo
// mundo até alguém trocar de novo aqui, sem precisar marcar toda vez.
function cartaoCicloInventario(ativo) {
  return '<div class="panel">' +
    '<div class="panel-head"><div><p class="kicker">Config geral</p><h4>Ciclo de contagens de Inventário</h4></div></div>' +
    '<div class="upload-box" style="align-items:center">' +
    '<label class="switch"><input type="checkbox" id="toggle-ciclo-inventario" ' + (ativo ? "checked" : "") + ' onchange="window.ProdutividadeIngest.alternarCicloInventario(this.checked)">' +
    '<span class="switch-track"><span class="switch-thumb"></span></span>' +
    '<span class="switch-label">' + (ativo ? "Em ciclo" : "Sem ciclo") + '</span></label>' +
    '</div></div>';
}

async function alternarCicloInventario(ativo) {
  var { error } = await supabaseClient.from("config_geral")
    .upsert({ chave: "geral", ciclo_inventario_ativo: ativo, atualizado_em: new Date().toISOString() });
  var label = document.querySelector("#toggle-ciclo-inventario ~ .switch-label");
  if (error) { if (label) label.textContent = "Erro ao salvar"; console.error("Erro ao salvar config_geral", error); return; }
  if (label) label.textContent = ativo ? "Em ciclo" : "Sem ciclo";
  if (window.recarregarSnapshots) window.recarregarSnapshots();
}

// Meta Dia do Inventário = Headcount × Produtividade/pessoa do setor (regra do
// Dashboard de Inventário). Setor e HC ficam guardados como padrão até alguém
// trocar aqui; cada dia enviado carimba a meta vigente naquele momento.
function cartaoMetaInventario(cfg) {
  cfg = cfg || {};
  var setor = cfg.setor === "Vestuário" ? "Vestuário" : "Calçados";
  var meta = metaDiaDeConfig({ setor: setor, headcount: cfg.headcount, prodCalcados: cfg.prodCalcados, prodVestuario: cfg.prodVestuario });
  return '<div class="panel"><div class="panel-head"><div><p class="kicker">Config geral</p><h4>Meta Dia do Inventário</h4></div></div>' +
    '<div class="upload-box" style="align-items:flex-end">' +
    '<div class="date-campo"><span>Setor em contagem</span><select class="date-box" id="meta-setor"><option' + (setor === "Calçados" ? " selected" : "") + '>Calçados</option><option' + (setor === "Vestuário" ? " selected" : "") + '>Vestuário</option></select>' +
    '<span>Headcount</span><input type="number" class="date-box" id="meta-hc" style="width:80px" min="0" value="' + (cfg.headcount != null ? cfg.headcount : "") + '">' +
    '<span>Prod./pessoa Calçados</span><input type="number" class="date-box" id="meta-prod-calc" style="width:90px" min="0" value="' + (cfg.prodCalcados || 4500) + '">' +
    '<span>Prod./pessoa Vestuário</span><input type="number" class="date-box" id="meta-prod-vest" style="width:90px" min="0" value="' + (cfg.prodVestuario || 1500) + '"></div>' +
    '<button class="btn" onclick="window.ProdutividadeIngest.salvarMetaInventario()">Salvar</button>' +
    '<div class="upload-status" id="meta-inv-status">Meta Dia atual: ' + (meta ? meta.toLocaleString("pt-BR") + " itens/dia" : "— (informe o headcount)") + '.</div>' +
    '</div></div>';
}

async function salvarMetaInventario() {
  var st = document.getElementById("meta-inv-status");
  try {
    var cfg = {
      setor: document.getElementById("meta-setor").value,
      headcount: numero(document.getElementById("meta-hc").value),
      prodCalcados: numero(document.getElementById("meta-prod-calc").value) || 4500,
      prodVestuario: numero(document.getElementById("meta-prod-vest").value) || 1500,
    };
    var atual = await lerSnapshot("estoque");
    atual.inventario = atual.inventario || {};
    atual.inventario.metaConfig = cfg;
    var meta = metaDiaDeConfig(cfg);
    atual.inventario.metaPorDia = atual.inventario.metaPorDia || {};
    Object.keys(atual.inventario.arquivos || {}).forEach(function (n) {
      var d = atual.inventario.arquivos[n].data;
      if (!atual.inventario.metaPorDia[d] && meta) atual.inventario.metaPorDia[d] = meta;
    });
    recalcularInventario(atual.inventario);
    await salvarSnapshot("estoque", atual);
    if (st) { st.textContent = "✓ Salvo — Meta Dia " + meta.toLocaleString("pt-BR") + " itens/dia (" + cfg.setor + ", " + cfg.headcount + " pessoas)."; st.className = "upload-status ok"; }
    if (window.recarregarSnapshots) window.recarregarSnapshots(true);
  } catch (e) {
    if (st) { st.textContent = "Erro: " + e.message; st.className = "upload-status erro"; }
  }
}

// =========================================================================
// COMPETIÇÃO — gestão dos times (tabela competicao_times)
// Cada linha = um colaborador numa atividade e turno, com piso, time, observação (Colmeia) e líder.
// =========================================================================
var COMP_TURNOS = ["1º Turno", "2º Turno", "3º Turno", "ADM"];
var COMP_ATIVS = [["sep", "Separação"], ["conf", "Conferência"], ["emb", "Embalagem"], ["exp", "Embarque"], ["org", "Organização"]];
var COMP_TIMES = { 1: ["Vermelho", "--t1"], 2: ["Azul", "--t2"], 3: ["Verde", "--t3"], 4: ["Amarelo", "--t4"], 5: ["Rosa", "--t5"], 6: ["Roxo", "--t6"], 7: ["Laranja", "--t7"], 8: ["Branco", "--t8"] };
var COMP_NUM_TIMES = [1, 2, 3, 4, 7, 8, 5, 6];   // ordem das abas e listas: checkout, vestuário, colmeia
// Grupo (corrida) de cada time, para os rótulos: times 5–6 colmeia, 7–8 vestuário.
function grupoTimeRot(n) { return n === 5 || n === 6 ? "colmeia" : n === 7 || n === 8 ? "vestuário" : ""; }
// Black Friday: presença de cada pessoa por dia, na mesma planilha dos times (uma coluna por dia).
// P = presente · F = falta (atestado também conta como falta) · A = atraso.
var COMP_DIAS_BLACK = [["2026-11-27", "27/11"], ["2026-11-28", "28/11"], ["2026-11-29", "29/11"]];
var COMP_CAB_ABA = ["Nome", "Usuário WMS", "Atividade", "Turno", "Piso", "Observação", "Líder"].concat(COMP_DIAS_BLACK.map(function (d) { return d[1]; }))
  .concat(COMP_DIAS_BLACK.map(function (d) { return "Troca " + d[1]; }));
// Troca de posto no dia (2ª caixa): "10:00", "10h", "10h30" ou com o time de destino ("10:00 Verde").
// Grava "HH:MM" ou "HH:MM>N" em presenca.troca[dia] (a conta está em RegrasBlack.fatorConfDoDia). null = vazio ou inválido.
function trocaDeTexto(t) {
  var n = normalizarTexto(t);
  if (!n) return null;
  var m = /^(\d{1,2})(?:\s*[:H]\s*(\d{2})(?::\d{2})?)?\s*H?\s*(?:>|-|PARA|P\/)?\s*(.*)$/.exec(n);   // aceita 10:00:00 (célula de hora do Excel)
  if (!m || +m[1] > 23) return null;
  var hora = ("0" + m[1]).slice(-2) + ":" + (m[2] || "00"), resto = m[3].replace(/^TIME\s*0?/, "").trim(), destino = null;
  if (resto) {
    if (/^[1-8]$/.test(resto)) destino = +resto;
    else for (var k = 1; k <= 8; k++) if (normalizarTexto(COMP_TIMES[k][0]) === resto) destino = k;
    if (!destino) return null;
  }
  return hora + (destino ? ">" + destino : "");
}
function textoDaTroca(v) { var m = /^(\d{2}:\d{2})(?:>(\d))?$/.exec(String(v || "")); return m ? m[1] + (m[2] ? " " + COMP_TIMES[+m[2]][0] : "") : ""; }
function presencaDeTexto(t) {
  var n = normalizarTexto(t);
  if (!n) return null;
  if (/^(P|PRESENTE|OK|X)$/.test(n)) return "P";
  if (/^(A|ATRASO|ATRASADO)$/.test(n)) return "A";
  if (/^(F|FALTA|FALTOU|AUSENTE|ATESTADO|AT|J|JUSTIFICADA)$/.test(n)) return "F";
  return null;
}
// Nome da aba = cor do time (Vermelho, Azul... Laranja, Branco). Devolve 1–8 ou null.
function timeDaAba(nome) {
  var n = normalizarTexto(nome);
  for (var k = 1; k <= 8; k++) if (normalizarTexto(COMP_TIMES[k][0]) === n) return k;
  return null;
}
function linhaAbaTime(l) {
  var obs = l.observacao || (/colmeia$/.test(l.atividade) ? "Colmeia" : "");
  return [l.nome || "", l.usuario_wms, l.sigla || siglaAtividade(l.atividade), l.turno, l.piso || "", obs, l.lider ? "S" : "N"]
    .concat(COMP_DIAS_BLACK.map(function (d) { return (l.presenca || {})[d[0]] || ""; }))
    .concat(COMP_DIAS_BLACK.map(function (d) { return textoDaTroca(((l.presenca || {}).troca || {})[d[0]]); }));
}
// Uma aba por cor (todas as cores, mesmo vazias) + aba Legenda, que o envio ignora.
function planilhaPorCores(linhasPorTime) {
  var wb = XLSX.utils.book_new();
  COMP_NUM_TIMES.forEach(function (n) {
    var ws = XLSX.utils.aoa_to_sheet([COMP_CAB_ABA].concat(juntarAtividades(linhasPorTime[n] || []).map(linhaAbaTime)));
    ws["!cols"] = [{ wch: 28 }, { wch: 22 }, { wch: 9 }, { wch: 10 }, { wch: 6 }, { wch: 12 }, { wch: 6 }, { wch: 7 }, { wch: 7 }, { wch: 7 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, COMP_TIMES[n][0]);
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ["Como preencher"],
    ["Cada aba é um time: o nome da aba é a cor do time (não renomeie)."],
    ["Atividade: S = Separação · C = Conferência · C/S = faz as duas (uma linha só por pessoa). Também aceita Embalagem, Embarque e Organização (no time do piso)."],
    ["Vaga sem pessoa: Nome REFORÇO e Usuário WMS vazio (o envio grava a vaga no time; troque pelo nome quando definir)."],
    ["Turno: " + COMP_TURNOS.join(", ")],
    ["Piso: 1 a 4 (vazio na colmeia e no vestuário) · Observação: vazio ou Colmeia · Líder: S ou N"],
    ["Times: Vermelho, Azul, Verde e Amarelo = checkout (um por andar) · Laranja e Branco = vestuário · Rosa e Roxo = colmeia"],
    ["Presença (27/11, 28/11, 29/11): P = presente · F = falta (atestado conta como falta) · A = atraso · vazio = ainda não lançado"],
    ["Troca 27/11, 28/11, 29/11: horário em que a pessoa trocou de posto (ex.: 10:00) e, se quiser, o time de destino (ex.: 10:00 Verde). A partir do horário, a conferência vale pela caixa de destino: com 2ª caixa = 0,5; sem = inteira. Só o horário = inverte."],
  ]), "Legenda");
  return wb;
}
var compAdm = { turno: "1º Turno", time: 1, editando: null, linhas: [], indice: null };

function htmlSeguro(t) {
  return String(t == null ? "" : t).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
}
function rotuloAtividade(a) {
  var base = String(a || "").replace(/_.*/, "");
  var r = COMP_ATIVS.filter(function (x) { return x[0] === base; })[0];
  return r ? r[1] : a;
}
// Sigla da planilha de times: S = Separação, C = Conferência (as outras atividades vão por extenso).
function siglaAtividade(a) {
  var base = String(a || "").replace(/_.*/, "");
  return base === "sep" ? "S" : base === "conf" ? "C" : rotuloAtividade(a);
}
// Mesma pessoa, turno e time com Separação e Conferência = uma linha "C/S" na planilha.
function juntarAtividades(linhas) {
  var porChave = new Map(), saida = [];
  linhas.forEach(function (l) {
    var k = l.usuario_wms + "|" + l.turno + "|" + l.time, s = siglaAtividade(l.atividade);
    var j = porChave.get(k);
    if (j && (s === "C" || s === "S") && (j.sigla === "C" || j.sigla === "S") && j.sigla !== s) { j.sigla = "C/S"; return; }
    if (j && j.sigla === s) return;
    var nova = Object.assign({}, l, { sigla: s });
    if (s === "C" || s === "S") porChave.set(k, nova);
    saida.push(nova);
  });
  return saida;
}
// Atividades de uma célula: "S", "C", "C/S" (ou S/C, CS, Ambas) e os nomes por extenso.
function atividadesDeTexto(t) {
  var n = normalizarTexto(t).replace(/\s+/g, "");
  if (/^(C\/S|S\/C|CS|SC|C\+S|S\+C|CES|SEC|AMBAS|AMBOS|AS2|ASDUAS)$/.test(n) || (n.indexOf("SEPARA") !== -1 && n.indexOf("CONFER") !== -1)) return ["sep", "conf"];
  if (n === "S") return ["sep"];
  if (n === "C") return ["conf"];
  var a = atividadeDeTexto(t);
  return a ? [a] : [];
}
// Atividade genérica da planilha. "Conferência Colmeia" (formato antigo) vira Conferência + Observação Colmeia.
function atividadeDeTexto(t) {
  var n = normalizarTexto(t);
  if (n.indexOf("SEPARA") !== -1) return "sep";
  if (n.indexOf("CONFER") !== -1 || n.indexOf("FATURAMENTO") !== -1) return "conf";
  if (n.indexOf("EMBALA") !== -1) return "emb";
  if (n.indexOf("EMBARQ") !== -1 || n.indexOf("EXPEDI") !== -1) return "exp";
  if (n.indexOf("ORGANIZ") !== -1 || /(^|\W)5S(\W|$)/.test(n)) return "org";   // Organização (5S): no time do piso, sem peças
  return null;
}
function turnoDeTexto(t) {
  var n = normalizarTexto(t);
  if (n === "ADM") return "ADM";
  var m = /^([123])/.exec(n);
  return m ? COMP_TURNOS[Number(m[1]) - 1] : null;
}
function inteiroDe(t, min, max) {
  var m = /\d+/.exec(String(t == null ? "" : t));
  var n = m ? Number(m[0]) : NaN;
  return n >= min && n <= max ? n : null;
}
function opcoes(lista, atual) {
  return lista.map(function (o) {
    var v = Array.isArray(o) ? o[0] : o, r = Array.isArray(o) ? o[1] : o;
    return '<option value="' + htmlSeguro(v) + '"' + (String(v) === String(atual == null ? "" : atual) ? " selected" : "") + ">" + htmlSeguro(r) + "</option>";
  }).join("");
}
var OPC_PISO = [["", "Sem piso"], [1, "Piso 1"], [2, "Piso 2"], [3, "Piso 3"], [4, "Piso 4"]];
var OPC_OBS = [["", "Sem observação"], ["Colmeia", "Colmeia"]];
var OPC_LIDER = [["false", "Membro"], ["true", "Líder"]];

// Tabela com todas as classificações aceitas na planilha (sem texto explicativo).
function tabelaClassificacoesCompeticao() {
  var col = function (itens) { return itens.map(htmlSeguro).join("<br>"); };
  return '<div class="tbl-wrap"><table class="comp-classif"><thead><tr><th>Atividade</th><th>Turno</th><th>Piso</th><th>Time</th><th>Observação</th><th>Líder</th></tr></thead><tbody><tr>' +
    "<td>" + col(["S (Separação)", "C (Conferência)", "C/S (as duas)"]) + "</td><td>" + col(COMP_TURNOS) + "</td><td>" + col(["1", "2", "3", "4"]) + "</td>" +
    "<td>" + col(COMP_NUM_TIMES.map(function (n) { return "0" + n + " · " + COMP_TIMES[n][0]; })) + "</td><td>" + col(["Colmeia"]) + "</td><td>" + col(["S", "N"]) + "</td></tr></tbody></table></div>";
}

async function renderCompeticaoAdmin(recarregarBase) {
  var el = document.getElementById("bloco-competicao-admin");
  if (!el) return;
  var r = await supabaseClient.from("competicao_times").select("*");
  compAdm.linhas = r.data || [];
  if (recarregarBase || !compAdm.indice) compAdm.indice = (await carregarIndiceBaseAtivos()).indice;
  var idx = compAdm.indice;
  var doTurno = compAdm.linhas.filter(function (l) { return l.turno === compAdm.turno; });
  var foraDaBase = function (l) { return !idx.get(normalizarUsuarioWMS(l.usuario_wms)); };

  var linhasTimes = COMP_NUM_TIMES.map(function (n) {
    var m = doTurno.filter(function (l) { return l.time === n; });
    var lideres = m.filter(function (l) { return l.lider; }).map(function (l) { return l.nome || l.usuario_wms; });
    var cont = {}; m.filter(function (l) { return !l.lider; }).forEach(function (l) { var a = rotuloAtividade(l.atividade); cont[a] = (cont[a] || 0) + 1; });
    var ativ = Object.keys(cont).map(function (a) { return a + " " + cont[a]; }).join(" · ");
    var pend = m.filter(foraDaBase).length;
    return '<tr data-time="' + n + '"' + (n === compAdm.time ? ' class="sel"' : "") + ' tabindex="0"><td><span class="comp-nome" style="--c:var(' + COMP_TIMES[n][1] + ')"><span class="comp-dot"></span>Time ' + COMP_TIMES[n][0] + "</span></td>" +
      '<td><span class="comp-lider-adm" style="--c:var(' + COMP_TIMES[n][1] + ')">' + (lideres.length ? htmlSeguro(lideres.join(", ")) : "—") + "</span></td>" +
      "<td>" + (ativ ? htmlSeguro(ativ) : "—") + '</td><td class="num">' + m.length + "</td>" +
      "<td>" + (pend ? '<span class="comp-aviso">' + pend + " fora da base</span>" : '<span class="comp-ok">OK</span>') + "</td></tr>";
  }).join("");

  var membros = doTurno.filter(function (l) { return l.time === compAdm.time; }).sort(function (a, b) {
    return (b.lider ? 1 : 0) - (a.lider ? 1 : 0) || rotuloAtividade(a.atividade).localeCompare(rotuloAtividade(b.atividade)) || a.usuario_wms.localeCompare(b.usuario_wms);
  });
  var htmlMembros = membros.map(function (l) {
    var b = idx.get(normalizarUsuarioWMS(l.usuario_wms));
    var sub = htmlSeguro(l.usuario_wms) + " · " + htmlSeguro(rotuloAtividade(l.atividade)) + (l.observacao ? " · " + htmlSeguro(l.observacao) : "") + (l.piso ? " · Piso " + l.piso : "") + " · " + (b ? htmlSeguro(b.turno || "sem turno") : '<span class="comp-aviso">não está na Base de Ativos</span>');
    var edicao = compAdm.editando === l.id
      ? '<div class="comp-edit"><input data-campo="nome" value="' + htmlSeguro(l.nome || "") + '" aria-label="Nome completo" title="Nome completo: a Competição acha o usuário do WMS pelo primeiro e último nome">' +
        '<select data-campo="atividade">' + opcoes(COMP_ATIVS, String(l.atividade).replace(/_.*/, "")) + '</select><select data-campo="turno">' + opcoes(COMP_TURNOS, l.turno) + '</select>' +
        '<select data-campo="time">' + opcoes(COMP_NUM_TIMES.map(function (n) { return [n, "Time " + COMP_TIMES[n][0]]; }), l.time) + '</select><select data-campo="piso">' + opcoes(OPC_PISO, l.piso) + "</select>" +
        '<select data-campo="observacao">' + opcoes(OPC_OBS, l.observacao || "") + '</select><select data-campo="lider">' + opcoes(OPC_LIDER, String(!!l.lider)) + "</select>" +
        '<button class="btn" data-acao="salvar" data-id="' + l.id + '">Salvar</button><button class="btn ghost" data-acao="cancelar">Cancelar</button></div>'
      : "";
    var nome = l.lider ? '<b class="comp-lider-adm" style="--c:var(' + COMP_TIMES[l.time][1] + ')">' + htmlSeguro(l.nome || l.usuario_wms) + " · Líder</b>" : htmlSeguro(l.nome || l.usuario_wms);
    return '<div class="comp-membro"><span>' + nome + "<small>" + sub + '</small></span><button class="btn ghost" data-acao="editar" data-id="' + l.id + '">Editar</button><button class="btn ghost" style="color:var(--red)" data-acao="remover" data-id="' + l.id + '">Remover</button>' + edicao + "</div>";
  }).join("") || '<p class="fonte">Nenhum membro neste time ainda.</p>';

  // Troca de posto no dia (2ª caixa): grava presenca.troca[dia] = "HH:MM" ou "HH:MM>N" em todas as linhas da pessoa no turno.
  var pessoasTroca = [], vistosT = {};
  doTurno.forEach(function (l) { if (vistosT[l.usuario_wms] || /^REFORCO/.test(l.usuario_wms)) return; vistosT[l.usuario_wms] = 1; pessoasTroca.push(l); });
  pessoasTroca.sort(function (a, b) { return COMP_NUM_TIMES.indexOf(a.time) - COMP_NUM_TIMES.indexOf(b.time) || String(a.nome || a.usuario_wms).localeCompare(String(b.nome || b.usuario_wms)); });
  var hojeT = new Date(), hojeIsoT = hojeT.getFullYear() + "-" + ("0" + (hojeT.getMonth() + 1)).slice(-2) + "-" + ("0" + hojeT.getDate()).slice(-2);
  var diaTroca = COMP_DIAS_BLACK.some(function (d) { return d[0] === hojeIsoT; }) ? hojeIsoT : COMP_DIAS_BLACK[0][0];
  var htmlTrocas = [];
  pessoasTroca.forEach(function (l) {
    var tr = (l.presenca || {}).troca || {};
    Object.keys(tr).sort().forEach(function (d) {
      var mt = /^(\d{2}:\d{2})(?:>(\d))?$/.exec(tr[d]) || [];
      htmlTrocas.push('<div class="comp-membro"><span>' + fmtDataBRIngest(d).slice(0, 5) + " · " + (mt[1] || htmlSeguro(tr[d])) + " · " + htmlSeguro(l.nome || l.usuario_wms) +
        "<small>" + COMP_TIMES[l.time][0] + " → " + (mt[2] ? COMP_TIMES[+mt[2]][0] : "inverte") + '</small></span><button class="btn ghost" style="color:var(--red)" data-troca-rem="' + htmlSeguro(l.usuario_wms) + "|" + d + '">Remover</button></div>');
    });
  });

  el.innerHTML =
    '<div class="comp-adm"><div class="comp-adm-grid">' +
      '<div class="panel" style="display:flex; flex-direction:column; gap:12px">' +
        '<div class="panel-head"><div><p class="kicker">Times por turno</p><h4>Times</h4></div></div>' +
        '<div class="comp-add"><select id="comp-sel-turno" aria-label="Turno">' + opcoes(COMP_TURNOS, compAdm.turno) + "</select></div>" +
        '<div class="tbl-wrap"><table><thead><tr><th>Time</th><th>Líder</th><th>Atividades</th><th class="num">Membros</th><th>Base de Ativos</th></tr></thead><tbody id="comp-tb-times">' + linhasTimes + "</tbody></table></div>" +
      "</div>" +
      '<div class="panel" style="display:flex; flex-direction:column; gap:10px">' +
        '<div class="panel-head"><div><p class="kicker">' + htmlSeguro(compAdm.turno) + '</p><h4>Time ' + COMP_TIMES[compAdm.time][0] + "</h4></div></div>" +
        '<div class="comp-add"><input id="comp-novo-usuario" placeholder="Usuário WMS (ex.: NOME.SOBRENOME)" aria-label="Usuário WMS">' +
          '<select id="comp-novo-atv" aria-label="Atividade">' + opcoes([["sep+conf", "C/S (as duas)"]].concat(COMP_ATIVS), "sep") + '</select><select id="comp-novo-piso" aria-label="Piso">' + opcoes(OPC_PISO, "") + "</select>" +
          '<select id="comp-novo-obs" aria-label="Observação">' + opcoes(OPC_OBS, "") + '</select><select id="comp-novo-lider" aria-label="Líder">' + opcoes(OPC_LIDER, "false") + "</select>" +
          '<button class="btn" id="comp-btn-add">Adicionar</button></div>' +
        '<div class="upload-status" id="comp-membro-status"></div>' + '<div class="comp-lista-membros">' + htmlMembros + "</div>" +
      "</div>" +
    "</div>" +
    '<div class="panel" style="margin-top:14px; display:flex; flex-direction:column; gap:10px">' +
      '<div class="panel-head"><div><p class="kicker">' + htmlSeguro(compAdm.turno) + '</p><h4>Troca de posto</h4></div></div>' +
      '<div class="comp-add"><select id="comp-troca-dia" aria-label="Dia">' + opcoes(COMP_DIAS_BLACK, diaTroca) + "</select>" +
        '<select id="comp-troca-pessoa" aria-label="Pessoa">' + opcoes(pessoasTroca.map(function (l) { return [l.usuario_wms, (l.nome || l.usuario_wms) + " · " + COMP_TIMES[l.time][0]]; }), "") + "</select>" +
        '<input type="time" id="comp-troca-hora" value="10:00" aria-label="Horário da troca">' +
        '<select id="comp-troca-destino" aria-label="Para">' + opcoes([["", "Inverter"]].concat(COMP_NUM_TIMES.map(function (n) { return [n, "Para " + COMP_TIMES[n][0]]; })), "") + "</select>" +
        '<button class="btn" id="comp-btn-troca">Lançar</button></div>' +
      '<div class="upload-status" id="comp-troca-status"></div><div class="comp-lista-membros">' + htmlTrocas.join("") + "</div>" +
    "</div>" +
    '<div class="panel" style="margin-top:14px; display:flex; flex-direction:column; gap:10px">' +
      '<div class="panel-head"><div><p class="kicker">Upload</p><h4>Planilha de escalação dos times <span class="badge-feito" id="comp-planilha-badge" hidden>✓ Feito</span></h4></div></div>' +
      '<div class="upload-box">' +
      '<input type="file" id="comp-planilha" accept=".xlsx,.xls,.xlsb,.tsv,.txt"><button class="btn" id="comp-btn-planilha">Enviar planilha</button><button class="btn ghost" id="comp-btn-modelo">Baixar modelo</button><button class="btn ghost" id="comp-btn-exportar">Exportar times atuais</button>' +
      '<div class="upload-status" id="comp-planilha-status"></div></div>' +
      tabelaClassificacoesCompeticao() + "</div></div>";

  var avisoMembro = function (t, classe) { var a = document.getElementById("comp-membro-status"); if (a) { a.textContent = t; a.className = "upload-status" + (classe ? " " + classe : ""); } };
  var recarregar = async function () { await renderCompeticaoAdmin(false); if (window.recarregarCompeticao) window.recarregarCompeticao(); };

  document.getElementById("comp-sel-turno").addEventListener("change", function () { compAdm.turno = this.value; compAdm.editando = null; renderCompeticaoAdmin(false); });

  var avisoTroca = function (t, classe) { var a = document.getElementById("comp-troca-status"); if (a) { a.textContent = t; a.className = "upload-status" + (classe ? " " + classe : ""); } };
  var gravarTroca = async function (usuario, dia, valor) {   // valor vazio = remove a troca do dia
    var linhasP = compAdm.linhas.filter(function (l) { return l.usuario_wms === usuario && l.turno === compAdm.turno; });
    for (var i = 0; i < linhasP.length; i++) {
      var pr = Object.assign({}, linhasP[i].presenca || {}), tr = Object.assign({}, pr.troca || {});
      if (valor) tr[dia] = valor; else delete tr[dia];
      if (Object.keys(tr).length) pr.troca = tr; else delete pr.troca;
      var ru = await supabaseClient.from("competicao_times").update({ presenca: pr, atualizado_em: new Date().toISOString() }).eq("id", linhasP[i].id);
      if (ru.error) return ru.error.message;
    }
    return linhasP.length ? null : "pessoa não encontrada no turno";
  };
  document.getElementById("comp-btn-troca").addEventListener("click", async function () {
    var usuario = document.getElementById("comp-troca-pessoa").value, dia = document.getElementById("comp-troca-dia").value;
    var hora = document.getElementById("comp-troca-hora").value, destino = document.getElementById("comp-troca-destino").value;
    if (!usuario || !/^\d{2}:\d{2}$/.test(hora)) { avisoTroca("Escolha a pessoa e o horário.", "pendente"); return; }
    var erro = await gravarTroca(usuario, dia, hora + (destino ? ">" + destino : ""));
    if (erro) { avisoTroca("Erro: " + erro, "erro"); return; }
    await recarregar();
    avisoTroca("Troca lançada.", "ok");
  });
  el.querySelectorAll("[data-troca-rem]").forEach(function (b) {
    b.addEventListener("click", async function () {
      var par = b.getAttribute("data-troca-rem").split("|"), erro = await gravarTroca(par[0], par[1], "");
      if (erro) avisoTroca("Erro: " + erro, "erro"); else recarregar();
    });
  });
  el.querySelectorAll("#comp-tb-times tr").forEach(function (tr) {
    var sel = function () { compAdm.time = Number(tr.getAttribute("data-time")); compAdm.editando = null; renderCompeticaoAdmin(false); };
    tr.addEventListener("click", sel);
    tr.addEventListener("keydown", function (e) { if (e.key === "Enter") sel(); });
  });

  document.getElementById("comp-btn-add").addEventListener("click", async function () {
    var digitado = document.getElementById("comp-novo-usuario").value.trim();
    if (!digitado) { avisoMembro("Informe o usuário do WMS.", "pendente"); return; }
    var base = idx.get(normalizarUsuarioWMS(digitado));
    var piso = document.getElementById("comp-novo-piso").value;
    var atvSel = document.getElementById("comp-novo-atv").value;
    var registro = {
      // Grava o usuário digitado: o usuario_wms da Base de Ativos é um palpite (1º + 2º nome) e costuma diferir do WMS.
      usuario_wms: normalizarUsuarioWMS(digitado), nome: base ? base.nome : null,
      turno: compAdm.turno, atividade: atvSel, time: compAdm.time,
      piso: piso ? Number(piso) : null, setor: null,
      observacao: document.getElementById("comp-novo-obs").value || null,
      lider: document.getElementById("comp-novo-lider").value === "true",
      atualizado_em: new Date().toISOString(),
    };
    var registros = atvSel === "sep+conf"
      ? ["sep", "conf"].map(function (a) { return Object.assign({}, registro, { atividade: a }); })
      : [registro];
    var { error } = await supabaseClient.from("competicao_times").upsert(registros, { onConflict: "usuario_wms,atividade,turno" });
    if (error) { avisoMembro("Erro: " + error.message, "erro"); return; }
    await recarregar();
    avisoMembro(base ? "Membro adicionado." : "Adicionado, mas este usuário não está na Base de Ativos — confira o nome.", base ? "ok" : "pendente");
  });

  el.querySelectorAll("[data-acao]").forEach(function (b) {
    b.addEventListener("click", async function () {
      var acao = b.getAttribute("data-acao"), id = b.getAttribute("data-id");
      if (acao === "editar") { compAdm.editando = id; renderCompeticaoAdmin(false); }
      else if (acao === "cancelar") { compAdm.editando = null; renderCompeticaoAdmin(false); }
      else if (acao === "remover") {
        var rr = await supabaseClient.from("competicao_times").delete().eq("id", id);
        if (rr.error) avisoMembro("Erro: " + rr.error.message, "erro"); else recarregar();
      } else if (acao === "salvar") {
        var linha = b.closest(".comp-membro"), novo = { atualizado_em: new Date().toISOString() };
        linha.querySelectorAll("[data-campo]").forEach(function (sel) {
          var c = sel.getAttribute("data-campo"), v = sel.value;
          if (c === "time") novo.time = Number(v);
          else if (c === "piso") novo.piso = v ? Number(v) : null;
          else if (c === "lider") novo.lider = v === "true";
          else if (c === "observacao") novo.observacao = v || null;
          else if (c === "nome") novo.nome = v.trim().toUpperCase();
          else novo[c] = v;
        });
        if (!novo.nome) { avisoMembro("Informe o nome completo.", "pendente"); return; }
        var ru = await supabaseClient.from("competicao_times").update(novo).eq("id", id);
        if (ru.error) avisoMembro("Erro: " + ru.error.message, "erro"); else { compAdm.editando = null; recarregar(); }
      }
    });
  });

  // Modelo: mesmas abas por cor, com uma linha de exemplo para cada combinação de Atividade × Observação × Líder.
  document.getElementById("comp-btn-modelo").addEventListener("click", function () {
    var porTime = {}, k = 0;
    COMP_ATIVS.forEach(function (a) {
      var obsPossiveis = (a[0] === "sep" || a[0] === "conf") ? ["", "Colmeia"] : [""];
      obsPossiveis.forEach(function (obs) {
        ["S", "N"].forEach(function (lid) {
          var time = obs ? (k % 2 ? 6 : 5) : (k % 4) + 1;
          (porTime[time] = porTime[time] || []).push({ nome: "Colaborador " + (k + 1), usuario_wms: "NOME.SOBRENOME" + (k + 1), atividade: a[0], turno: COMP_TURNOS[k % COMP_TURNOS.length],
            piso: obs ? "" : time, observacao: obs || null, lider: lid === "S", presenca: k % 3 ? { "2026-11-27": "P" } : { "2026-11-27": "F" } });
          k++;
        });
      });
    });
    ["sep", "conf"].forEach(function (a) {   // exemplo de quem faz as duas: vira uma linha "C/S"
      (porTime[1] = porTime[1] || []).push({ nome: "Colaborador C/S", usuario_wms: "NOME.AMBAS", atividade: a, turno: "1º Turno", piso: 1, observacao: null, lider: false, presenca: { "2026-11-27": "P" } });
    });
    XLSX.writeFile(planilhaPorCores(porTime), "modelo_competicao_times.xlsx");
  });
  // Exporta a escalação atual (todos os turnos), uma aba por cor, pronta para editar e reenviar.
  document.getElementById("comp-btn-exportar").addEventListener("click", function () {
    var ordemTurno = function (x) { return COMP_TURNOS.indexOf(x); };
    var porTime = {};
    compAdm.linhas.slice().sort(function (a, b) {
      return ordemTurno(a.turno) - ordemTurno(b.turno) || (b.lider ? 1 : 0) - (a.lider ? 1 : 0) || rotuloAtividade(a.atividade).localeCompare(rotuloAtividade(b.atividade)) || a.usuario_wms.localeCompare(b.usuario_wms);
    }).forEach(function (l) { (porTime[l.time] = porTime[l.time] || []).push(l); });
    var hoje = new Date();
    XLSX.writeFile(planilhaPorCores(porTime), "times_competicao_" + hoje.getFullYear() + String(hoje.getMonth() + 1).padStart(2, "0") + String(hoje.getDate()).padStart(2, "0") + ".xlsx");
  });
  document.getElementById("comp-btn-planilha").addEventListener("click", async function () {
    var input = document.getElementById("comp-planilha");
    if (!input.files.length) { definirStatus("comp-planilha", "Escolha a planilha primeiro.", "pendente"); return; }
    definirStatus("comp-planilha", "Lendo planilha…", "pendente");
    try {
      var res = await processarPlanilhaCompeticao(input.files[0], idx);
      await renderCompeticaoAdmin(false);
      if (window.recarregarCompeticao) window.recarregarCompeticao();
      definirStatus("comp-planilha", res.texto, res.classe); // depois do redesenho, senão a mensagem some
    } catch (e) { console.error(e); definirStatus("comp-planilha", "Erro: " + e.message, "erro"); }
  });
  restaurarStatusAbastecimento();
  renderPontosBlack();
}

// =========================================================================
// MISSÃO BLACK — lançamento de pontos (vistoria, desafios, ajustes) e horas de ouro.
// Valores em regras-black.js. Nada é editado ou apagado: correção = estorno (lançamento inverso).
// =========================================================================
var pb = { dia: null, turno: null, time: 1 };
async function renderPontosBlack() {
  var RB = window.RegrasBlack;
  var caixas = { vistoria: document.getElementById("pb-bloco-vistoria"), gincanas: document.getElementById("pb-bloco-gincanas"),
    ajuste: document.getElementById("pb-bloco-ajuste"), ouro: document.getElementById("pb-bloco-ouro") };
  if (!RB || !caixas.vistoria) return;
  var ta = RB.turnoAtual(new Date());
  if (!pb.dia) { pb.dia = ta.dia; pb.turno = ta.turno; }
  var dias = RB.DIAS.map(function (d) { return [d[0], d[1] + " · " + d[2]]; });
  if (!RB.DIAS.some(function (d) { return d[0] === pb.dia; })) dias.unshift([pb.dia, fmtDataBRIngest(pb.dia) + " (teste)"]);
  var times = COMP_NUM_TIMES.map(function (n) { return [n, COMP_TIMES[n][0] + (grupoTimeRot(n) ? " (" + grupoTimeRot(n) + ")" : "")]; });
  var f = function (v) { return RB.pts(v, pb.time); };

  var rL = await supabaseClient.from("competicao_pontos").select("*").eq("dia", pb.dia).eq("turno", pb.turno).order("criado_em", { ascending: false });
  var rO = await supabaseClient.from("competicao_hora_ouro").select("*").eq("dia", pb.dia).eq("turno", pb.turno).order("hora");
  var semTabela = (rL.error && /competicao_pontos/.test(rL.error.message)) || (rO.error && /competicao_hora_ouro/.test(rO.error.message));
  var lanc = rL.data || [], ouros = rO.data || [];

  // Peças comuns aos 4 cartões
  var campo = function (rotulo, html) { return '<label class="pb-campo">' + rotulo + html + "</label>"; };
  var linhaCampos = function (html) { return '<div class="comp-add" style="align-items:flex-end">' + html + "</div>"; };
  var seletores = function (comTime) {
    return linhaCampos(campo("Dia", '<select data-pb="dia">' + opcoes(dias, pb.dia) + "</select>") + campo("Turno", '<select data-pb="turno">' + opcoes(COMP_TURNOS, pb.turno) + "</select>") +
      (comTime ? campo("Time", '<select data-pb="time">' + opcoes(times, pb.time) + "</select>") : ""));
  };
  var tabelaLanc = function (cat) {
    var ls = lanc.filter(function (l) { return l.categoria === cat; });
    if (!ls.length) return "";
    return '<div class="tbl-wrap"><table class="comp-classif"><thead><tr><th>Hora</th><th>Time</th><th>Item</th><th>Pontos</th><th>Motivo</th><th>Por</th><th></th></tr></thead><tbody>' +
      ls.map(function (l) {
        var hr = new Date(l.criado_em).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
        return "<tr><td>" + hr + "</td><td>" + COMP_TIMES[l.time][0] + "</td><td>" + htmlSeguro(l.item || "") + '</td><td style="text-align:right;font-weight:700;color:' + (l.pontos < 0 ? "var(--red)" : "var(--olive)") + '">' + (l.pontos > 0 ? "+" : "") + l.pontos +
          "</td><td>" + htmlSeguro(l.motivo || "") + "</td><td>" + htmlSeguro((l.registrado_email || "").replace(/@.*/, "")) + '</td><td><button class="btn ghost pb-estorno" data-id="' + l.id + '">Estornar</button></td></tr>';
      }).join("") + "</tbody></table></div>";
  };
  var cartao = function (k, titulo, corpo, botaoTopo) {
    return '<div class="panel" style="display:flex; flex-direction:column; gap:12px"><div class="panel-head"><div><p class="kicker">Missão Black</p><h4>' + titulo + "</h4></div>" + (botaoTopo || "") + "</div>" +
      (semTabela ? '<div class="upload-status erro">Tabelas de pontos não encontradas no banco (sql/black_pontos.sql).</div>' : "") +
      corpo + '<div class="upload-status" id="pb-status-' + k + '"></div></div>';
  };

  // Vistoria
  var porGrav = {};
  RB.CHECKLIST.forEach(function (c, i) { (porGrav[c.grav] = porGrav[c.grav] || []).push('<label class="pb-item"><input type="number" min="0" max="9" value="0" data-i="' + i + '"> ' + htmlSeguro(c.item) + "</label>"); });
  var checklist = Object.keys(RB.GRAVIDADES).map(function (g) {
    return '<div class="pb-grav"><b>' + RB.GRAVIDADES[g].rot + " · " + f(RB.GRAVIDADES[g].pts) + " pts cada</b>" + (porGrav[g] || []).join("") + "</div>";
  }).join("");
  caixas.vistoria.innerHTML = cartao("vistoria", "Vistoria", seletores(true) +
    '<div class="pb-check" style="grid-template-columns:repeat(auto-fit, minmax(240px, 1fr))">' + checklist + "</div>" +
    '<label class="pb-item"><input type="checkbox" id="pb-limpa"> Vistoria sem apontamento (+' + f(RB.P.vistoriaLimpa) + ")</label>" +
    linhaCampos(campo("Observação", '<input id="pb-vis-obs" placeholder="local, corredor, quem viu">') + '<button class="btn" id="pb-btn-vistoria">Lançar vistoria</button>') +
    tabelaLanc("vistoria"));

  // Gincanas: mesmo valor para os 8 times (colmeia × fator)
  var gincanas = (RB.DESAFIOS[pb.dia] || []).concat(RB.GINCANAS || [], ["Outra gincana"]);
  caixas.gincanas.innerHTML = cartao("gincanas", "Gincanas", seletores(false) +
    linhaCampos(campo("Gincana", '<select id="pb-desafio">' + opcoes(gincanas, gincanas[0]) + "</select>") +
      campo("Pontos (colmeia × " + String(RB.FATOR_COLMEIA).replace(".", ",") + ")", '<input id="pb-des-pts" type="number" value="' + RB.PONTOS_DESAFIO + '">')) +
      '<div><button class="btn" id="pb-btn-desafio">Lançar para todos os times</button></div>' +
    tabelaLanc("desafio"));

  // Ajuste de pontuação (+ extração da planilha)
  caixas.ajuste.innerHTML = cartao("ajuste", "Ajuste de pontuação", seletores(true) +
    linhaCampos(campo("Pontos (negativo desconta)", '<input id="pb-aj-pts" type="number" placeholder="ex.: -30 ou 50">') +
      campo("Motivo (obrigatório)", '<input id="pb-aj-motivo">')) + '<div><button class="btn" id="pb-btn-ajuste">Lançar ajuste</button></div>' +
    tabelaLanc("ajuste"));
  var cxExtrair = document.getElementById("pb-bloco-extrair");
  if (cxExtrair) cxExtrair.innerHTML = '<div class="pb-extrair"><span class="upload-status" id="pb-status-extrair"></span><button class="btn" id="pb-btn-extrair">Extrair Descontos e Adições</button></div>';

  // Horas de ouro
  var T = RB.TURNOS[pb.turno] || RB.TURNOS["1º Turno"], horas = [];
  for (var h = Math.floor(T.ini / 60); h < Math.ceil(T.fim / 60); h++) horas.push([h % 24, String(h % 24).padStart(2, "0") + "h00–" + String((h + 1) % 24).padStart(2, "0") + "h00"]);
  caixas.ouro.innerHTML = cartao("ouro", "Horas de Ouro", seletores(false) +
    linhaCampos(campo("Hora", '<select id="pb-ouro-hora">' + opcoes(horas, horas[0] && horas[0][0]) + "</select>") +
      campo("Meta/h por time · checkout (vestuário na proporção)", '<input id="pb-ouro-piso" type="number" value="260">') +
      campo("Meta/h por time · colmeia", '<input id="pb-ouro-col" type="number" value="160">')) + '<div><button class="btn" id="pb-btn-ouro">Agendar</button></div>' +
    (ouros.length ? '<div class="pb-ouros">' + ouros.map(function (o) { return "<span>" + String(o.hora).padStart(2, "0") + "h · checkout " + o.meta_piso + " · vestuário " + RB.metaOuro(o, 7, o.turno) + " · colmeia " + o.meta_colmeia + ' <button class="btn ghost pb-ouro-del" data-id="' + o.id + '">Remover</button></span>'; }).join("") + "</div>" : ""));

  // Eventos
  var aviso = function (k, t, c) { var a = document.getElementById("pb-status-" + k); if (a) { a.textContent = t; a.className = "upload-status" + (c ? " " + c : ""); } };
  Object.keys(caixas).forEach(function (k) {
    caixas[k].querySelectorAll("[data-pb]").forEach(function (s) {
      s.addEventListener("change", function () { var c = s.getAttribute("data-pb"); pb[c] = c === "time" ? Number(s.value) : s.value; renderPontosBlack(); });
    });
  });
  document.getElementById("pb-btn-extrair").addEventListener("click", async function () {
    aviso("extrair", "Montando a planilha…", "pendente");
    try { aviso("extrair", await extrairPontosBlack(), "ok"); } catch (e) { console.error(e); aviso("extrair", "Erro ao extrair: " + e.message, "erro"); }
  });
  var email = async function () { var r = await supabaseClient.auth.getSession(); return r.data && r.data.session ? r.data.session.user.email : null; };
  var gravar = async function (k, linhas, ok) {
    var em = await email();
    linhas.forEach(function (l) { l.dia = pb.dia; l.turno = pb.turno; l.registrado_email = em; if (!l.time) l.time = pb.time; });
    var r = await supabaseClient.from("competicao_pontos").insert(linhas);
    if (r.error) { aviso(k, "Erro: " + r.error.message, "erro"); return; }
    await renderPontosBlack(); aviso(k, ok, "ok");
  };
  document.getElementById("pb-btn-vistoria").addEventListener("click", function () {
    var obs = document.getElementById("pb-vis-obs").value.trim(), linhas = [];
    caixas.vistoria.querySelectorAll(".pb-check input[data-i]").forEach(function (inp) {
      var q = Math.max(0, Math.min(9, parseInt(inp.value, 10) || 0)), c = RB.CHECKLIST[Number(inp.getAttribute("data-i"))];
      if (q) linhas.push({ categoria: "vistoria", item: RB.GRAVIDADES[c.grav].rot + ": " + c.item + (q > 1 ? " (×" + q + ")" : ""), pontos: f(c.pts) * q, motivo: obs || null });
    });
    var limpa = document.getElementById("pb-limpa").checked;
    if (limpa && linhas.length) { aviso("vistoria", "Marque itens OU vistoria sem apontamento, não os dois.", "pendente"); return; }
    if (limpa) linhas.push({ categoria: "vistoria", item: "Vistoria sem apontamento", pontos: f(RB.P.vistoriaLimpa), motivo: obs || null });
    if (!linhas.length) { aviso("vistoria", "Marque pelo menos um item (ou vistoria sem apontamento).", "pendente"); return; }
    var tot = linhas.reduce(function (a, l) { return a + l.pontos; }, 0);
    if (!confirm("Lançar vistoria do time " + COMP_TIMES[pb.time][0] + ": " + (tot > 0 ? "+" : "") + tot + " pontos?")) return;
    gravar("vistoria", linhas, "✓ Vistoria lançada: " + (tot > 0 ? "+" : "") + tot + " pontos para o " + COMP_TIMES[pb.time][0] + ".");
  });
  document.getElementById("pb-btn-desafio").addEventListener("click", function () {
    var nome = document.getElementById("pb-desafio").value, v = parseInt(document.getElementById("pb-des-pts").value, 10);
    if (!v) { aviso("gincanas", "Informe os pontos.", "pendente"); return; }
    var linhas = COMP_NUM_TIMES.map(function (n) { return { time: n, categoria: "desafio", item: nome, pontos: RB.pts(v, n), motivo: null }; });
    if (!confirm("Lançar \"" + nome + "\" para os 8 times: " + v + " pontos no checkout e no vestuário e " + RB.pts(v, 5) + " na colmeia?")) return;
    gravar("gincanas", linhas, "✓ Gincana lançada para os 8 times.");
  });
  document.getElementById("pb-btn-ajuste").addEventListener("click", function () {
    var v = parseInt(document.getElementById("pb-aj-pts").value, 10), m = document.getElementById("pb-aj-motivo").value.trim();
    if (!v || !m) { aviso("ajuste", "Informe os pontos e o motivo.", "pendente"); return; }
    gravar("ajuste", [{ categoria: "ajuste", item: "Ajuste manual", pontos: v, motivo: m }], "✓ Ajuste lançado.");
  });
  var chaveCat = { vistoria: "vistoria", desafio: "gincanas", ajuste: "ajuste" };
  Object.keys(caixas).forEach(function (k) {
    caixas[k].querySelectorAll(".pb-estorno").forEach(function (b) {
      b.addEventListener("click", function () {
        var l = lanc.filter(function (x) { return x.id === b.getAttribute("data-id"); })[0];
        if (!l || !confirm("Estornar " + l.pontos + " pontos do " + COMP_TIMES[l.time][0] + " (" + (l.item || l.categoria) + ")?")) return;
        gravar(chaveCat[l.categoria] || k, [{ time: l.time, categoria: l.categoria, item: "Estorno: " + (l.item || ""), pontos: -l.pontos, motivo: "Estorno do lançamento das " + new Date(l.criado_em).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) }], "✓ Estorno lançado.");
      });
    });
  });
  document.getElementById("pb-btn-ouro").addEventListener("click", async function () {
    var r = await supabaseClient.from("competicao_hora_ouro").insert({ dia: pb.dia, turno: pb.turno, hora: Number(document.getElementById("pb-ouro-hora").value),
      meta_piso: parseInt(document.getElementById("pb-ouro-piso").value, 10) || 0, meta_colmeia: parseInt(document.getElementById("pb-ouro-col").value, 10) || 0 });
    if (r.error) { aviso("ouro", "Erro: " + r.error.message, "erro"); return; }
    await renderPontosBlack(); aviso("ouro", "✓ Hora de ouro agendada.", "ok");
  });
  caixas.ouro.querySelectorAll(".pb-ouro-del").forEach(function (b) {
    b.addEventListener("click", async function () {
      if (!confirm("Remover esta hora de ouro?")) return;
      var r = await supabaseClient.from("competicao_hora_ouro").delete().eq("id", b.getAttribute("data-id"));
      if (r.error) { aviso("ouro", "Erro: " + r.error.message, "erro"); return; }
      await renderPontosBlack(); aviso("ouro", "✓ Hora de ouro removida.", "ok");
    });
  });
}

// Planilha "Descontos e Adições de Pontos por Time": mesma conta do placar (RegrasBlack.placarDoDia).
// Dias da Black já passados × turnos com escalação; antes da Black, o dia e o turno escolhidos (prévia).
async function extrairPontosBlack() {
  var RB = window.RegrasBlack;
  var r = await Promise.all([
    supabaseClient.from("dashboard_snapshots").select("dados").eq("pagina", "outbound").maybeSingle(),
    supabaseClient.from("competicao_times").select("*"),
    supabaseClient.from("competicao_pontos").select("*").order("criado_em"),
    supabaseClient.from("competicao_hora_ouro").select("*").order("dia").order("hora"),
  ]);
  r.forEach(function (x) { if (x.error) throw new Error(x.error.message); });
  var snap = (r[0].data && r[0].data.dados) || {}, cad = r[1].data || [], lanc = r[2].data || [], ouros = r[3].data || [];
  var hoje = RB.turnoAtual(new Date()).dia;
  var dias = RB.DIAS.map(function (d) { return d[0]; }).filter(function (d) { return d <= hoje; });
  var pares = [];
  if (!dias.length) pares.push([pb.dia, pb.turno]);
  else dias.forEach(function (d) { COMP_TURNOS.forEach(function (t) { if (cad.some(function (x) { return x.turno === t; })) pares.push([d, t]); }); });

  var nomeTime = function (n) { return COMP_TIMES[n] ? COMP_TIMES[n][0] : "Time " + n; };
  var abaTimes = [["Dia", "Turno", "Time", "Grupo", "Peças", "Meta do dia", "Produtividade", "Escalados", "Presentes", "Atrasos", "Assiduidade",
    "Desafios", "Vistoria", "Meta batida", "Bateu a meta às", "Antecipada", "Hora de ouro", "Destaque", "Ajustes", "Total do dia"]];
  var abaPessoas = [["Dia", "Turno", "Time", "Nome", "Usuário WMS", "Atividade", "Peças separação", "Peças conferência", "Peças total", "Presença", "Destaque", "Pontos de destaque"]];
  var abaOuro = [["Dia", "Turno", "Hora", "Time", "Meta da hora", "Peças na hora", "Hora terminou", "Bateu", "Bônus (peças em dobro)"]];
  var porTurno = {};
  pares.forEach(function (par) {
    var dia = par[0], turno = par[1], cadT = cad.filter(function (x) { return x.turno === turno; });
    var c = RB.calcularCompeticao(snap, cadT, dia);
    var pl = RB.placarDoDia({ c: c, snap: snap, cadastro: cadT, dia: dia, turno: turno, agora: new Date(),
      lanc: lanc.filter(function (l) { return l.dia === dia && l.turno === turno; }),
      ouro: ouros.filter(function (o) { return o.dia === dia && o.turno === turno; }) });
    (porTurno[turno] = porTurno[turno] || []).push(pl);
    var dBR = fmtDataBRIngest(dia);
    pl.linhas.forEach(function (x) {
      abaTimes.push([dBR, turno, nomeTime(x.n), { checkout: "Checkout", vestuario: "Vestuário", colmeia: "Colmeia" }[x.grupo] || "Checkout", x.pecas, x.meta, x.produtividade, x.escalados, x.presentes, x.atrasos, x.assiduidade,
        x.desafios, x.segQual, x.metaBatida, x.minutoMeta == null ? "" : String(Math.floor(x.minutoMeta / 60) % 24).padStart(2, "0") + ":" + String(x.minutoMeta % 60).padStart(2, "0"),
        x.antecipada, x.ouro, x.destaque, x.ajustes, x.total]);
      x.ouroDetalhe.forEach(function (o) {
        abaOuro.push([dBR, turno, String(o.hora).padStart(2, "0") + "h00", nomeTime(x.n), o.meta, o.feitas, o.terminou ? "Sim" : "Não", o.bateu ? "Sim" : "Não", o.bateu ? o.feitas : 0]);
      });
      // Colaboradores: quem produziu (lista da corrida) + quem está escalado e não produziu.
      var t = c.times[x.n - 1], vistos = {};
      var linhasCad = juntarAtividades(cadT.filter(function (l) { return l.time === x.n; }));
      var cadDe = function (u) { return linhasCad.filter(function (l) { return l.usuario_wms === u; }); };
      var linhaPessoa = function (usuario, nome, sep, conf) {
        var lc = cadDe(usuario), pres = "";
        lc.forEach(function (l) { if (l.presenca && l.presenca[dia]) pres = l.presenca[dia]; });
        var dest = x.destaques.filter(function (d) { return d.nome === (nome || usuario) && ((d.funcao === "Separação" && d.pecas === sep) || (d.funcao === "Conferência" && d.pecas === conf)); });
        abaPessoas.push([dBR, turno, nomeTime(x.n), nome || "", usuario, lc.map(function (l) { return l.sigla; }).join(", "), sep, conf, sep + conf, pres,
          dest.map(function (d) { return d.funcao; }).join(" e "), dest.length * RB.pts(RB.P.destaque, x.n)]);
      };
      t.lista.forEach(function (m) { vistos[m.usuario] = 1; linhaPessoa(m.usuario, m.nome, m.sep, m.conf); });
      linhasCad.forEach(function (l) { if (!vistos[l.usuario_wms]) { vistos[l.usuario_wms] = 1; linhaPessoa(l.usuario_wms, l.nome, 0, 0); } });
    });
  });
  var abaAcum = [["Turno", "Time", "Dias", "Dias com 100% de presença", "Trinca Perfeita", "Total acumulado"]];
  Object.keys(porTurno).forEach(function (turno) {
    var ac = RB.acumulado(porTurno[turno]);
    Object.keys(ac).sort(function (a, b) { return ac[b].total - ac[a].total; }).forEach(function (n) {
      abaAcum.push([turno, nomeTime(Number(n)), ac[n].dias, ac[n].dias100, ac[n].trinca, ac[n].total]);
    });
  });
  var abaLanc = [["Dia", "Turno", "Time", "Categoria", "Item", "Pontos", "Motivo", "Lançado por", "Lançado em"]];
  lanc.forEach(function (l) {
    abaLanc.push([fmtDataBRIngest(l.dia), l.turno, nomeTime(l.time), l.categoria, l.item || "", l.pontos, l.motivo || "",
      (l.registrado_email || "").replace(/@.*/, ""), new Date(l.criado_em).toLocaleString("pt-BR")]);
  });

  var wb = XLSX.utils.book_new();
  [["Times", abaTimes, 14], ["Acumulado", abaAcum, 16], ["Colaboradores", abaPessoas, 16], ["Lançamentos", abaLanc, 16], ["Horas de ouro", abaOuro, 14]].forEach(function (a) {
    var ws = XLSX.utils.aoa_to_sheet(a[1]);
    ws["!cols"] = a[1][0].map(function (h) { return { wch: Math.max(a[2], String(h).length + 2) }; });
    XLSX.utils.book_append_sheet(wb, ws, a[0]);
  });
  var agora = new Date(), carimbo = agora.getFullYear() + String(agora.getMonth() + 1).padStart(2, "0") + String(agora.getDate()).padStart(2, "0") + "_" + String(agora.getHours()).padStart(2, "0") + String(agora.getMinutes()).padStart(2, "0");
  XLSX.writeFile(wb, "pontos_black_" + carimbo + ".xlsx");
  return "✓ Planilha gerada: " + pares.length + " dia(s)/turno(s)" + (dias.length ? "" : " (prévia de " + fmtDataBRIngest(pb.dia) + " · " + pb.turno + ")") +
    " · " + (abaPessoas.length - 1) + " linha(s) de colaborador · " + lanc.length + " lançamento(s).";
}

// A planilha substitui a escalação inteira dos turnos que ela traz (todas as atividades); os outros turnos ficam como estão.
// Abas da planilha de times: as que têm nome de cor viram o time; sem nenhuma, vale a 1ª aba (formato antigo, coluna Time).
async function lerAbasCompeticao(file) {
  var nome = file.name.toLowerCase();
  if (nome.endsWith(".tsv") || nome.endsWith(".txt")) return [{ aba: null, time: null, rows: await parseArquivoGenerico(file) }];
  var wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  var abasCor = wb.SheetNames.filter(function (n) { return timeDaAba(n); });
  if (!abasCor.length) return [{ aba: null, time: null, rows: XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" }) }];
  return abasCor.map(function (n) { return { aba: n, time: timeDaAba(n), rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: "", raw: false }) }; });
}

async function processarPlanilhaCompeticao(file, idx) {
  var abas = await lerAbasCompeticao(file);
  var validos = new Map(), erros = [], foraBase = 0, reforcos = 0;
  abas.forEach(function (aba) { aba.rows.forEach(function (row, i) {
    var linha = (aba.aba ? aba.aba + " " : "") + (i + 2);
    var usuarioRaw = String(obterCampo(row, ["Usuário WMS", "Usuario WMS", "Usuário", "Usuario"]) || "").trim();
    var nomeTxt = String(obterCampo(row, ["Nome"]) || "").trim();
    if (!usuarioRaw && !nomeTxt) return; // linha vazia
    // Vaga sem pessoa (Nome REFORÇO, sem usuário): grava a vaga no time com um código próprio (REFORCO.<time>.<turno>.<nº>).
    var reforco = !usuarioRaw && /^REFORCO/.test(normalizarTexto(nomeTxt));
    if (reforco) {
      var tR = aba.time || inteiroDe(obterCampo(row, ["Time"]), 1, 8), uR = turnoDeTexto(obterCampo(row, ["Turno"]) || "");
      if (tR && uR) { reforcos++; usuarioRaw = "REFORCO." + tR + "." + (uR === "ADM" ? "ADM" : uR.charAt(0)) + "." + (i + 2); }
    }
    var base = usuarioRaw ? idx.get(normalizarUsuarioWMS(usuarioRaw)) : null;
    var textoAtv = obterCampo(row, ["Atividade"]);
    var atividades = atividadesDeTexto(textoAtv);
    var turno = turnoDeTexto(obterCampo(row, ["Turno"]) || (base && base.turno) || "");
    var piso = inteiroDe(obterCampo(row, ["Piso", "Andar"]), 1, 4);
    var time = aba.time || inteiroDe(obterCampo(row, ["Time"]), 1, 8);
    var obsTxt = normalizarTexto(obterCampo(row, ["Observação", "Observacao", "Obs"]));
    var observacao = (obsTxt.indexOf("COLMEIA") !== -1 || normalizarTexto(textoAtv).indexOf("COLMEIA") !== -1) ? "Colmeia" : null;
    var lider = /^(S|SIM|X|TRUE|1)$/.test(normalizarTexto(obterCampo(row, ["Líder", "Lider"])));
    var falta = [];
    if (!usuarioRaw) falta.push("usuário WMS");
    if (!atividades.length) falta.push("atividade (S, C ou C/S)");
    if (!turno) falta.push("turno");
    if (!time) falta.push("time (aba com o nome da cor)");
    if (falta.length) { erros.push("linha " + linha + " (" + (usuarioRaw || "sem usuário") + "): " + falta.join(", ")); return; }
    if (!base && !reforco) foraBase++;
    var usuario = normalizarUsuarioWMS(usuarioRaw); // o da planilha, não o palpite da Base de Ativos
    var presenca = presencaDaLinha(row), nome = reforco ? "REFORÇO" : base ? base.nome : (nomeTxt || null);
    atividades.forEach(function (atividade) {   // C/S = um registro de Separação e outro de Conferência
      validos.set(usuario + "|" + atividade + "|" + turno, {
        usuario_wms: usuario, nome: nome,
        turno: turno, atividade: atividade, setor: null, piso: piso || null, time: time,
        observacao: observacao, lider: lider, presenca: presenca, atualizado_em: new Date().toISOString(),
      });
    });
  }); });
  var registros = Array.from(validos.values());
  if (!registros.length) throw new Error(erros.length ? "Nenhuma linha válida. " + erros.slice(0, 3).join(" · ") : "A planilha não tem linhas.");
  var turnos = Array.from(new Set(registros.map(function (r) { return r.turno; })));
  var d = await supabaseClient.from("competicao_times").delete().in("turno", turnos);
  if (d.error) throw new Error("Falha ao limpar a escalação anterior: " + d.error.message);
  for (var i = 0; i < registros.length; i += 200) {
    var ins = await supabaseClient.from("competicao_times").insert(registros.slice(i, i + 200));
    if (ins.error) throw new Error("Falha ao gravar os times: " + ins.error.message);
  }
  var lideres = registros.filter(function (r) { return r.lider; }).length;
  var comPresenca = registros.filter(function (r) { return Object.keys(r.presenca).length; }).length;
  var resumo = "✓ " + registros.length + " membro(s) gravado(s) em " + turnos.length + " turno(s) · " + lideres + " líder(es)" + (abas[0].aba ? " · " + abas.length + " aba(s) de time" : "") + (comPresenca ? " · presença de " + comPresenca + " pessoa(s)" : "");
  if (reforcos) resumo += " · " + reforcos + " vaga(s) de REFORÇO";
  if (foraBase) resumo += " · " + foraBase + " fora da Base de Ativos";
  if (erros.length) resumo += " · " + erros.length + " linha(s) ignorada(s): " + erros.slice(0, 3).join("; ");
  return { texto: resumo, classe: erros.length ? "pendente" : "ok" };
}

// Colunas 27/11, 28/11, 29/11 -> {"2026-11-27":"P", ...} (só os dias preenchidos).
function presencaDaLinha(row) {
  var p = {};
  COMP_DIAS_BLACK.forEach(function (d) { var v = presencaDeTexto(obterCampo(row, [d[1]])); if (v) p[d[0]] = v; });
  COMP_DIAS_BLACK.forEach(function (d) { var t = trocaDeTexto(obterCampo(row, ["Troca " + d[1]])); if (t) (p.troca = p.troca || {})[d[0]] = t; });
  return p;
}

function fmtDataBRIngest(iso) { var p = String(iso).slice(0, 10).split("-"); return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : iso; }

// Agrupa uploads por setor (igual à navegação lateral), com espaçamento e
// título entre os grupos — em vez de todos os cards jogados em sequência.
function grupoAbastecimento(titulo, itensHtml, id) {
  return '<div class="grupo-abastecimento"' + (id ? ' id="' + id + '"' : "") + '><div class="grupo-titulo">' + titulo + '</div><div class="grupo-itens">' + itensHtml.join("") + '</div></div>';
}

async function renderAbastecimento() {
  var el = document.getElementById("bloco-abastecimento");
  if (!el) return;
  var { data: cfg } = await supabaseClient.from("config_geral").select("ciclo_inventario_ativo").eq("chave", "geral").single();
  var cicloAtivo = !!(cfg && cfg.ciclo_inventario_ativo);
  var snapEstoque = await lerSnapshot("estoque");
  var metaCfg = snapEstoque.inventario && snapEstoque.inventario.metaConfig;
  el.innerHTML =
    grupoAbastecimento("Compartilhados entre setores", [
      caixaUpload("up-kardex-geral", "Kardex (sem filtro)", "Alimenta <strong>Pendente de fechamento</strong> (Outbound), <strong>Pula</strong> (Gestão de Estoque) e <strong>Armazenagem</strong> (Inbound) — mesmo relatório, o sistema separa pelo Tipo do Local e pelo prefixo do Local."),
      caixaUpload("up-gerenciador-or-geral", "Gerenciador de OR (sem filtro)", "Alimenta <strong>Recebimento</strong> (Inbound) e <strong>Vinculação</strong> (Reversa) — mesmo relatório, o sistema separa pelo Tipo do Recebimento."),
      caixaUpload("up-controle-nf-geral", "Controle de Nota Fiscal (sem filtro)", "Alimenta <strong>Cancelamentos WMS</strong> (Gestão de Estoque) e <strong>Integração</strong> (Reversa) — mesmo relatório, o sistema separa pela Operação/Status."),
    ], "adm-compartilhados") +
    grupoAbastecimento("Outbound", [
      caixaUpload("up-acompanhamento-op", "Acompanhamento_Op", "Alimenta os KPIs <strong>Itens em separação (SINGLE/MULTI)</strong> e <strong>Aguardando geração de onda</strong>, pelo Status da Nota Fiscal + Classificação Tipo Pedido — mesmo relatório usado no Report E-commerce."),
      caixaUpload("up-itens-nf-saida", "Itens de NF de Saída", "Alimenta as <strong>marcas</strong> da tela <strong>Operação agora</strong> do telão (junto com o Acompanhamento_Op). Data inicial = pedido mais antigo em tela."),
      caixaUpload("up-embalas", "Embalas (base de embalagem)", "Artigo → <strong>Marca</strong> para os produtos sem a marca no nome (Operação agora). Atualize quando a base semanal mudar."),
      caixaUpload("up-separacao-analitica", "Separação Analítica", "Alimenta <strong>Separação Checkout e Colmeia</strong> (ranking, gráfico por dia, tempo trabalhado) e a <strong>produção por hora</strong> da Competição. Uma linha por tarefa, com Data/Hora Início. Substitui a Produtividade de Separação."),
      caixaUpload("up-conferencia-analitica", "Conferência Analítica", "Alimenta <strong>Conferência Checkout</strong> (ranking, tempo trabalhado) e a <strong>produção por hora</strong> da Competição. Substitui a Conferência Checkout/Etiqueta."),
      caixaUpload("up-conf-colmeia", "Conferência Colmeia", "Alimenta <strong>Conferência Colmeia</strong>."),
    ], "adm-outbound") +
    grupoAbastecimento("Movimentação", [renderFormPallets()], "adm-movimentacao") +
    grupoAbastecimento("Gestão de Estoque", [
      cartaoCicloInventario(cicloAtivo),
      cartaoMetaInventario(metaCfg),
      caixaUpload("up-bipagens", "Bipagens (acumula o ciclo)", "Alimenta <strong>Inventário</strong> — curva real, heatmap e série diária. Selecione vários arquivos de uma vez; a data vem do início do nome (ex.: 2909 PISO 3B RUA 01 A 05).", true, !cicloAtivo),
      caixaUpload("up-diferenca-local", "Diferença por Local", "Divergências (ganhos/perdas) do ciclo de <strong>Inventário</strong>.", false, !cicloAtivo),
      caixaUpload("up-corte-pula-manual", "Base Geral Corte/Pula (planilha manual)", "Abas \"Pulas - Colmeia\" e \"Corte Físico - Checkout Express\" — alimenta os totais tratados e o ranking de agressores."),
      caixaUpload("up-corte-tela", "Corte em Tela", "Alimenta o KPI <strong>Cortes em tela</strong>."),
      caixaUpload("up-corte-resolvido", "Corte Resolvido", "Alimenta <strong>Cortes aceitos</strong> e <strong>Cortes no endereço</strong>."),
    ], "adm-estoque") +
    grupoAbastecimento("Times da competição", ['<div id="bloco-competicao-admin"><div class="panel">Carregando…</div></div>'], "adm-times") +
    grupoAbastecimento("Vistoria", ['<div id="pb-bloco-vistoria"></div>'], "adm-vistoria") +
    grupoAbastecimento("Ajustes", ['<div id="pb-bloco-extrair"></div><div class="pb-ajustes"><div id="pb-bloco-gincanas"></div><div id="pb-bloco-ajuste"></div><div id="pb-bloco-ouro"></div></div>'], "adm-ajustes");
  restaurarStatusAbastecimento();
  renderCompeticaoAdmin(true);
}

function renderFormPallets() {
  return '<div class="panel"><div class="panel-head"><div><p class="kicker">Sem fonte no WMS</p><h4>Lançamento manual — Movimentação de Pallets</h4></div><span class="pill manual">Manual</span></div>' +
    '<div class="duo">' +
    '<div class="date-campo"><span>Data</span><input type="date" class="date-box" id="pallet-data" value="' + paraDataISOLocal(new Date()) + '">' +
    '<span>Turno</span><select class="date-box" id="pallet-turno"><option>ADM</option><option>1º Turno</option><option>2º Turno</option><option>3º Turno</option></select>' +
    '<span>Piso</span><select class="date-box" id="pallet-piso"><option>Piso 1</option><option>Piso 2</option><option>Piso 3</option><option>Piso 4</option></select></div>' +
    '<div class="date-campo"><span>Efetivos</span><input type="number" class="date-box" id="pallet-efetivos" style="width:70px" min="0">' +
    '<span>Terceirizados</span><input type="number" class="date-box" id="pallet-terceirizados" style="width:70px" min="0">' +
    '<button class="btn" onclick="window.ProdutividadeIngest.lancarPallet()">Lançar</button></div>' +
    '</div><div class="upload-status" id="pallet-status"></div></div>';
}

async function lancarPallet() {
  var registro = {
    data: document.getElementById("pallet-data").value,
    turno: document.getElementById("pallet-turno").value,
    piso: document.getElementById("pallet-piso").value,
    efetivos: numero(document.getElementById("pallet-efetivos").value),
    terceirizados: numero(document.getElementById("pallet-terceirizados").value),
  };
  try {
    var atual = await lerSnapshot("inbound");
    atual.pallets = atual.pallets || { registros: [] };
    atual.pallets.registros.push(registro);
    await salvarSnapshot("inbound", atual);
    definirStatus("pallet", "✓ Lançamento salvo.", "ok");
    if (window.recarregarSnapshots) window.recarregarSnapshots(true);
  } catch (e) {
    definirStatus("pallet", "Erro: " + e.message, "erro");
  }
}

async function renderAtivos() {
  var el = document.getElementById("bloco-ativos");
  if (!el) return;
  el.innerHTML = '<div class="panel">Carregando…</div>';
  var { lista } = await carregarIndiceBaseAtivos();
  var porSetor = new Map(), porTurno = new Map();
  lista.forEach(function (c) {
    var setor = c.setor || "(sem setor)";
    var turno = c.turno || "(sem turno)";
    porSetor.set(setor, (porSetor.get(setor) || 0) + 1);
    porTurno.set(turno, (porTurno.get(turno) || 0) + 1);
  });
  function linhasTabela(mapa) {
    var arr = Array.from(mapa.entries()).sort(function (a, b) { return b[1] - a[1]; });
    var body = arr.map(function (e) { return "<tr><td>" + e[0] + "</td><td class=\"num\">" + e[1] + "</td></tr>"; }).join("");
    return body + '<tr class="total"><td>Total</td><td class="num">' + lista.length + "</td></tr>";
  }
  el.innerHTML =
    '<div class="panel"><div class="panel-head"><div><p class="kicker">Usuário do WMS → nome, gestor, turno e setor</p><h4>' + lista.length + " colaboradores cadastrados</h4></div></div>" +
    '<div class="duo"><div><table class="op"><tr><th>Setor</th><th class="num">Colaboradores</th></tr>' + linhasTabela(porSetor) + "</table></div>" +
    '<div><table class="op"><tr><th>Turno</th><th class="num">Colaboradores</th></tr>' + linhasTabela(porTurno) + "</table></div></div>" +
    caixaUpload("up-base-ativos", "Base de Ativos (planilha RH)", "Colunas: Código, Nome, Estabelecimento, Cargo, Lotação, Jornada, Horário, Admissão, Situação, Gestor, Setor. Usuário sem cadastro nunca é descartado — aparece como \"não cadastrado\" nos relatórios.") +
    '</div>';
}

// -------------------------------------------------------------------------
// Upload da Base de Ativos: gera o usuario_wms candidato a partir do Nome e
// grava (upsert) em base_ativos.
// -------------------------------------------------------------------------
async function processarBaseAtivos(file) {
  var rows = await parseXLSXPrimeiraAba(file);
  var registros = rows.map(function (row) {
    var nome = obterCampo(row, ["Nome"]) || "";
    var candidatos = candidatosDoNome(nome);
    var usuarioWMS = candidatos[0] || normalizarTexto(nome).replace(/\s+/g, ".");
    return {
      usuario_wms: usuarioWMS,
      nome: nome,
      gestor: obterCampo(row, ["Gestor"]) || "",
      turno: obterCampo(row, ["Horário", "Horario"]) || "",
      setor: normalizarSetor(obterCampo(row, ["Setor"]) || ""),
      atualizado_em: new Date().toISOString(),
    };
  }).filter(function (r) { return r.nome; });

  // A planilha não tem coluna de usuário do WMS — usuario_wms é um "chute"
  // a partir do nome (candidatosDoNome), e mais de um colaborador pode cair
  // no mesmo chute (ex.: dois "JOAO SILVA..."). Sem isso, o Postgres recusa
  // o upsert inteiro ("ON CONFLICT DO UPDATE cannot affect row a second
  // time"). Em vez de travar ou descartar alguém, dá um sufixo pra cada
  // repetição — o admin pode corrigir manualmente o usuario_wms depois.
  var vistos = new Map();
  registros.forEach(function (r) {
    var chave = r.usuario_wms;
    var n = (vistos.get(chave) || 0) + 1;
    vistos.set(chave, n);
    if (n > 1) r.usuario_wms = chave + "_" + n;
  });

  // upsert em lotes de 200 para não estourar payload em bases grandes
  for (var i = 0; i < registros.length; i += 200) {
    var lote = registros.slice(i, i + 200);
    var { error } = await supabaseClient.from("base_ativos").upsert(lote, { onConflict: "usuario_wms" });
    if (error) throw new Error("Falha ao gravar base_ativos: " + error.message);
  }
  return registros.length;
}

// =========================================================================
// 7) ORQUESTRAÇÃO — cada botão "Enviar" cai aqui
// =========================================================================
async function processar(id) {
  var input = document.getElementById(id);
  if (!input || !input.files || !input.files.length) { definirStatus(id, "Selecione um arquivo antes.", "erro"); return; }
  definirStatus(id, "Processando…");
  try {
    if (id === "up-base-ativos") {
      var n = await processarBaseAtivos(input.files[0]);
      definirStatus(id, "✓ " + n + " colaboradores atualizados na Base de Ativos.", "ok");
      renderAtivos();
      return;
    }

    var { indice, indicePorPrimeiroNome, lista: listaBase } = await carregarIndiceBaseAtivos();
    baseTurnos = { indice: indice, lista: listaBase || [] };

    if (id === "up-kardex-geral") {
      // Um único Kardex (sem filtro) alimenta Separação/Pula/Pendente (Outbound
      // e Estoque, via Tipo do Local) e Armazenagem (Inbound, via prefixo do
      // Local) — é o mesmo relatório exportado, só muda o filtro na tela do
      // WMS. Não precisa mais tirar dois exports separados.
      var rows = await parseArquivoGenerico(input.files[0]);

      var r = processarKardexMovimentacoes(rows, indice);
      var atual = await lerSnapshot("outbound");
      atual.separacao = atual.separacao || {};
      // "single"/"multi" do KPI de topo vêm do Acompanhamento_Op (mais
      // preciso — ver up-acompanhamento-op), não daqui.
      atual.separacao.kpis = Object.assign({}, atual.separacao.kpis, {
        separadores: r.separadoresColmeiaDistintos,
        pendente: r.pendenteFechamento,
      });
      // A Separação Colmeia por pessoa/dia vem da Separação Analítica (Região Destino
      // COLMEIA); o Kardex fica só com Pendente de fechamento, Pula e Armazenagem.
      await salvarSnapshot("outbound", atual);

      // Pula fica na página de Estoque (setor Gestão de Estoque)
      var atualEstoque = await lerSnapshot("estoque");
      atualEstoque.corte = atualEstoque.corte || {};
      atualEstoque.pula = { totalPeriodo: somaMapa(r.pulaPorUsuario), ranking: mapParaRanking(r.pulaPorUsuario), rankingDia: mesclarDias(atualEstoque.pula && atualEstoque.pula.rankingDia, diaMapParaArray(r.pulaDia)) };
      await salvarSnapshot("estoque", atualEstoque);

      // Mesmas linhas, agora filtradas por prefixo de Local (H/I/J/S) -> Armazenagem
      // Segmento (Calçados/Vestuário) da armazenagem: base Embalas guardada no snapshot operacao (só esse campo)
      var embSeg = null;
      try {
        var qEmb = await supabaseClient.from("dashboard_snapshots").select("emb:dados->embalas").eq("pagina", "operacao").maybeSingle();
        embSeg = (qEmb.data && qEmb.data.emb) || null;
      } catch (eEmb) { console.error(eEmb); }
      var r5 = processarKardexEndereco(rows, indice, embSeg);
      var atual5 = await lerSnapshot("inbound");
      var armAnterior = atual5.armazenagem || {};
      // Os dias do arquivo substituem os salvos; guarda os 31 mais recentes
      var segDia5 = Object.assign({}, armAnterior.segDia || {}, r5.segDia);
      Object.keys(segDia5).sort().slice(0, -31).forEach(function (d) { delete segDia5[d]; });
      atual5.armazenagem = {
        normal: mapParaRanking(r5.porUsuarioNormal), reversa: mapParaRanking(r5.porUsuarioReversa),
        totalNormal: r5.totalNormal, totalReversa: r5.totalReversa,
        normalDia: mesclarDias(armAnterior.normalDia, diaMapParaArray(r5.normalDia)),
        reversaDia: mesclarDias(armAnterior.reversaDia, diaMapParaArray(r5.reversaDia)),
        // Hora a hora da armazenagem normal (telão): os dias do arquivo substituem os salvos, guarda até 31 dias.
        normalHoraDia: mesclarDias(armAnterior.normalHoraDia, Array.from(r5.normalHora.entries()).map(function (e) { return { data: e[0], horas: e[1] }; })).slice(-31),
        segDia: segDia5,
      };
      var diaOp5 = diaOperacionalIngest(new Date());
      atual5.armazenagem.previsao = previsaoDoDia(atual5.armazenagem.normalHoraDia, new Date(),
        totalDoDia([atual5.armazenagem.normalDia], diaOp5), 1, minutosOperacionais(r5.normalMin, diaOp5));
      atual5.recebimento = atual5.recebimento || {};
      atual5.recebimento.normal = Object.assign({}, atual5.recebimento.normal, { itensArmazenados: r5.totalNormal });
      atual5.recebimento.reversa = Object.assign({}, atual5.recebimento.reversa, { itensArmazenados: r5.totalReversa });
      await salvarSnapshot("inbound", atual5);

      // Expedição (telão) é um extra: se falhar, o resto do Kardex já está gravado.
      var textoExp;
      try {
        var rExp = processarExpedicaoKardex(rows);
        var resExp = await atualizarOperacao({ expedicao: rExp, kardexEm: Date.now() });
        var expHoje = ((resExp.expedicao || {}).dias || []).filter(function (d) { return d.data === diaOp5; })[0];
        textoExp = "Expedição hoje: " + (expHoje ? expHoje.pedidos.toLocaleString("pt-BR") + " pedidos, " + expHoje.pecas.toLocaleString("pt-BR") + " peças" : "nada ainda");
      } catch (eExp) { console.error(eExp); textoExp = "Expedição NÃO gravada: " + eExp.message; }

      definirStatus(id, "✓ Kardex processado: Pendente de fechamento (Outbound), Pula (Estoque), Armazenagem (Inbound) e " + textoExp + ".", "ok");
    }

    else if (id === "up-separacao-analitica") {
      var rowsSA = await parseArquivoGenerico(input.files[0]);
      var acS = processarSeparacaoAnalitica(rowsSA);
      var diasS = diasHoraParaArray(acS.horas, acS.minutos);
      if (!diasS.length) throw new Error("Nenhuma linha válida: confira se o arquivo traz Data/Hora Início, Região Destino e Usuário.");
      var atualSA = await lerSnapshot("outbound");
      atualSA.separacao = atualSA.separacao || {};
      var sepA = atualSA.separacao;
      // Os dias do arquivo substituem os já salvos; os demais ficam (guarda até 31 dias de hora a hora).
      sepA.analitico = podarMinutos(mesclarHoras(sepA.analitico, diasS, diasDasPecas(acS.pecas)).slice(-31));
      sepA.checkoutDia = mesclarDias(sepA.checkoutDia, diaMapParaArray(acS.pecas.checkout));
      sepA.colmeiaDia = mesclarDias(sepA.colmeiaDia, diaMapParaArray(acS.pecas.colmeia));
      sepA.checkoutSegDia = mesclarDias(sepA.checkoutSegDia, diaMapParaArray(acS.seg.checkout));
      sepA.colmeiaSegDia = mesclarDias(sepA.colmeiaSegDia, diaMapParaArray(acS.seg.colmeia));
      sepA.geralSegDia = mesclarDias(sepA.geralSegDia, diaMapParaArray(acS.seg.geral));   // Checkout + Colmeia juntos (sem somar tempos sobrepostos)
      // Gráfico "Itens separados por dia": Checkout x Colmeia, agora cada um só com o seu.
      var serieSA = (sepA.seriesDia || []).reduce(function (m, d) { m.set(d.data, d); return m; }, new Map());
      var porDiaTotal = { checkout: new Map(), colmeia: new Map() };
      ["checkout", "colmeia"].forEach(function (t) { acS.pecas[t].forEach(function (m, dia) { var tot = 0; m.forEach(function (v) { tot += v; }); porDiaTotal[t].set(dia, tot); }); });
      new Set(Array.from(porDiaTotal.checkout.keys()).concat(Array.from(porDiaTotal.colmeia.keys()))).forEach(function (dia) {
        var d = serieSA.get(dia) || { data: dia };
        d.checkout = porDiaTotal.checkout.get(dia) || 0; d.colmeia = porDiaTotal.colmeia.get(dia) || 0;
        serieSA.set(dia, d);
      });
      sepA.seriesDia = Array.from(serieSA.values()).sort(function (a2, b2) { return a2.data.localeCompare(b2.data); });
      sepA.ranking = sepA.ranking || {};
      sepA.ranking.checkout = mapParaRanking(acS.totais.checkout);
      sepA.ranking.colmeia = mapParaRanking(acS.totais.colmeia);
      var geralSA = new Map(acS.totais.checkout);
      acS.totais.colmeia.forEach(function (v, k) { geralSA.set(k, (geralSA.get(k) || 0) + v); });
      sepA.ranking.geral = mapParaRanking(geralSA);
      atualizarPrevisoesOutbound(atualSA);
      await salvarSnapshot("outbound", atualSA);
      definirStatus(id, "✓ Separação Analítica processada: " + diasS.length + " dia(s), de " + fmtDataBRIngest(diasS[0].data) + (diasS.length > 1 ? " a " + fmtDataBRIngest(diasS[diasS.length - 1].data) : "") + " (Checkout + Colmeia, por dia e por hora).", "ok");
    }

    else if (id === "up-conferencia-analitica") {
      var rowsCA = await parseArquivoGenerico(input.files[0]);
      var acC = processarConferenciaAnalitica(rowsCA);
      var diasC = diasHoraParaArray(acC.horas, acC.minutos);
      if (!diasC.length) throw new Error("Nenhuma linha válida: confira se o arquivo traz Data/Hora Início e Conferênte.");
      var atualCA = await lerSnapshot("outbound");
      atualCA.conferencia = atualCA.conferencia || {};
      var confA = atualCA.conferencia;
      confA.analitico = podarMinutos(mesclarHoras(confA.analitico, diasC, diasDasPecas(acC.pecas)).slice(-31));
      confA.confCheckoutDia = mesclarDias(confA.confCheckoutDia, diaMapParaArray(acC.pecas.checkout));
      confA.confCheckoutSegDia = mesclarDias(confA.confCheckoutSegDia, diaMapParaArray(acC.seg.checkout));
      confA.confCheckout = mapParaRanking(acC.totais.checkout);
      confA.totalCheckout = somaMapa(acC.totais.checkout);
      atualizarPrevisoesOutbound(atualCA);
      await salvarSnapshot("outbound", atualCA);
      definirStatus(id, "✓ Conferência Analítica processada: " + diasC.length + " dia(s), de " + fmtDataBRIngest(diasC[0].data) + (diasC.length > 1 ? " a " + fmtDataBRIngest(diasC[diasC.length - 1].data) : "") + " (por dia e por hora).", "ok");
    }

    else if (id === "up-conf-colmeia") {
      var rows4 = await parseArquivoGenerico(input.files[0]);
      var r4 = processarConferenciaColmeia(rows4);
      var mapa4 = r4.total;
      var atual4 = await lerSnapshot("outbound");
      atual4.conferencia = atual4.conferencia || {};
      atual4.conferencia.confColmeiaUnitDia = mesclarDias(atual4.conferencia.confColmeiaUnitDia, diaMapParaArray(r4.unitDia));
      atual4.conferencia.confColmeiaVolDia = mesclarDias(atual4.conferencia.confColmeiaVolDia, diaMapParaArray(r4.volDia));
      atual4.conferencia.colmeiaMarcas = marcarColmeia(atual4.conferencia.colmeiaMarcas, r4.unitDia);
      var lista4 = Array.from(mapa4.entries()).map(function (e) { return { nome: e[0], unitaria: e[1].unitaria, volumes: e[1].volumes }; });
      lista4.sort(function (a, b) { return b.unitaria - a.unitaria; });
      atual4.conferencia.confColmeia = lista4;
      atual4.conferencia.totalColmeiaUnit = lista4.reduce(function (s, x) { return s + x.unitaria; }, 0);
      atual4.conferencia.totalColmeiaVol = lista4.reduce(function (s, x) { return s + x.volumes; }, 0);
      atualizarPrevisoesOutbound(atual4);
      await salvarSnapshot("outbound", atual4);
      definirStatus(id, "✓ Conferência Colmeia processada.", "ok");
    }

    else if (id === "up-acompanhamento-op") {
      var rowsAcOp = await parseArquivoGenerico(input.files[0]);
      // Corte em Tela pode não ter sido abastecido ainda — nesse caso o
      // cruzamento simplesmente dá 0, sem travar o resto do processamento.
      var atualEstoqueAcOp = await lerSnapshot("estoque");
      var pedidosComCorte = (atualEstoqueAcOp.corte && atualEstoqueAcOp.corte.pedidosComCorte) || [];
      var rAcOp = processarAcompanhamentoOp(rowsAcOp, pedidosComCorte);
      var atualAcOp = await lerSnapshot("outbound");
      atualAcOp.separacao = atualAcOp.separacao || {};
      atualAcOp.separacao.kpis = Object.assign({}, atualAcOp.separacao.kpis, {
        single: rAcOp.emSeparacao.single,
        multi: rAcOp.emSeparacao.multi,
        comCorte: rAcOp.emSeparacao.comCorte,
      });
      atualAcOp.separacao.aguardandoOnda = rAcOp.aguardandoOnda;
      // Guardado pro cruzamento inverso: se o Corte em Tela for abastecido
      // DEPOIS deste Acompanhamento_Op, ele recalcula comCorte usando esta lista.
      atualAcOp.separacao.pedidosEmSeparacao = rAcOp.emSeparacao.pedidos;
      await salvarSnapshot("outbound", atualAcOp);
      // Operação agora (telão) é um extra: se falhar, os KPIs acima já estão gravados.
      var textoOp;
      try {
        var resOp = await atualizarOperacao({ pedidos: processarOperacaoOp(rowsAcOp), nfInfo: infoNfDoOp(rowsAcOp), opEm: Date.now() });
        textoOp = "Operação agora: " + resOp.itens.toLocaleString("pt-BR") + " itens em " + resOp.pedidos + " pedidos";
      } catch (eOp) { console.error(eOp); textoOp = "Operação agora NÃO gravada: " + eOp.message; }
      definirStatus(id, "✓ Acompanhamento_Op processado (Itens em separação + Aguardando geração de onda · " + textoOp + ").", "ok");
    }

    else if (id === "up-embalas") {
      // Base de embalagem (Embalas, atualizada toda semana): Artigo -> MARCA, usada quando o nome do produto não traz a marca.
      var mapaEmb = processarEmbalas(await parseArquivoGenerico(input.files[0]));
      var nEmb = Object.keys(mapaEmb).length;
      if (!nEmb) throw new Error("Nenhum artigo com marca: confira se o arquivo tem as colunas Artigo (ou SKU) e MARCA.");
      await atualizarOperacao({ embalas: mapaEmb, embalasEm: Date.now() });
      definirStatus(id, "✓ Embalas: " + nEmb.toLocaleString("pt-BR") + " artigos com marca e segmento (vale a partir do próximo Itens de NF e Kardex).", "ok");
    }

    else if (id === "up-itens-nf-saida") {
      var rowsNf = await parseArquivoGenerico(input.files[0]);
      // marcas (Operação agora) + transportadora e SINGLE/MULTI das notas (Expedição)
      var resNf = await atualizarOperacao({ linhasItensNf: rowsNf, nfEm: Date.now() });
      definirStatus(id, "✓ Itens de NF de Saída processado (marcas da Operação agora; " + resNf.semMarca.toLocaleString("pt-BR") + " itens ainda sem marca" + (resNf.semMarcaPedidos && resNf.semMarcaPedidos.length ? ": pedidos " + resNf.semMarcaPedidos.join(", ") : "") + ").", "ok");
    }

    else if (id === "up-gerenciador-or-geral") {
      // Um único Gerenciador de OR (sem filtro) já traz tanto as ORs normais
      // quanto as de reversa (campo "Tipo do Recebimento") e já tem a coluna
      // Veiculo preenchida nas duas — alimenta Recebimento (Inbound) e
      // Vinculação (Reversa) ao mesmo tempo, sem precisar exportar duas vezes.
      var rows6 = await parseArquivoGenerico(input.files[0]);

      var r6 = processarGerenciadorOR(rows6);
      var atual6 = await lerSnapshot("inbound");
      atual6.recebimento = atual6.recebimento || {};
      atual6.recebimento.normal = Object.assign({}, atual6.recebimento.normal, r6.normal);
      atual6.recebimento.reversa = Object.assign({}, atual6.recebimento.reversa, r6.reversa);
      atual6.recebimento.ranking = mapParaRanking(r6.rankingPorUsuario);
      atual6.recebimento.resumoDia = mesclarDias(atual6.recebimento.resumoDia, r6.resumoDia);
      atual6.recebimento.rankingDia = mesclarDias(atual6.recebimento.rankingDia, diaMapParaArray(r6.rankingDia));
      await salvarSnapshot("inbound", atual6);

      var r12 = processarVinculacaoReversa(rows6, indice, indicePorPrimeiroNome);
      var atualR2 = await lerSnapshot("reversa");
      var vincAnt = atualR2.vinculacao || {};
      atualR2.vinculacao = {
        unidade: "pedidos",
        totalOR: r12.totalOR, naoIdentificadoOR: r12.naoIdentificadoOR,
        totalPedidos: r12.totalPedidos, naoIdentificadoPedidos: r12.naoIdentificadoPedidos,
        ranking: mapParaRanking(r12.ranking),
        rankingDia: mesclarDias(vincAnt.rankingDia, diaMapParaArray(r12.rankingDia)),
        resumoDia: mesclarDias(vincAnt.resumoDia, r12.resumoDia),
      };
      await salvarSnapshot("reversa", atualR2);

      definirStatus(id, "✓ Gerenciador de OR processado: Recebimento (Inbound) + Vinculação (Reversa).", "ok");
    }

    else if (id === "up-bipagens") {
      // Vários arquivos por vez (um por piso/rua). Cada um fica guardado pelo
      // nome — reenviar o mesmo arquivo substitui, não soma de novo.
      var arquivosBip = Array.from(input.files);
      var semData = arquivosBip.filter(function (f) { return !dataDoNomeArquivo(f.name); }).map(function (f) { return f.name; });
      if (semData.length) throw new Error("Nome sem data no início (esperado DDMM, ex.: 2909 PISO 3B...): " + semData.join(", "));
      var atualB = await lerSnapshot("estoque");
      atualB.inventario = atualB.inventario || {};
      atualB.inventario.arquivos = atualB.inventario.arquivos || {};
      atualB.inventario.metaPorDia = atualB.inventario.metaPorDia || {};
      var metaAtual = metaDiaDeConfig(atualB.inventario.metaConfig);
      for (var ib = 0; ib < arquivosBip.length; ib++) {
        var fb = arquivosBip[ib];
        var rowsB = await parseArquivoGenerico(fb);
        var rB = processarInventario(rowsB, []);
        var dataB = dataDoNomeArquivo(fb.name);
        atualB.inventario.arquivos[fb.name] = { data: dataB, bipagens: rB.bipagens, itensContados: rB.itensContados, heatmap: rB.heatmap };
        if (!atualB.inventario.metaPorDia[dataB] && metaAtual) atualB.inventario.metaPorDia[dataB] = metaAtual;
      }
      recalcularInventario(atualB.inventario);
      // Meta definida fora do WMS. Padrão: 2,50; mantém valor manual já definido.
      atualB.inventario.kpis.curvaEstipulada = atualB.inventario.kpis.curvaEstipulada || 2.5;
      await salvarSnapshot("estoque", atualB);
      definirStatus(id, "✓ " + arquivosBip.length + " arquivo(s) de Bipagens somado(s) ao ciclo" + (metaAtual ? "." : " — configure HC e setor para a Meta Dia aparecer."), "ok");
    }

    else if (id === "up-diferenca-local") {
      var rowsD = await parseArquivoGenerico(input.files[0]);
      var rD = processarInventario([], rowsD);
      var atualD = await lerSnapshot("estoque");
      atualD.inventario = atualD.inventario || {};
      atualD.inventario.kpis = Object.assign({}, atualD.inventario.kpis, {
        divergenciaGanhos: rD.divergenciaGanhos, divergenciaPerdas: rD.divergenciaPerdas,
      });
      await salvarSnapshot("estoque", atualD);
      definirStatus(id, "✓ Diferença por Local processada (divergências do ciclo).", "ok");
    }

    else if (id === "up-corte-pula-manual") {
      var file7 = input.files[0];
      var pulasRows = await parseXLSXAba(file7, "Pulas - Colmeia");
      var corteRows = await parseXLSXAba(file7, "Corte Físico - Checkout Express");
      var r7 = processarBaseGeralCortePula(pulasRows, corteRows);
      var atual7 = await lerSnapshot("estoque");
      atual7.corte = atual7.corte || {};
      atual7.corte.kpis = Object.assign({}, atual7.corte.kpis, { cortesAtendidos: r7.cortesAtendidos, pulasAtendidos: r7.pulasAtendidos });
      atual7.corte.agressoresDia = mesclarDias(atual7.corte.agressoresDia, r7.agressoresDia);
      atual7.corte.atendidosDia = mesclarDias(atual7.corte.atendidosDia, r7.atendidosDia);
      atual7.corte.agressores = Array.from(r7.porColaborador.entries()).map(function (e) { return { nome: e[0], localizado: e[1].localizado, total: e[1].total }; }).sort(function (a, b) { return b.localizado - a.localizado; });
      await salvarSnapshot("estoque", atual7);
      definirStatus(id, "✓ Base Geral Corte/Pula processada.", "ok");
    }

    else if (id === "up-corte-tela") {
      var rows8 = await parseArquivoGenerico(input.files[0]);
      var qtdTela = processarCorteEmTela(rows8);
      var atual8 = await lerSnapshot("estoque");
      atual8.corte = atual8.corte || {};
      atual8.corte.kpis = Object.assign({}, atual8.corte.kpis, { cortesEmTela: qtdTela.total });
      // Guardado pro cruzamento com o Acompanhamento_Op (pedidos em
      // separação que também estão sinalizados com corte ainda aberto).
      atual8.corte.pedidosComCorte = qtdTela.pedidos;
      atual8.corte.serieTela = qtdTela.serie;
      await salvarSnapshot("estoque", atual8);

      // Recalcula o cruzamento com o Acompanhamento_Op mesmo se ele já tiver
      // sido abastecido ANTES deste Corte em Tela (senão o alerta fica parado
      // no valor antigo até o próximo reabastecimento do Acompanhamento_Op).
      var atualOutCorte = await lerSnapshot("outbound");
      if (atualOutCorte.separacao && atualOutCorte.separacao.pedidosEmSeparacao) {
        var setCorteTela = new Set(qtdTela.pedidos);
        var comCorteAtualizado = atualOutCorte.separacao.pedidosEmSeparacao.filter(function (p) { return setCorteTela.has(p); }).length;
        atualOutCorte.separacao.kpis = Object.assign({}, atualOutCorte.separacao.kpis, { comCorte: comCorteAtualizado });
        await salvarSnapshot("outbound", atualOutCorte);
      }

      definirStatus(id, "✓ Corte em Tela processado.", "ok");
    }

    else if (id === "up-corte-resolvido") {
      var rows9 = await parseArquivoGenerico(input.files[0]);
      var r9 = processarCorteResolvido(rows9);
      var atual9 = await lerSnapshot("estoque");
      atual9.corte = atual9.corte || {};
      atual9.corte.kpis = Object.assign({}, atual9.corte.kpis, { cortesAceitos: r9.aceitos, cortesNoEndereco: r9.noEndereco });
      atual9.corte.resolvidoDia = mesclarDias(atual9.corte.resolvidoDia, r9.porDia);
      await salvarSnapshot("estoque", atual9);
      definirStatus(id, "✓ Corte Resolvido processado.", "ok");
    }

    else if (id === "up-controle-nf-geral") {
      // Um único Controle de Nota Fiscal (sem filtro) tem tanto as NFs de
      // cancelamento (Status/Data de Cancelamento) quanto as de reversa
      // (Operação = REVERSA) — mesmas colunas nos dois exports filtrados
      // que você mandou. Alimenta Cancelamentos (Gestão de Estoque) e
      // Integração (Reversa) de uma vez só.
      var rows10 = await parseArquivoGenerico(input.files[0]);

      var r10 = processarCancelamentosWMS(rows10);
      var atualEs = await lerSnapshot("estoque");
      atualEs.cancelamentos = {
        totalPeriodo: r10.total, single: r10.single, multi: r10.multi, porDia: r10.porDia,
        porMotivo: mapParaRanking(r10.porMotivo).map(function (i) { return { motivo: i.nome, total: i.valor }; }),
        porUsuario: Array.from(r10.porUsuario.entries()).map(function (e) { return { usuario: e[0], qtd: e[1] }; }).sort(function (a, b) { return b.qtd - a.qtd; }),
      };
      await salvarSnapshot("estoque", atualEs);

      var r11 = processarIntegracaoReversa(rows10);
      var atualR = await lerSnapshot("reversa");
      atualR.integracao = {
        kpis: { emTela: r11.emTela, importadas: r11.importadas, emCarga: r11.emCarga, processadasHoje: r11.processadasHoje },
        serieDia: mapParaSerieDia(r11.porDia, "total"),
      };
      await salvarSnapshot("reversa", atualR);

      definirStatus(id, "✓ Controle de Nota Fiscal processado: Cancelamentos (Estoque) + Integração (Reversa).", "ok");
    }

    if (window.recarregarSnapshots) window.recarregarSnapshots(true);
  } catch (e) {
    console.error(e);
    definirStatus(id, "Erro: " + e.message, "erro");
  }
}

// =========================================================================
// 8) EXPORTA A API PÚBLICA DESTE ARQUIVO
// =========================================================================
window.ProdutividadeIngest = {
  renderAdmin: renderAdmin,
  processar: processar,
  lancarPallet: lancarPallet,
  alternarCicloInventario: alternarCicloInventario,
  salvarMetaInventario: salvarMetaInventario,
  // Robô: "Importado em" (ms) do pedido em aberto mais antigo de um Acompanhamento OP.
  maisAntigoOp: async function (file) {
    var p = processarOperacaoOp(await parseArquivoGenerico(file)), m = null;
    Object.keys(p).forEach(function (k) { var t = p[k][2]; if (t && (m === null || t < m)) m = t; });
    return m;
  },
};

})();
