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
function diasHoraParaArray(dias) {
  return Array.from(dias.values()).map(function (d) {
    var o = { data: d.data, checkout: {}, colmeia: {} };
    ["checkout", "colmeia"].forEach(function (t) { d[t].forEach(function (arr, u) { o[t][u] = arr; }); });
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
  return { horas: new Map(), pecas: { checkout: new Map(), colmeia: new Map() }, spans: new Map(), totais: { checkout: new Map(), colmeia: new Map() } };
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
function processarKardexEndereco(rows, indiceBaseAtivos) {
  var porUsuarioNormal = new Map();
  var porUsuarioReversa = new Map();
  var totalNormal = 0, totalReversa = 0;
  var normalDia = new Map(), reversaDia = new Map();

  rows.forEach(function (row) {
    var dataISO = paraDataISO(obterCampo(row, ["Data"]));
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
    } else if (prefixo === "S") {
      porUsuarioReversa.set(colaborador.nome, (porUsuarioReversa.get(colaborador.nome) || 0) + delta);
      totalReversa += delta;
      somarNoDia(reversaDia, dataISO, colaborador.nome, delta);
    }
  });

  return { porUsuarioNormal: porUsuarioNormal, porUsuarioReversa: porUsuarioReversa, totalNormal: totalNormal, totalReversa: totalReversa, normalDia: normalDia, reversaDia: reversaDia };
}

// ---- 5) Conferência Colmeia ----
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
      dia = porDiaMap.get(dataISO) || { data: dataISO, total: 0, single: 0, multi: 0, motivos: {}, usuarios: {} };
      porDiaMap.set(dataISO, dia);
      dia.total++;
    }
    // Confirmado no export real (Controle de NF Cancelamento 21.09): coluna
    // "Motivo de Cancelamento" (não "Motivo"). Os valores vêm com grafia
    // inconsistente (ex.: "Cancelado ERP" / "CANCELADO PELO ERP" / minúsculo),
    // então agrupamos pela forma normalizada (sem acento, maiúscula).
    var motivoRaw = obterCampo(row, ["Motivo de Cancelamento"]) || "(sem motivo)";
    var motivo = normalizarTexto(motivoRaw);
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
function processarVinculacaoReversa(orReversaRows, indiceBaseAtivos, indicePorPrimeiroNome) {
  var totalOR = 0, naoIdentificado = 0;
  var ranking = new Map();
  var rankingDia = new Map();
  var resumoDia = new Map(); // data -> { total, naoIdentificado }
  orReversaRows.forEach(function (row) {
    var notaFiscal = obterCampo(row, ["Nota Fiscal"]);
    if (!notaFiscal || !String(notaFiscal).trim()) return; // só ORs vinculadas
    var veiculo = obterCampo(row, ["Veiculo", "Veículo"]) || "";
    if (normalizarTexto(veiculo).indexOf("REVERSA") === -1) return; // fora do time de Reversa
    totalOR++;
    // Data em que a OR foi cadastrada/vinculada (Gerenciador de OR, "Data de Cadastro").
    var dataISO = paraDataISO(obterCampo(row, ["Data de Cadastro"]));
    var resumo = dataISO ? (resumoDia.get(dataISO) || { data: dataISO, total: 0, naoIdentificado: 0 }) : null;
    if (resumo) { resumo.total++; resumoDia.set(dataISO, resumo); }
    var colaborador = extrairNomeDoVeiculo(veiculo, indiceBaseAtivos, indicePorPrimeiroNome);
    if (colaborador) {
      ranking.set(colaborador.nome, (ranking.get(colaborador.nome) || 0) + 1);
      somarNoDia(rankingDia, dataISO, colaborador.nome, 1);
    } else {
      naoIdentificado++;
      if (resumo) resumo.naoIdentificado++;
    }
  });
  return { totalOR: totalOR, naoIdentificado: naoIdentificado, ranking: ranking, rankingDia: rankingDia, resumoDia: Array.from(resumoDia.values()).sort(function (a, b) { return a.data.localeCompare(b.data); }) };
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
function mesclarDias(anterior, novoArray) {
  var mapa = new Map((anterior || []).map(function (d) { return [d.data, d]; }));
  (novoArray || []).forEach(function (d) { mapa.set(d.data, d); });
  return Array.from(mapa.values()).sort(function (a, b) { return a.data.localeCompare(b.data); });
}
function somaMapa(mapa) { var s = 0; mapa.forEach(function (v) { s += v; }); return s; }
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
    '<div class="upload-box"><p>' + descricao + avisoDesabilitado + '</p>' +
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
  } else {
    if (el) { el.textContent = texto; el.className = "upload-status" + (classe ? " " + classe : ""); }
  }
  if (badge) badge.hidden = (classe !== "ok");
}

// Chamado depois de renderizar a tela de Abastecimento: relê o localStorage
// e repõe a última confirmação de cada card, já que o innerHTML foi recriado
// do zero (sem isso, a mensagem "some" ao sair e voltar pra tela).
function restaurarStatusAbastecimento() {
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
    '<p>Liga quando o time está em ciclo de contagens; desliga quando não está (ex.: fora de temporada). Fica valendo até alguém trocar aqui — não precisa marcar de novo a cada acesso.</p>' +
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
    '<div class="upload-status" id="meta-inv-status">Meta Dia atual: ' + (meta ? meta.toLocaleString("pt-BR") + " itens/dia" : "— (informe o headcount)") + '. Vale para os próximos dias enviados; dias já enviados sem meta também são preenchidos.</div>' +
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
// Cada linha = um colaborador numa atividade e turno, com setor, piso e time.
// Calçados e Vestuário dividem o piso 1, por isso o setor é guardado por membro.
// =========================================================================
var COMP_TURNOS = ["1º Turno", "2º Turno", "3º Turno", "ADM"];
var COMP_ATIVS = [
  ["sep_checkout", "Separação · Checkout"], ["sep_colmeia", "Separação · Colmeia"],
  ["conf_checkout", "Conferência · Checkout"], ["conf_colmeia", "Conferência · Colmeia"],
];
var COMP_TIMES = { 1: ["Vermelho", "--t1"], 2: ["Azul", "--t2"], 3: ["Verde", "--t3"], 4: ["Amarelo", "--t4"] };
var compAdm = { turno: "1º Turno", atv: "sep_checkout", time: 1, editando: null, linhas: [], indice: null };

function htmlSeguro(t) {
  return String(t == null ? "" : t).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
}
function atividadeDeTexto(t) {
  var n = normalizarTexto(t), col = n.indexOf("COLMEIA") !== -1;
  if (n.indexOf("SEPARACAO") !== -1) return col ? "sep_colmeia" : "sep_checkout";
  if (n.indexOf("CONFERENCIA") !== -1 || n.indexOf("FATURAMENTO") !== -1) return col ? "conf_colmeia" : "conf_checkout";
  return null;
}
function turnoDeTexto(t) {
  var n = normalizarTexto(t);
  if (n === "ADM") return "ADM";
  var m = /^([123])/.exec(n);
  return m ? COMP_TURNOS[Number(m[1]) - 1] : null;
}
function setorDeTexto(t) {
  var n = normalizarTexto(t);
  if (n.indexOf("VESTU") !== -1) return "Vestuário";
  if (n.indexOf("CALC") !== -1) return "Calçados";
  return null;
}
function inteiroDe(t, min, max) {
  var m = /\d+/.exec(String(t == null ? "" : t));
  var n = m ? Number(m[0]) : NaN;
  return n >= min && n <= max ? n : null;
}
function opcoes(lista, atual) {
  return lista.map(function (o) {
    var v = Array.isArray(o) ? o[0] : o, r = Array.isArray(o) ? o[1] : o;
    return '<option value="' + htmlSeguro(v) + '"' + (String(v) === String(atual) ? " selected" : "") + ">" + htmlSeguro(r) + "</option>";
  }).join("");
}

async function renderCompeticaoAdmin(recarregarBase) {
  var el = document.getElementById("bloco-competicao-admin");
  if (!el) return;
  var r = await supabaseClient.from("competicao_times").select("*");
  compAdm.linhas = r.data || [];
  if (recarregarBase || !compAdm.indice) compAdm.indice = (await carregarIndiceBaseAtivos()).indice;
  var idx = compAdm.indice;
  var doGrupo = compAdm.linhas.filter(function (l) { return l.turno === compAdm.turno && l.atividade === compAdm.atv; });
  var foraDaBase = function (l) { return !idx.get(normalizarUsuarioWMS(l.usuario_wms)); };

  var linhasTimes = [1, 2, 3, 4].map(function (n) {
    var m = doGrupo.filter(function (l) { return l.time === n; });
    var combos = {}; m.forEach(function (l) { combos[l.setor + " · Piso " + l.piso] = 1; });
    var ks = Object.keys(combos), pend = m.filter(foraDaBase).length;
    return '<tr data-time="' + n + '"' + (n === compAdm.time ? ' class="sel"' : "") + ' tabindex="0"><td><span class="comp-nome" style="--c:var(' + COMP_TIMES[n][1] + ')"><span class="comp-dot"></span>Time 0' + n + " · " + COMP_TIMES[n][0] + "</span></td>" +
      "<td>" + (ks.length > 1 ? '<span class="pill parcial">Personalizada</span>' : '<span class="pill info">Padrão</span>') + "</td>" +
      "<td>" + (ks.length ? htmlSeguro(ks.join(" + ")) : "—") + '</td><td class="num">' + m.length + "</td>" +
      "<td>" + (pend ? '<span class="comp-aviso">' + pend + " fora da base</span>" : '<span class="comp-ok">OK</span>') + "</td></tr>";
  }).join("");

  var membros = doGrupo.filter(function (l) { return l.time === compAdm.time; }).sort(function (a, b) { return a.usuario_wms.localeCompare(b.usuario_wms); });
  var htmlMembros = membros.map(function (l) {
    var b = idx.get(normalizarUsuarioWMS(l.usuario_wms));
    var sub = htmlSeguro(l.usuario_wms) + " · " + htmlSeguro(l.setor) + " · Piso " + l.piso + " · " + (b ? htmlSeguro(b.turno || "sem turno") : '<span class="comp-aviso">não está na Base de Ativos</span>');
    var edicao = compAdm.editando === l.id
      ? '<div class="comp-edit"><input data-campo="nome" value="' + htmlSeguro(l.nome || "") + '" aria-label="Nome completo" title="Nome completo: a Competição acha o usuário do WMS pelo primeiro e último nome">' + '<select data-campo="turno">' + opcoes(COMP_TURNOS, l.turno) + '</select><select data-campo="time">' + opcoes([1, 2, 3, 4].map(function (n) { return [n, "Time 0" + n]; }), l.time) + '</select>' +
        '<select data-campo="setor">' + opcoes(["Calçados", "Vestuário"], l.setor) + '</select><select data-campo="piso">' + opcoes([1, 2, 3, 4].map(function (n) { return [n, "Piso " + n]; }), l.piso) + "</select>" +
        '<button class="btn" data-acao="salvar" data-id="' + l.id + '">Salvar</button><button class="btn ghost" data-acao="cancelar">Cancelar</button></div>'
      : "";
    return '<div class="comp-membro"><span>' + htmlSeguro(l.nome || l.usuario_wms) + "<small>" + sub + '</small></span><button class="btn ghost" data-acao="editar" data-id="' + l.id + '">Editar</button><button class="btn ghost" style="color:var(--red)" data-acao="remover" data-id="' + l.id + '">Remover</button>' + edicao + "</div>";
  }).join("") || '<p class="fonte">Nenhum membro neste time ainda.</p>';

  el.innerHTML =
    '<div class="comp-adm"><div class="comp-adm-grid">' +
      '<div class="panel" style="display:flex; flex-direction:column; gap:12px">' +
        '<div class="panel-head"><div><p class="kicker">Times por turno e atividade</p><h4>Times</h4></div></div>' +
        '<div class="comp-add"><select id="comp-sel-turno" aria-label="Turno">' + opcoes(COMP_TURNOS, compAdm.turno) + '</select><select id="comp-sel-atv" aria-label="Atividade">' + opcoes(COMP_ATIVS, compAdm.atv) + "</select></div>" +
        '<div class="tbl-wrap"><table><thead><tr><th>Time</th><th>Composição</th><th>Setor · Piso</th><th class="num">Membros</th><th>Base de Ativos</th></tr></thead><tbody id="comp-tb-times">' + linhasTimes + "</tbody></table></div>" +
        '<p class="fonte">Calçados e Vestuário dividem o piso 1, então cada membro tem setor e piso próprios. Padrão: todos do mesmo setor e piso. Personalizada: o time mistura setores ou pisos. Clique num time para editar os membros.</p>' +
      "</div>" +
      '<div class="panel" style="display:flex; flex-direction:column; gap:10px">' +
        '<div class="panel-head"><div><p class="kicker">' + htmlSeguro(compAdm.turno) + " · " + htmlSeguro((COMP_ATIVS.filter(function (a) { return a[0] === compAdm.atv; })[0] || [])[1]) + '</p><h4>Time 0' + compAdm.time + " · " + COMP_TIMES[compAdm.time][0] + "</h4></div></div>" +
        '<div class="comp-add"><input id="comp-novo-usuario" placeholder="Usuário WMS (ex.: NOME.SOBRENOME)" aria-label="Usuário WMS"><select id="comp-novo-setor" aria-label="Setor">' + opcoes(["Calçados", "Vestuário"]) + '</select><select id="comp-novo-piso" aria-label="Piso">' + opcoes([1, 2, 3, 4].map(function (n) { return [n, "Piso " + n]; })) + '</select><button class="btn" id="comp-btn-add">Adicionar</button></div>' +
        '<div class="upload-status" id="comp-membro-status"></div>' + htmlMembros +
      "</div>" +
    "</div>" +
    '<div class="panel" style="margin-top:14px; display:flex; flex-direction:column; gap:10px">' +
      '<div class="panel-head"><div><p class="kicker">Upload</p><h4>Planilha de escalação dos times <span class="badge-feito" id="comp-planilha-badge" hidden>✓ Feito</span></h4></div></div>' +
      '<div class="upload-box"><p>Colunas: <strong>Nome, Usuário WMS, Turno, Atividade, Setor, Piso, Time</strong>. Uma linha por colaborador e atividade. Turno vazio usa o da Base de Ativos. A planilha <strong>substitui</strong> a escalação das combinações de turno e atividade que ela traz; o restante fica como está.</p>' +
      '<input type="file" id="comp-planilha" accept=".xlsx,.xls,.xlsb,.tsv,.txt"><button class="btn" id="comp-btn-planilha">Enviar planilha</button><button class="btn ghost" id="comp-btn-modelo">Baixar modelo</button>' +
      '<div class="upload-status" id="comp-planilha-status"></div></div></div></div>';

  var avisoMembro = function (t, classe) { var a = document.getElementById("comp-membro-status"); if (a) { a.textContent = t; a.className = "upload-status" + (classe ? " " + classe : ""); } };
  var recarregar = async function () { await renderCompeticaoAdmin(false); if (window.recarregarCompeticao) window.recarregarCompeticao(); };

  document.getElementById("comp-sel-turno").addEventListener("change", function () { compAdm.turno = this.value; compAdm.editando = null; renderCompeticaoAdmin(false); });
  document.getElementById("comp-sel-atv").addEventListener("change", function () { compAdm.atv = this.value; compAdm.editando = null; renderCompeticaoAdmin(false); });
  el.querySelectorAll("#comp-tb-times tr").forEach(function (tr) {
    var sel = function () { compAdm.time = Number(tr.getAttribute("data-time")); compAdm.editando = null; renderCompeticaoAdmin(false); };
    tr.addEventListener("click", sel);
    tr.addEventListener("keydown", function (e) { if (e.key === "Enter") sel(); });
  });

  document.getElementById("comp-btn-add").addEventListener("click", async function () {
    var digitado = document.getElementById("comp-novo-usuario").value.trim();
    if (!digitado) { avisoMembro("Informe o usuário do WMS.", "pendente"); return; }
    var base = idx.get(normalizarUsuarioWMS(digitado));
    var registro = {
      // Grava o usuário digitado: o usuario_wms da Base de Ativos é um palpite (1º + 2º nome) e costuma diferir do WMS.
      usuario_wms: normalizarUsuarioWMS(digitado), nome: base ? base.nome : null,
      turno: compAdm.turno, atividade: compAdm.atv, time: compAdm.time,
      setor: document.getElementById("comp-novo-setor").value, piso: Number(document.getElementById("comp-novo-piso").value),
      atualizado_em: new Date().toISOString(),
    };
    var { error } = await supabaseClient.from("competicao_times").upsert(registro, { onConflict: "usuario_wms,atividade,turno" });
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
        linha.querySelectorAll("[data-campo]").forEach(function (sel) { var c = sel.getAttribute("data-campo"); novo[c] = (c === "time" || c === "piso") ? Number(sel.value) : (c === "nome" ? sel.value.trim().toUpperCase() : sel.value); });
        if (!novo.nome) { avisoMembro("Informe o nome completo.", "pendente"); return; }
        var ru = await supabaseClient.from("competicao_times").update(novo).eq("id", id);
        if (ru.error) avisoMembro("Erro: " + ru.error.message, "erro"); else { compAdm.editando = null; recarregar(); }
      }
    });
  });

  document.getElementById("comp-btn-modelo").addEventListener("click", function () {
    var aoa = [["Nome", "Usuário WMS", "Turno", "Atividade", "Setor", "Piso", "Time"],
      ["Livia Silva", "LIVIA.SILVA", "1º Turno", "Separação Checkout", "Calçados", 1, "01"],
      ["Jessica Moura", "JESSICA.MOURA", "1º Turno", "Separação Colmeia", "Calçados", 1, "02"],
      ["Ana B. Silva", "ANA.B.SILVA", "2º Turno", "Conferência Checkout", "Vestuário", 1, "04"]];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Times");
    XLSX.writeFile(wb, "modelo_competicao_times.xlsx");
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
}

async function processarPlanilhaCompeticao(file, idx) {
  var rows = await parseArquivoGenerico(file);
  var validos = new Map(), erros = [], foraBase = 0;
  rows.forEach(function (row, i) {
    var linha = i + 2;
    var usuarioRaw = String(obterCampo(row, ["Usuário WMS", "Usuario WMS", "Usuário", "Usuario"]) || "").trim();
    if (!usuarioRaw && !String(obterCampo(row, ["Nome"]) || "").trim()) return; // linha vazia
    var base = usuarioRaw ? idx.get(normalizarUsuarioWMS(usuarioRaw)) : null;
    var atividade = atividadeDeTexto(obterCampo(row, ["Atividade"]));
    var turno = turnoDeTexto(obterCampo(row, ["Turno"]) || (base && base.turno) || "");
    var setor = setorDeTexto(obterCampo(row, ["Setor"]));
    var piso = inteiroDe(obterCampo(row, ["Piso", "Andar"]), 1, 4);
    var time = inteiroDe(obterCampo(row, ["Time"]), 1, 4);
    var falta = [];
    if (!usuarioRaw) falta.push("usuário WMS");
    if (!atividade) falta.push("atividade");
    if (!turno) falta.push("turno");
    if (!setor) falta.push("setor");
    if (!piso) falta.push("piso (1 a 4)");
    if (!time) falta.push("time (1 a 4)");
    if (falta.length) { erros.push("linha " + linha + " (" + (usuarioRaw || "sem usuário") + "): " + falta.join(", ")); return; }
    if (!base) foraBase++;
    var usuario = normalizarUsuarioWMS(usuarioRaw); // o da planilha, não o palpite da Base de Ativos
    validos.set(usuario + "|" + atividade + "|" + turno, {
      usuario_wms: usuario, nome: base ? base.nome : (String(obterCampo(row, ["Nome"]) || "").trim() || null),
      turno: turno, atividade: atividade, setor: setor, piso: piso, time: time, atualizado_em: new Date().toISOString(),
    });
  });
  var registros = Array.from(validos.values());
  if (!registros.length) throw new Error(erros.length ? "Nenhuma linha válida. " + erros.slice(0, 3).join(" · ") : "A planilha não tem linhas.");
  var pares = new Map();
  registros.forEach(function (r) { pares.set(r.atividade + "|" + r.turno, [r.atividade, r.turno]); });
  for (var par of pares.values()) {
    var d = await supabaseClient.from("competicao_times").delete().eq("atividade", par[0]).eq("turno", par[1]);
    if (d.error) throw new Error("Falha ao limpar a escalação anterior: " + d.error.message);
  }
  for (var i = 0; i < registros.length; i += 200) {
    var ins = await supabaseClient.from("competicao_times").insert(registros.slice(i, i + 200));
    if (ins.error) throw new Error("Falha ao gravar os times: " + ins.error.message);
  }
  var resumo = "✓ " + registros.length + " membro(s) gravado(s) em " + pares.size + " combinação(ões) de turno e atividade";
  if (foraBase) resumo += " · " + foraBase + " fora da Base de Ativos";
  if (erros.length) resumo += " · " + erros.length + " linha(s) ignorada(s): " + erros.slice(0, 3).join("; ");
  return { texto: resumo, classe: erros.length ? "pendente" : "ok" };
}

function fmtDataBRIngest(iso) { var p = String(iso).slice(0, 10).split("-"); return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : iso; }

// Agrupa uploads por setor (igual à navegação lateral), com espaçamento e
// título entre os grupos — em vez de todos os cards jogados em sequência.
function grupoAbastecimento(titulo, itensHtml) {
  return '<div class="grupo-abastecimento"><div class="grupo-titulo">' + titulo + '</div><div class="grupo-itens">' + itensHtml.join("") + '</div></div>';
}

async function renderAbastecimento() {
  var el = document.getElementById("bloco-abastecimento");
  if (!el) return;
  var { data: cfg } = await supabaseClient.from("config_geral").select("ciclo_inventario_ativo").eq("chave", "geral").single();
  var cicloAtivo = !!(cfg && cfg.ciclo_inventario_ativo);
  var snapEstoque = await lerSnapshot("estoque");
  var metaCfg = snapEstoque.inventario && snapEstoque.inventario.metaConfig;
  el.innerHTML =
    cartaoCicloInventario(cicloAtivo) +
    // Esses 3 relatórios são exportados do WMS sem filtro — cada um sozinho já
    // cobre mais de um setor, então abastece uma vez só em vez de tirar o
    // mesmo relatório de novo com filtros diferentes pra cada tela.
    grupoAbastecimento("Compartilhados entre setores", [
      caixaUpload("up-kardex-geral", "Kardex (sem filtro)", "Alimenta <strong>Pendente de fechamento</strong> (Outbound), <strong>Pula</strong> (Gestão de Estoque) e <strong>Armazenagem</strong> (Inbound) — mesmo relatório, o sistema separa pelo Tipo do Local e pelo prefixo do Local."),
      caixaUpload("up-gerenciador-or-geral", "Gerenciador de OR (sem filtro)", "Alimenta <strong>Recebimento</strong> (Inbound) e <strong>Vinculação</strong> (Reversa) — mesmo relatório, o sistema separa pelo Tipo do Recebimento."),
      caixaUpload("up-controle-nf-geral", "Controle de Nota Fiscal (sem filtro)", "Alimenta <strong>Cancelamentos WMS</strong> (Gestão de Estoque) e <strong>Integração</strong> (Reversa) — mesmo relatório, o sistema separa pela Operação/Status."),
    ]) +
    grupoAbastecimento("Outbound", [
      caixaUpload("up-acompanhamento-op", "Acompanhamento_Op", "Alimenta os KPIs <strong>Itens em separação (SINGLE/MULTI)</strong> e <strong>Aguardando geração de onda</strong>, pelo Status da Nota Fiscal + Classificação Tipo Pedido — mesmo relatório usado no Report E-commerce."),
      caixaUpload("up-separacao-analitica", "Separação Analítica", "Alimenta <strong>Separação Checkout e Colmeia</strong> (ranking, gráfico por dia, tempo trabalhado) e a <strong>produção por hora</strong> da Competição. Uma linha por tarefa, com Data/Hora Início. Substitui a Produtividade de Separação."),
      caixaUpload("up-conferencia-analitica", "Conferência Analítica", "Alimenta <strong>Conferência Checkout</strong> (ranking, tempo trabalhado) e a <strong>produção por hora</strong> da Competição. Substitui a Conferência Checkout/Etiqueta."),
      caixaUpload("up-conf-colmeia", "Conferência Colmeia", "Alimenta <strong>Conferência Colmeia</strong>."),
    ]) +
    grupoAbastecimento("Gestão de Estoque", [
      cartaoMetaInventario(metaCfg),
      caixaUpload("up-bipagens", "Bipagens (acumula o ciclo)", "Alimenta <strong>Inventário</strong> — curva real, heatmap e série diária. Selecione vários arquivos de uma vez; a data vem do início do nome (ex.: 2909 PISO 3B RUA 01 A 05).", true, !cicloAtivo),
      caixaUpload("up-diferenca-local", "Diferença por Local", "Divergências (ganhos/perdas) do ciclo de <strong>Inventário</strong>.", false, !cicloAtivo),
      caixaUpload("up-corte-pula-manual", "Base Geral Corte/Pula (planilha manual)", "Abas \"Pulas - Colmeia\" e \"Corte Físico - Checkout Express\" — alimenta os totais tratados e o ranking de agressores."),
      caixaUpload("up-corte-tela", "Corte em Tela", "Alimenta o KPI <strong>Cortes em tela</strong>."),
      caixaUpload("up-corte-resolvido", "Corte Resolvido", "Alimenta <strong>Cortes aceitos</strong> e <strong>Cortes no endereço</strong>."),
    ]) +
    grupoAbastecimento("Competição", ['<div id="bloco-competicao-admin"><div class="panel">Carregando…</div></div>']) +
    grupoAbastecimento("Manual", [renderFormPallets()]);
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
    '<p class="fonte">Atenção: a base tem "Gestão de Estoque" e "Gestão de estoque" como setores distintos — o ingest normaliza para exibição, mas vale corrigir na origem.</p></div>';
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
      var r5 = processarKardexEndereco(rows, indice);
      var atual5 = await lerSnapshot("inbound");
      var armAnterior = atual5.armazenagem || {};
      atual5.armazenagem = {
        normal: mapParaRanking(r5.porUsuarioNormal), reversa: mapParaRanking(r5.porUsuarioReversa),
        totalNormal: r5.totalNormal, totalReversa: r5.totalReversa,
        normalDia: mesclarDias(armAnterior.normalDia, diaMapParaArray(r5.normalDia)),
        reversaDia: mesclarDias(armAnterior.reversaDia, diaMapParaArray(r5.reversaDia)),
      };
      atual5.recebimento = atual5.recebimento || {};
      atual5.recebimento.normal = Object.assign({}, atual5.recebimento.normal, { itensArmazenados: r5.totalNormal });
      atual5.recebimento.reversa = Object.assign({}, atual5.recebimento.reversa, { itensArmazenados: r5.totalReversa });
      await salvarSnapshot("inbound", atual5);

      definirStatus(id, "✓ Kardex processado: Pendente de fechamento (Outbound), Pula (Estoque) e Armazenagem (Inbound).", "ok");
    }

    else if (id === "up-separacao-analitica") {
      var rowsSA = await parseArquivoGenerico(input.files[0]);
      var acS = processarSeparacaoAnalitica(rowsSA);
      var diasS = diasHoraParaArray(acS.horas);
      if (!diasS.length) throw new Error("Nenhuma linha válida: confira se o arquivo traz Data/Hora Início, Região Destino e Usuário.");
      var atualSA = await lerSnapshot("outbound");
      atualSA.separacao = atualSA.separacao || {};
      var sepA = atualSA.separacao;
      // Os dias do arquivo substituem os já salvos; os demais ficam (guarda até 31 dias de hora a hora).
      sepA.analitico = mesclarDias(sepA.analitico, diasS).slice(-31);
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
      await salvarSnapshot("outbound", atualSA);
      definirStatus(id, "✓ Separação Analítica processada: " + diasS.length + " dia(s), de " + fmtDataBRIngest(diasS[0].data) + (diasS.length > 1 ? " a " + fmtDataBRIngest(diasS[diasS.length - 1].data) : "") + " (Checkout + Colmeia, por dia e por hora).", "ok");
    }

    else if (id === "up-conferencia-analitica") {
      var rowsCA = await parseArquivoGenerico(input.files[0]);
      var acC = processarConferenciaAnalitica(rowsCA);
      var diasC = diasHoraParaArray(acC.horas);
      if (!diasC.length) throw new Error("Nenhuma linha válida: confira se o arquivo traz Data/Hora Início e Conferênte.");
      var atualCA = await lerSnapshot("outbound");
      atualCA.conferencia = atualCA.conferencia || {};
      var confA = atualCA.conferencia;
      confA.analitico = mesclarDias(confA.analitico, diasC).slice(-31);
      confA.confCheckoutDia = mesclarDias(confA.confCheckoutDia, diaMapParaArray(acC.pecas.checkout));
      confA.confCheckoutSegDia = mesclarDias(confA.confCheckoutSegDia, diaMapParaArray(acC.seg.checkout));
      confA.confCheckout = mapParaRanking(acC.totais.checkout);
      confA.totalCheckout = somaMapa(acC.totais.checkout);
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
      var lista4 = Array.from(mapa4.entries()).map(function (e) { return { nome: e[0], unitaria: e[1].unitaria, volumes: e[1].volumes }; });
      lista4.sort(function (a, b) { return b.unitaria - a.unitaria; });
      atual4.conferencia.confColmeia = lista4;
      atual4.conferencia.totalColmeiaUnit = lista4.reduce(function (s, x) { return s + x.unitaria; }, 0);
      atual4.conferencia.totalColmeiaVol = lista4.reduce(function (s, x) { return s + x.volumes; }, 0);
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
      definirStatus(id, "✓ Acompanhamento_Op processado (Itens em separação + Aguardando geração de onda).", "ok");
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
        totalOR: r12.totalOR, naoIdentificado: r12.naoIdentificado, ranking: mapParaRanking(r12.ranking),
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
};

})();
