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
async function salvarSnapshot(pagina, dadosNovos) {
  var { data: sessao } = await supabaseClient.auth.getSession();
  var email = sessao && sessao.session ? sessao.session.user.email : null;
  var { error } = await supabaseClient.from("dashboard_snapshots").upsert({
    pagina: pagina,
    dados: dadosNovos,
    atualizado_em: new Date().toISOString(),
    atualizado_por: email,
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

  rows.forEach(function (row) {
    var local = String(obterCampo(row, ["Local"]) || "").trim();
    if (!local) return;
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
    } else if (prefixo === "S") {
      porUsuarioReversa.set(colaborador.nome, (porUsuarioReversa.get(colaborador.nome) || 0) + delta);
      totalReversa += delta;
    }
  });

  return { porUsuarioNormal: porUsuarioNormal, porUsuarioReversa: porUsuarioReversa, totalNormal: totalNormal, totalReversa: totalReversa };
}

// ---- 2) Produtividade de Separação -> Separação Checkout ----
function processarProdutividadeSeparacao(rows) {
  var porUsuario = new Map();
  var porDia = new Map();
  rows.forEach(function (row) {
    var usuario = obterCampo(row, ["Usuário", "Usuario"]) || "(sem usuário)";
    var pecas = numero(obterCampo(row, ["Peças", "Pecas"]));
    // Confirmado no export real (Produtividade de Separação Sintética 21.09): coluna "Data".
    var dataISO = paraDataISO(obterCampo(row, ["Data"]));
    porUsuario.set(usuario, (porUsuario.get(usuario) || 0) + pecas);
    if (dataISO) porDia.set(dataISO, (porDia.get(dataISO) || 0) + pecas);
  });
  return { porUsuario: porUsuario, porDia: porDia };
}

// ---- 4) Conferência Checkout/Etiqueta ----
function processarConferenciaCheckout(rows) {
  var porConferente = new Map();
  rows.forEach(function (row) {
    var conferente = obterCampo(row, ["Conferente"]) || "(sem conferente)";
    var pecas = numero(obterCampo(row, ["Peças", "Pecas"]));
    porConferente.set(conferente, (porConferente.get(conferente) || 0) + pecas);
  });
  return porConferente;
}

// ---- 5) Conferência Colmeia ----
function processarConferenciaColmeia(rows) {
  var porOperador = new Map(); // nome -> { unitaria, volumes }
  rows.forEach(function (row) {
    var operador = obterCampo(row, ["Operador"]) || "(sem operador)";
    var unit = numero(obterCampo(row, ["Qtde Unitária Montada", "Qtde. Unitária Montada"]));
    var vol = numero(obterCampo(row, ["Qtde Volumes", "Qtde. Volumes"]));
    var atual = porOperador.get(operador) || { unitaria: 0, volumes: 0 };
    atual.unitaria += unit; atual.volumes += vol;
    porOperador.set(operador, atual);
  });
  return porOperador;
}

// ---- 8) Gerenciador de OR (geral) -> Recebimento ----
// ORs conferidas por Data da Conferência (não a de cadastro), separadas por
// tipo de recebimento (normal x reversa), produtividade por Usuário da Conferência.
function processarGerenciadorOR(rows) {
  var normal = { orsPeriodo: 0, orsConferidas: 0 };
  var reversa = { orsPeriodo: 0, orsConferidas: 0 };
  var rankingPorUsuario = new Map(); // usuario -> qtd ORs conferidas
  var porDiaConferencia = new Map();

  rows.forEach(function (row) {
    // Confirmado no export real (Gerenciador de OR 21.09): coluna "Tipo do
    // Recebimento", valores "COMPRA/TRANSFERÊNCIA - POR VOLUMES" (normal) e
    // "REVERSA - DEVOLUÇÃO DE CLIENTE FINAL" (reversa).
    var tipoRaw = normalizarTexto(obterCampo(row, ["Tipo do Recebimento"]));
    var ehReversa = tipoRaw.indexOf("REVERSA") !== -1;
    var bucket = ehReversa ? reversa : normal;
    bucket.orsPeriodo++;

    // Confirmado: "Data da Conferência" preenchida bate 1:1 com "Conferida" = S.
    var dataConferenciaRaw = obterCampo(row, ["Data da Conferência"]);
    var dataConferenciaISO = paraDataISO(dataConferenciaRaw);
    var conferida = !!dataConferenciaRaw && String(dataConferenciaRaw).trim() !== "";
    if (conferida) {
      bucket.orsConferidas++;
      var usuario = obterCampo(row, ["Usuário da Conferência", "Usuario da Conferencia"]) || "(sem usuário)";
      rankingPorUsuario.set(usuario, (rankingPorUsuario.get(usuario) || 0) + 1);
      if (dataConferenciaISO) porDiaConferencia.set(dataConferenciaISO, (porDiaConferencia.get(dataConferenciaISO) || 0) + 1);
    }
  });

  return { normal: normal, reversa: reversa, rankingPorUsuario: rankingPorUsuario, porDiaConferencia: porDiaConferencia };
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

// ---- 10) Corte e Pula ----
// Fonte manual "Base Geral Corte/Pula" (abas Pulas-Colmeia / Corte Físico):
// cortesAtendidos/pulasAtendidos = total tratado (todos os status somados);
// "maiores agressores" = % Σ QTDE STATUS=NO ENDEREÇO ÷ Σ QTDE total do colaborador.
// Fontes reais do WMS "Corte em Tela" e "Corte Resolvido" (STATUS ACEITO/RECUSADO):
// cortesEmTela = linhas do relatório em tela; cortesAceitos = ACEITO;
// cortesNoEndereco (resolvidos) = RECUSADO (produto encontrado no endereço original).
function processarBaseGeralCortePula(pulasRows, corteFisicoRows) {
  function somarQtde(rows) { var s = 0; rows.forEach(function (r) { s += numero(obterCampo(r, ["QTDE", "Qtde", "Quantidade"])); }); return s; }
  var pulasAtendidos = somarQtde(pulasRows);
  var cortesAtendidos = somarQtde(corteFisicoRows);

  var porColaborador = new Map(); // nome -> { localizado, total }
  function acumularAgressores(rows) {
    rows.forEach(function (row) {
      var usuario = obterCampo(row, ["USUÁRIO", "Usuário", "Usuario"]) || "(sem usuário)";
      var status = normalizarTexto(obterCampo(row, ["STATUS", "Status"]));
      var qtde = numero(obterCampo(row, ["QTDE", "Qtde", "Quantidade"]));
      var atual = porColaborador.get(usuario) || { localizado: 0, total: 0 };
      atual.total += qtde;
      if (status === "NO ENDERECO") atual.localizado += qtde; // "NO ENDEREÇO" sem acento após normalizarTexto
      porColaborador.set(usuario, atual);
    });
  }
  acumularAgressores(pulasRows);
  acumularAgressores(corteFisicoRows);

  return { pulasAtendidos: pulasAtendidos, cortesAtendidos: cortesAtendidos, porColaborador: porColaborador };
}

function processarCorteEmTela(rows) { return rows.length; }

function processarCorteResolvido(rows) {
  var aceitos = 0, noEndereco = 0;
  rows.forEach(function (row) {
    var status = normalizarTexto(obterCampo(row, ["STATUS", "Status"]));
    if (status === "ACEITO") aceitos++;
    else if (status === "RECUSADO") noEndereco++;
  });
  return { aceitos: aceitos, noEndereco: noEndereco };
}

// ---- 11) Cancelamentos WMS ----
// Controle de Nota Fiscal: linhas com Data de Cancelamento preenchida,
// agrupadas por Motivo e por Usuário Cancelamento, quebra SINGLE/MULTI.
// Filtro de data usa a coluna Data de Cancelamento (não a de cadastro).
function processarCancelamentosWMS(rows) {
  var porMotivo = new Map();
  var porUsuario = new Map();
  var single = 0, multi = 0, total = 0;
  rows.forEach(function (row) {
    var dataCancRaw = obterCampo(row, ["Data de Cancelamento", "Data Cancelamento"]);
    if (!dataCancRaw || !String(dataCancRaw).trim()) return;
    total++;
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
  });
  return { total: total, porMotivo: porMotivo, porUsuario: porUsuario, single: single, multi: multi };
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
  orReversaRows.forEach(function (row) {
    var notaFiscal = obterCampo(row, ["Nota Fiscal"]);
    if (!notaFiscal || !String(notaFiscal).trim()) return; // só ORs vinculadas
    var veiculo = obterCampo(row, ["Veiculo", "Veículo"]) || "";
    if (normalizarTexto(veiculo).indexOf("REVERSA") === -1) return; // fora do time de Reversa
    totalOR++;
    var colaborador = extrairNomeDoVeiculo(veiculo, indiceBaseAtivos, indicePorPrimeiroNome);
    if (colaborador) {
      ranking.set(colaborador.nome, (ranking.get(colaborador.nome) || 0) + 1);
    } else {
      naoIdentificado++;
    }
  });
  return { totalOR: totalOR, naoIdentificado: naoIdentificado, ranking: ranking };
}

// =========================================================================
// 5) MONTAGEM DOS PAYLOADS (Map -> array ordenado, formato que index.html espera)
// =========================================================================
function mapParaRanking(mapa, limite) {
  var arr = Array.from(mapa.entries()).map(function (e) { return { nome: e[0], valor: e[1] }; });
  arr.sort(function (a, b) { return b.valor - a.valor; });
  return limite ? arr.slice(0, limite) : arr;
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
function caixaUpload(id, titulo, descricao, aceitaMultiplos) {
  return '<div class="panel"><div class="panel-head"><div><p class="kicker">Upload</p><h4>' + titulo + '</h4></div></div>' +
    '<div class="upload-box"><p>' + descricao + '</p>' +
    '<input type="file" id="' + id + '" ' + (aceitaMultiplos ? "multiple" : "") + ' accept=".tsv,.txt,.xlsx,.xlsb,.xls">' +
    '<button class="btn" onclick="window.ProdutividadeIngest.processar(\'' + id + '\')">Enviar</button>' +
    '<div class="upload-status" id="' + id + '-status"></div></div></div>';
}

function definirStatus(id, texto, classe) {
  var el = document.getElementById(id + "-status");
  if (el) { el.textContent = texto; el.className = "upload-status" + (classe ? " " + classe : ""); }
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
  el.innerHTML =
    cartaoCicloInventario(cicloAtivo) +
    // Esses 3 relatórios são exportados do WMS sem filtro — cada um sozinho já
    // cobre mais de um setor, então abastece uma vez só em vez de tirar o
    // mesmo relatório de novo com filtros diferentes pra cada tela.
    grupoAbastecimento("Compartilhados entre setores", [
      caixaUpload("up-kardex-geral", "Kardex (sem filtro)", "Alimenta <strong>Separação Colmeia · Pula · Pendente de fechamento</strong> (Outbound) e <strong>Armazenagem</strong> (Inbound) — mesmo relatório, o sistema separa pelo Tipo do Local e pelo prefixo do Local."),
      caixaUpload("up-gerenciador-or-geral", "Gerenciador de OR (sem filtro)", "Alimenta <strong>Recebimento</strong> (Inbound) e <strong>Vinculação</strong> (Reversa) — mesmo relatório, o sistema separa pelo Tipo do Recebimento."),
      caixaUpload("up-controle-nf-geral", "Controle de Nota Fiscal (sem filtro)", "Alimenta <strong>Cancelamentos WMS</strong> (Gestão de Estoque) e <strong>Integração</strong> (Reversa) — mesmo relatório, o sistema separa pela Operação/Status."),
    ]) +
    grupoAbastecimento("Outbound", [
      caixaUpload("up-prod-separacao", "Produtividade de Separação", "Alimenta <strong>Separação Checkout</strong>."),
      caixaUpload("up-conf-checkout", "Conferência Checkout/Etiqueta", "Alimenta <strong>Conferência Checkout</strong>."),
      caixaUpload("up-conf-colmeia", "Conferência Colmeia", "Alimenta <strong>Conferência Colmeia</strong>."),
    ]) +
    grupoAbastecimento("Gestão de Estoque", [
      caixaUpload("up-bipagens", "Bipagens", "Junto com Diferença por Local, alimenta <strong>Inventário</strong> — curva real e heatmap."),
      caixaUpload("up-diferenca-local", "Diferença por Local", "Divergências (ganhos/perdas) do ciclo de <strong>Inventário</strong>."),
      caixaUpload("up-corte-pula-manual", "Base Geral Corte/Pula (planilha manual)", "Abas \"Pulas - Colmeia\" e \"Corte Físico - Checkout Express\" — alimenta os totais tratados e o ranking de agressores."),
      caixaUpload("up-corte-tela", "Corte em Tela", "Alimenta o KPI <strong>Cortes em tela</strong>."),
      caixaUpload("up-corte-resolvido", "Corte Resolvido", "Alimenta <strong>Cortes aceitos</strong> e <strong>Cortes no endereço</strong>."),
    ]) +
    grupoAbastecimento("Manual", [renderFormPallets()]);
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
    if (window.recarregarSnapshots) window.recarregarSnapshots();
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

    var { indice, indicePorPrimeiroNome } = await carregarIndiceBaseAtivos();

    if (id === "up-kardex-geral") {
      // Um único Kardex (sem filtro) alimenta Separação/Pula/Pendente (Outbound
      // e Estoque, via Tipo do Local) e Armazenagem (Inbound, via prefixo do
      // Local) — é o mesmo relatório exportado, só muda o filtro na tela do
      // WMS. Não precisa mais tirar dois exports separados.
      var rows = await parseArquivoGenerico(input.files[0]);

      var r = processarKardexMovimentacoes(rows, indice);
      var atual = await lerSnapshot("outbound");
      atual.separacao = atual.separacao || {};
      atual.separacao.kpis = Object.assign({}, atual.separacao.kpis, {
        multi: somaMapa(r.separacaoColmeiaPorUsuario),
        separadores: r.separadoresColmeiaDistintos,
        pendente: r.pendenteFechamento,
      });
      atual.separacao.ranking = atual.separacao.ranking || {};
      atual.separacao.ranking.colmeia = mapParaRanking(r.separacaoColmeiaPorUsuario);
      atual.separacao.ranking.geral = mapParaRanking(r.separacaoColmeiaPorUsuario); // mesclado com checkout no próximo upload
      var serieAnterior = (atual.separacao.seriesDia || []).reduce(function (m, d) { m.set(d.data, d); return m; }, new Map());
      r.porDiaColmeia.forEach(function (valor, data) {
        var dia = serieAnterior.get(data) || { data: data };
        dia.colmeia = valor; serieAnterior.set(data, dia);
      });
      atual.separacao.seriesDia = Array.from(serieAnterior.values()).sort(function (a, b) { return a.data.localeCompare(b.data); });
      await salvarSnapshot("outbound", atual);

      // Pula fica na página de Estoque (setor Gestão de Estoque)
      var atualEstoque = await lerSnapshot("estoque");
      atualEstoque.corte = atualEstoque.corte || {};
      atualEstoque.pula = { totalPeriodo: somaMapa(r.pulaPorUsuario), ranking: mapParaRanking(r.pulaPorUsuario) };
      await salvarSnapshot("estoque", atualEstoque);

      // Mesmas linhas, agora filtradas por prefixo de Local (H/I/J/S) -> Armazenagem
      var r5 = processarKardexEndereco(rows, indice);
      var atual5 = await lerSnapshot("inbound");
      atual5.armazenagem = {
        normal: mapParaRanking(r5.porUsuarioNormal), reversa: mapParaRanking(r5.porUsuarioReversa),
        totalNormal: r5.totalNormal, totalReversa: r5.totalReversa,
      };
      atual5.recebimento = atual5.recebimento || {};
      atual5.recebimento.normal = Object.assign({}, atual5.recebimento.normal, { itensArmazenados: r5.totalNormal });
      atual5.recebimento.reversa = Object.assign({}, atual5.recebimento.reversa, { itensArmazenados: r5.totalReversa });
      await salvarSnapshot("inbound", atual5);

      definirStatus(id, "✓ Kardex processado: Separação/Pula/Pendente (Outbound) + Armazenagem (Inbound).", "ok");
    }

    else if (id === "up-prod-separacao") {
      var rows2 = await parseArquivoGenerico(input.files[0]);
      var r2 = processarProdutividadeSeparacao(rows2);
      var atual2 = await lerSnapshot("outbound");
      atual2.separacao = atual2.separacao || {};
      var rankingColmeiaAtual = (atual2.separacao.ranking && atual2.separacao.ranking.colmeia) || [];
      var mapaColmeia = new Map(rankingColmeiaAtual.map(function (i) { return [i.nome, i.valor]; }));
      var mapaGeral = new Map(mapaColmeia);
      r2.porUsuario.forEach(function (v, k) { mapaGeral.set(k, (mapaGeral.get(k) || 0) + v); });
      atual2.separacao.ranking = atual2.separacao.ranking || {};
      atual2.separacao.ranking.checkout = mapParaRanking(r2.porUsuario);
      atual2.separacao.ranking.geral = mapParaRanking(mapaGeral);
      atual2.separacao.kpis = Object.assign({}, atual2.separacao.kpis, { single: somaMapa(r2.porUsuario) });
      var serieAnterior2 = (atual2.separacao.seriesDia || []).reduce(function (m, d) { m.set(d.data, d); return m; }, new Map());
      r2.porDia.forEach(function (valor, data) {
        var dia = serieAnterior2.get(data) || { data: data };
        dia.checkout = valor; serieAnterior2.set(data, dia);
      });
      atual2.separacao.seriesDia = Array.from(serieAnterior2.values()).sort(function (a, b) { return a.data.localeCompare(b.data); });
      await salvarSnapshot("outbound", atual2);
      definirStatus(id, "✓ Produtividade de Separação processada.", "ok");
    }

    else if (id === "up-conf-checkout") {
      var rows3 = await parseArquivoGenerico(input.files[0]);
      var mapa3 = processarConferenciaCheckout(rows3);
      var atual3 = await lerSnapshot("outbound");
      atual3.conferencia = atual3.conferencia || {};
      atual3.conferencia.confCheckout = mapParaRanking(mapa3);
      atual3.conferencia.totalCheckout = somaMapa(mapa3);
      await salvarSnapshot("outbound", atual3);
      definirStatus(id, "✓ Conferência Checkout/Etiqueta processada.", "ok");
    }

    else if (id === "up-conf-colmeia") {
      var rows4 = await parseArquivoGenerico(input.files[0]);
      var mapa4 = processarConferenciaColmeia(rows4);
      var atual4 = await lerSnapshot("outbound");
      atual4.conferencia = atual4.conferencia || {};
      var lista4 = Array.from(mapa4.entries()).map(function (e) { return { nome: e[0], unitaria: e[1].unitaria, volumes: e[1].volumes }; });
      lista4.sort(function (a, b) { return b.unitaria - a.unitaria; });
      atual4.conferencia.confColmeia = lista4;
      atual4.conferencia.totalColmeiaUnit = lista4.reduce(function (s, x) { return s + x.unitaria; }, 0);
      atual4.conferencia.totalColmeiaVol = lista4.reduce(function (s, x) { return s + x.volumes; }, 0);
      await salvarSnapshot("outbound", atual4);
      definirStatus(id, "✓ Conferência Colmeia processada.", "ok");
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
      await salvarSnapshot("inbound", atual6);

      var r12 = processarVinculacaoReversa(rows6, indice, indicePorPrimeiroNome);
      var atualR2 = await lerSnapshot("reversa");
      atualR2.vinculacao = { totalOR: r12.totalOR, naoIdentificado: r12.naoIdentificado, ranking: mapParaRanking(r12.ranking) };
      await salvarSnapshot("reversa", atualR2);

      definirStatus(id, "✓ Gerenciador de OR processado: Recebimento (Inbound) + Vinculação (Reversa).", "ok");
    }

    else if (id === "up-bipagens" || id === "up-diferenca-local") {
      // Precisa dos dois arquivos juntos — guarda o que já foi lido em memória.
      window.__prodBufferInventario = window.__prodBufferInventario || {};
      var rowsInv = await parseArquivoGenerico(input.files[0]);
      window.__prodBufferInventario[id] = rowsInv;
      var temBip = window.__prodBufferInventario["up-bipagens"];
      var temDif = window.__prodBufferInventario["up-diferenca-local"];
      if (!temBip) { definirStatus(id, "Arquivo lido — falta subir Bipagens também.", "ok"); return; }
      var rInv = processarInventario(temBip, temDif || []);
      var atualE = await lerSnapshot("estoque");
      atualE.inventario = atualE.inventario || {};
      atualE.inventario.kpis = Object.assign({}, atualE.inventario.kpis, {
        bipagens: rInv.bipagens, itensContados: rInv.itensContados, curvaReal: rInv.curvaReal,
        divergenciaGanhos: rInv.divergenciaGanhos, divergenciaPerdas: rInv.divergenciaPerdas,
        // Meta definida fora do WMS (não vem de nenhum arquivo). Padrão: 2,50.
        // Se um valor manual já tiver sido definido pro ciclo, mantém ele.
        curvaEstipulada: (atualE.inventario.kpis && atualE.inventario.kpis.curvaEstipulada) || 2.5,
      });
      atualE.inventario.heatmap = rInv.heatmap;
      await salvarSnapshot("estoque", atualE);
      definirStatus(id, "✓ Inventário atualizado (Bipagens + Diferença por Local).", "ok");
    }

    else if (id === "up-corte-pula-manual") {
      var file7 = input.files[0];
      var pulasRows = await parseXLSXAba(file7, "Pulas - Colmeia");
      var corteRows = await parseXLSXAba(file7, "Corte Físico - Checkout Express");
      var r7 = processarBaseGeralCortePula(pulasRows, corteRows);
      var atual7 = await lerSnapshot("estoque");
      atual7.corte = atual7.corte || {};
      atual7.corte.kpis = Object.assign({}, atual7.corte.kpis, { cortesAtendidos: r7.cortesAtendidos, pulasAtendidos: r7.pulasAtendidos });
      atual7.corte.agressores = Array.from(r7.porColaborador.entries()).map(function (e) { return { nome: e[0], localizado: e[1].localizado, total: e[1].total }; }).sort(function (a, b) { return b.localizado - a.localizado; });
      await salvarSnapshot("estoque", atual7);
      definirStatus(id, "✓ Base Geral Corte/Pula processada.", "ok");
    }

    else if (id === "up-corte-tela") {
      var rows8 = await parseArquivoGenerico(input.files[0]);
      var qtdTela = processarCorteEmTela(rows8);
      var atual8 = await lerSnapshot("estoque");
      atual8.corte = atual8.corte || {};
      atual8.corte.kpis = Object.assign({}, atual8.corte.kpis, { cortesEmTela: qtdTela });
      await salvarSnapshot("estoque", atual8);
      definirStatus(id, "✓ Corte em Tela processado.", "ok");
    }

    else if (id === "up-corte-resolvido") {
      var rows9 = await parseArquivoGenerico(input.files[0]);
      var r9 = processarCorteResolvido(rows9);
      var atual9 = await lerSnapshot("estoque");
      atual9.corte = atual9.corte || {};
      atual9.corte.kpis = Object.assign({}, atual9.corte.kpis, { cortesAceitos: r9.aceitos, cortesNoEndereco: r9.noEndereco });
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
        totalPeriodo: r10.total, single: r10.single, multi: r10.multi,
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

    if (window.recarregarSnapshots) window.recarregarSnapshots();
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
};

})();
