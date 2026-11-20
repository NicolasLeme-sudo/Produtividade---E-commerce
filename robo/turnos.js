/* Cadastro de turno por usuário do WMS, a partir da lista de Ativos do RH.
   Uso:  node turnos.js                                         (lê a Base de Ativos do banco, a que o Admin do Produtividade atualiza)
         node turnos.js "C:\Leitura de Arquivos\Ativos 17.11.xlsx"   (lê a planilha do RH direto)
   O robô lê a Base de Ativos sozinho (dados-email.js · atualizarCadastro, a cada 10 min): processou uma lista nova no Admin,
   o próximo e-mail já usa. Este script grava robo/turnos-wms.json (fora do Git: tem nome de colaborador), o cadastro de
   partida do robô e o que vale se o banco não responder. Sem cadastro nenhum, o turno sai do horário da produção (turnoDaPessoa).
   O WMS não tem o nome completo: o casamento é "primeiro nome + um sobrenome" (NOME.SOBRENOME).
   O cadastro leva TODOS os NOME.SOBRENOME da lista, tenha a pessoa aparecido na produção ou não: quem passa a produzir
   depois de a lista ser gerada já casa. (Até 19/11 só entrava quem já tinha aparecido na produção, e a GEORGETE.DIAS, do ADM,
   caiu no e-mail do Inbound T02: ela só produziu às 15h e 16h e o horário parecia de 2º turno.)
   O mesmo NOME.SOBRENOME em turnos diferentes na lista (homônimos) fica de fora e segue pelo horário da produção.
   Usuário abreviado, colado ou com grafia parecida (JAQUE.SANTANA, MARIA.FRAN.SILVA, ANA.B.SILVA, ANAPINHEIRO, SANIELI.SILVA)
   casa pela lista do RH em casarAbreviado, só quando todos os que combinam são do mesmo turno. */
"use strict";
const fs = require("fs");
const path = require("path");

const ARQ = path.join(__dirname, "turnos-wms.json");
const CONECTIVOS = ["DA", "DE", "DO", "DAS", "DOS", "E"];
const MAPA_TURNO = { "1º TURNO": "T01", "1O TURNO": "T01", "2º TURNO": "T02", "2O TURNO": "T02", "ADM": "ADM" };
const JANELA_CARGA = 30 * 60 * 1000;   // as linhas de uma mesma planilha entram na base com milissegundos de diferença

function normalizar(t) {
  return String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9º\s]/g, " ").replace(/\s+/g, " ").trim();
}
function tokens(nome) {
  return normalizar(nome).split(" ").filter(function (t) { return t && CONECTIVOS.indexOf(t) === -1; });
}
function candidatos(nome) {
  const tk = tokens(nome);
  if (tk.length < 2) return tk;
  const c = [];
  for (var i = 1; i < tk.length; i++) c.push(tk[0] + "." + tk[i]);
  return c;
}

// linhas = [{ nome, turno (o "Horário" do RH), em (opcional: quando a linha entrou na base) }]
// -> { mapa: { NOME.SOBRENOME: "T01" | "T02" | "ADM" }, homonimos, pessoas (quantas têm turno), lista (todas, para casarAbreviado) }
// A base guarda também gente de cargas antigas (quem saiu e não veio na lista nova): a carga mais recente manda e as
// linhas antigas só preenchem o que ela não tem. Assim uma lista parcial não esvazia o cadastro.
function montarDeLinhas(linhas) {
  const tempos = linhas.map(function (l) { return l.em ? Date.parse(l.em) : NaN; }).filter(function (n) { return isFinite(n); });
  const corte = tempos.length ? Math.max.apply(null, tempos) - JANELA_CARGA : -Infinity;
  const antiga = function (l) { return !!(l.em && Date.parse(l.em) < corte); };
  const grupos = { atual: {}, antigo: {} };              // candidato -> { turno: quantas pessoas }
  let pessoas = 0;
  linhas.forEach(function (l) {
    const turno = MAPA_TURNO[normalizar(l.turno)];
    if (!turno) return;                                  // 3º turno e cargo de confiança ficam de fora
    pessoas++;
    const g = grupos[antiga(l) ? "antigo" : "atual"];
    candidatos(l.nome).forEach(function (c) { const d = g[c] || (g[c] = {}); d[turno] = (d[turno] || 0) + 1; });
  });
  const chaves = Object.keys(grupos.atual).concat(Object.keys(grupos.antigo).filter(function (c) { return !grupos.atual[c]; })).sort();
  const mapa = {}, homonimos = [];
  chaves.forEach(function (c) {
    const ts = Object.keys(grupos.atual[c] || grupos.antigo[c]);
    if (ts.length === 1) mapa[c] = ts[0]; else homonimos.push(c);   // dois turnos para o mesmo NOME.SOBRENOME: não dá para saber de quem é
  });
  // todas as pessoas (até as sem turno de 1º/2º/ADM, que entram como "-"), para o casamento de nome abreviado
  const lista = linhas.map(function (l) { return { t: tokens(l.nome), turno: MAPA_TURNO[normalizar(l.turno)] || "-", atual: !antiga(l), nome: l.nome }; })
    .filter(function (p) { return p.t.length; });
  return { mapa: mapa, homonimos: homonimos, pessoas: pessoas, lista: lista };
}

// O usuário do WMS às vezes vem abreviado ("JAQUE.SANTANA", "MARIA.FRAN.SILVA", "ANA.B.SILVA"), colado ("ANAPINHEIRO") ou com
// grafia parecida ("SANIELI" para SANIELE). Procura na lista do RH quem pode ser: 1º nome igual, abreviado (4+ letras) ou com a
// mesma pronúncia; as partes do meio são começos de nomes do meio, em ordem; a última é um sobrenome inteiro.
function acharAbreviado(usuario, lista) {
  const partes = normalizar(String(usuario).replace(/,/g, ".").replace(/\./g, " ")).split(" ").filter(Boolean);
  if (!partes.length) return [];
  const fon = function (t) { return t.replace(/Y/g, "I").replace(/Z/g, "S").replace(/(.)\1/g, "$1").replace(/(.{4,})E$/, "$1I"); };
  const achados = lista.filter(function (p) {
    if (partes.length === 1) {                           // nome colado: 1º nome + um sobrenome
      for (var i = 1; i < p.t.length; i++) if (p.t[0] + p.t[i] === partes[0]) return true;
      return false;
    }
    const a = partes[0], b = p.t[0];
    if (!(a === b || (a.length >= 4 && b.indexOf(a) === 0) || fon(a) === fon(b))) return false;
    var pos = 0;
    for (var j = 1; j < partes.length; j++) {
      const ultima = j === partes.length - 1;
      var ok = false;
      for (var k = pos + 1; k < p.t.length; k++) {
        if (ultima ? p.t[k] === partes[j] : p.t[k].indexOf(partes[j]) === 0) { pos = k; ok = true; break; }
      }
      if (!ok) return false;
    }
    return true;
  });
  const atuais = achados.filter(function (p) { return p.atual; });   // a carga mais recente manda
  return atuais.length ? atuais : achados;
}
// -> "T01" | "T02" | "ADM" quando todos os que combinam são do mesmo turno; senão null (segue pelo horário da produção)
function casarAbreviado(usuario, lista) {
  const ts = {};
  acharAbreviado(usuario, lista).forEach(function (p) { ts[p.turno] = 1; });
  const k = Object.keys(ts);
  return k.length === 1 && k[0] !== "-" ? k[0] : null;
}

// Base de Ativos do banco (base_ativos): o Admin do Produtividade grava lá a planilha do RH.
async function linhasDoBanco(sb) {
  const q = await sb.from("base_ativos").select("nome, turno, atualizado_em").limit(5000);
  if (q.error) throw new Error("base_ativos: " + q.error.message);
  return (q.data || []).map(function (l) { return { nome: l.nome, turno: l.turno, em: l.atualizado_em }; });
}
// Planilha do RH (.xlsx), colunas Nome e Horário
function linhasDaPlanilha(arquivo) {
  const X = require("xlsx");
  const wb = X.readFile(arquivo);
  return X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" }).map(function (l) { return { nome: l["Nome"], turno: l["Horario"] || l["Horário"] }; });
}
module.exports = { montarDeLinhas: montarDeLinhas, casarAbreviado: casarAbreviado, acharAbreviado: acharAbreviado, linhasDoBanco: linhasDoBanco,
  linhasDaPlanilha: linhasDaPlanilha, ARQ: ARQ,
  ler: function () { try { return JSON.parse(fs.readFileSync(ARQ, "utf8")).turnos || {}; } catch (e) { return {}; } } };

if (require.main === module) {
  const arquivo = process.argv[2];
  (async function () {
    const E = require("./email");
    const D = require("./dados-email");
    const cfg = require("./robo").lerEnv();
    const sb = await D.cliente(cfg);
    const linhas = arquivo ? linhasDaPlanilha(arquivo) : await linhasDoBanco(sb);
    const r = montarDeLinhas(linhas);
    const q = await sb.from("dashboard_snapshots").select("pagina, dados").in("pagina", ["outbound", "inbound", "operacao"]);
    if (q.error) throw q.error;
    const pg = {}; (q.data || []).forEach(function (l) { pg[l.pagina] = l.dados || {}; });
    // todos os usuários que já apareceram na produção (qualquer dia guardado): só para o relatório de quem ficou sem cadastro
    const usuarios = new Set();
    const addMapa = function (m) { Object.keys(m || {}).forEach(function (u) { usuarios.add(E.usuarioDaChave(u).replace(/,/g, ".").toUpperCase()); }); };
    [((pg.outbound || {}).separacao || {}).analitico, ((pg.outbound || {}).conferencia || {}).analitico].forEach(function (lista) {
      (lista || []).forEach(function (d) { ["checkout", "colmeia"].forEach(function (t) { addMapa(d[t]); }); });
    });
    (((pg.outbound || {}).conferencia || {}).colmeiaMarcas || []).forEach(function (d) { (d.marcas || []).forEach(function (mk) { addMapa(mk[1]); }); });
    ((((pg.inbound || {}).armazenagem || {}).normalUsuHoraDia) || []).forEach(function (d) { addMapa(d.itens); });
    Object.keys(((pg.operacao || {}).expNfs) || {}).forEach(function (dia) {
      const nfs = pg.operacao.expNfs[dia] || {};
      Object.keys(nfs).forEach(function (id) { if (nfs[id]) addMapa({ [nfs[id][0]]: 1 }); });
    });
    // quem não tem NOME.SOBRENOME exato mas casa pela abreviação entra no arquivo de reserva também
    const vistos = Array.from(usuarios), mapaArq = Object.assign({}, r.mapa), porAbrev = [], sem = [];
    vistos.filter(function (u) { return !r.mapa[u]; }).forEach(function (u) {
      const t = casarAbreviado(u, r.lista);
      if (t) { mapaArq[u] = t; porAbrev.push(u + " → " + t); }
      else {
        const ach = acharAbreviado(u, r.lista), ts = Array.from(new Set(ach.map(function (p) { return p.turno; })));
        sem.push(u + (ach.length ? " (" + (ts.length > 1 ? "mais de um nome na lista, turnos diferentes" : ts[0] === "-" ? "sem turno fixo na lista" : "?") + ")" : " (não está na lista)"));
      }
    });
    fs.writeFileSync(ARQ, JSON.stringify({ origem: arquivo ? path.basename(arquivo) : "base_ativos", em: new Date().toISOString(), turnos: mapaArq }, null, 1), "utf8");
    const exatos = vistos.filter(function (u) { return r.mapa[u]; });
    const c = {}; exatos.forEach(function (u) { c[r.mapa[u]] = (c[r.mapa[u]] || 0) + 1; });
    console.log("Fonte: " + (arquivo ? path.basename(arquivo) : "Base de Ativos (banco)") + " · " + linhas.length + " linhas · " + r.pessoas + " pessoas com turno (1º, 2º, ADM) · " +
      Object.keys(r.mapa).length + " NOME.SOBRENOME no cadastro" + (r.homonimos.length ? " · de fora por homônimo em turnos diferentes: " + r.homonimos.join(", ") : ""));
    console.log("Usuários vistos na produção: " + vistos.length + " · com NOME.SOBRENOME no cadastro: " + exatos.length + " (" + Object.keys(c).sort().map(function (k) { return k + " " + c[k]; }).join(" · ") + ")");
    console.log("Casados por nome abreviado/colado/grafia parecida: " + porAbrev.length + (porAbrev.length ? " → " + porAbrev.join(", ") : ""));
    console.log("Sem turno no cadastro (seguem pelo horário da produção): " + sem.length + (sem.length ? " → " + sem.join(", ") : ""));
    console.log("Arquivo: " + ARQ);
    process.exit(0);
  })().catch(function (e) { console.error("FALHOU: " + e.message); process.exit(1); });
}
