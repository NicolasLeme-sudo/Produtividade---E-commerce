/* =========================================================================
   ENVIO DOS E-MAILS — canais do Teams, pelo Outlook do notebook
   -------------------------------------------------------------------------
   Cada canal do Teams tem um endereço de e-mail (CANAL_* no .env). O robô
   chama verificar() no fim de cada rodada; aqui se decide o que já está na
   hora de mandar e o que já foi mandado (emails-enviados.json).

   Horários (minutos do DIA OPERACIONAL: 00h–01h conta como 1440+):

     Outbound · T01   hora em hora 06h05 → 14h05   · fechamento do turno 14h38
     Outbound · T02   hora em hora 16h05 → 00h05   · fechamento do turno 00h06
     Inbound · ADM    hora em hora 09h05 → 17h05   · fechamento do turno 17h23
     Inbound · T02    hora em hora 16h05 → 00h05   · fechamento do turno 00h06
     Fechamento       só o do dia, 00h25 (Outbound e Inbound, com a coluna Turno)

   O fechamento de turno sai uns 10 min antes do turno acabar, de propósito:
   o líder recebe com o turno ainda em pé.

   Uso à mão:
     node enviar-email.js --teste              (monta tudo e manda só para EMAIL_TESTE)
     node enviar-email.js --teste out-t01      (só um bloco)
     node enviar-email.js --ensaio             (o que iria para os canais AGORA, mas só para EMAIL_TESTE)
     node enviar-email.js --agora              (manda de verdade o que estiver na hora)
   ========================================================================= */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const E = require("./email");
const D = require("./dados-email");

const ARQ_ESTADO = path.join(__dirname, "emails-enviados.json");
const PS1 = path.join(__dirname, "enviar-outlook.ps1");

// minutos do dia operacional em que cada bloco fala
// O fechamento tem JANELA, não minuto fixo: { de, ate }. Ele sai assim que a rodada daquela
// janela termina (dado o mais fresco possível) e, se a rodada atrasar, sai no "ate" de qualquer
// jeito. O líder recebe antes de bater o ponto mesmo com o WMS lento (17/11).
const AGENDA = {
  // A coleta do fechamento começa o mais tarde possível, para não parar o time cedo demais
  // (pedido de 17/11): Outbound 14h38 e 00h05 · ADM 17h20. A rodada leva ~6 min e o e-mail sai no fim dela.
  "out-t01": { horas: [365, 845], fech: { de: 878, ate: 887 } },     // 06h05→14h05 · coleta 14h38, limite 14h47
  "out-t02": { horas: [965, 1385], fech: { de: 1445, ate: 1455 } },  // 16h05→23h05 · coleta 00h05, limite 00h15
  "in-adm":  { horas: [545, 1025], fech: { de: 1040, ate: 1050 } },  // 09h05→17h05 · coleta 17h20, limite 17h30
  "in-t02":  { horas: [965, 1385], fech: { de: 1445, ate: 1455 } },  // 16h05→23h05 · coleta 00h05, limite 00h15
  "fech-dia-out": { soDia: { de: 1460, ate: 1470 } },                // dia inteiro, entre 00h20 e 00h30
  "fech-dia-in":  { soDia: { de: 1460, ate: 1470 } }
};
const TOLERANCIA = 45;   // minutos: passou disso, não manda atrasado (robô desligado, por exemplo)

function minutoOperacional(d) {
  d = d || new Date();
  const m = d.getHours() * 60 + d.getMinutes();
  return d.getHours() < 1 ? m + 1440 : m;          // 00h–01h ainda é o dia anterior
}
function hhmm(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, "0") + "h" + String(m % 60).padStart(2, "0");
}
function lerEstado() { try { return JSON.parse(fs.readFileSync(ARQ_ESTADO, "utf8")); } catch (e) { return {}; } }
function salvarEstado(e) { try { fs.writeFileSync(ARQ_ESTADO, JSON.stringify(e, null, 1)); } catch (x) {} }

// O que está na hora de mandar agora: [{ bloco, chave, fech, horaTexto }]
// fimDeRodada = a chamada veio logo depois de uma rodada completa do robô (dado novo no banco).
function pendentes(blocos, minAgora, feitos, fimDeRodada) {
  const saida = [];
  // dentro da janela: manda no fim da rodada; no limite da janela, manda de qualquer jeito
  const naHora = function (j) { return minAgora >= j.de && minAgora < j.ate + TOLERANCIA && (fimDeRodada || minAgora >= j.ate); };
  blocos.forEach(function (b) {
    const ag = AGENDA[b.grupo || b.id];
    if (!ag) return;
    if (ag.soDia != null) {
      if (naHora(ag.soDia) && !feitos[b.id + "|dia"]) {
        saida.push({ bloco: b, chave: b.id + "|dia", fech: 1, horaTexto: "dia encerrado" });
      }
      return;
    }
    // fechamento do turno tem prioridade sobre a hora cheia
    if (naHora(ag.fech) && !feitos[b.id + "|fech"]) {
      saida.push({ bloco: b, chave: b.id + "|fech", fech: 1, horaTexto: "fechamento do turno" });
      return;
    }
    if (minAgora >= ag.fech.de) return;   // janela do fechamento aberta: não manda mais a hora cheia
    // hora em hora: só o slot vigente (se o robô ficou fora, não dispara os atrasados de uma vez)
    const ini = ag.horas[0], fim = ag.horas[1];
    if (minAgora < ini || minAgora > fim + TOLERANCIA) return;
    const slot = Math.min(fim, ini + Math.floor((minAgora - ini) / 60) * 60);
    if (minAgora - slot >= TOLERANCIA) return;
    const chave = b.id + "|h" + slot;
    if (!feitos[chave]) saida.push({ bloco: b, chave: chave, horaTexto: "até " + hhmm(slot - 5) });
  });
  return saida;
}

function totalDoBloco(b) {
  return b.tabelas.reduce(function (s, x) {
    return s + Object.keys(x[1] || {}).reduce(function (a, u) {
      return a + (x[1][u] || []).reduce(function (c, v) { return c + (v || 0); }, 0);
    }, 0);
  }, 0);
}

// Manda pelo Outlook (sem janela). Devolve true/false.
function mandar(para, assunto, html, log) {
  const arq = path.join(require("os").tmpdir(), "email-robo-" + Date.now() + ".json");
  fs.writeFileSync(arq, JSON.stringify({ para: para, assunto: assunto, html: html }), "utf8");
  try {
    const r = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1, "-Arquivo", arq],
      { encoding: "utf8", timeout: 120000, windowsHide: true });
    if (!/OK/.test(r)) throw new Error(String(r).trim().split("\n")[0]);
    return true;
  } catch (e) {
    log("   ERRO ao enviar \"" + assunto.slice(0, 50) + "\": " + String(e.message).split("\n")[0]);
    return false;
  } finally { try { fs.unlinkSync(arq); } catch (x) {} }
}

/* ---------------- o que o robô chama no fim de cada rodada ---------------- */
async function verificar(cfg, log, opcoes) {
  opcoes = opcoes || {};
  const agora = opcoes.agora || new Date();
  const dia = D.diaOperacional(agora), minAgora = minutoOperacional(agora);
  const estado = lerEstado(), feitos = estado[dia] || (estado[dia] = {});
  const blocos0 = Object.keys(AGENDA);
  // nada na agenda para este minuto: nem abre o banco
  if (!opcoes.forcar && !blocos0.some(function (id) {
    const ag = AGENDA[id];
    if (ag.soDia != null) return minAgora >= ag.soDia.de && minAgora < ag.soDia.ate + TOLERANCIA;
    return minAgora >= ag.horas[0] && minAgora <= ag.fech.ate + TOLERANCIA;
  })) return 0;

  const sb = opcoes.sb || await D.cliente(cfg);
  const t = await D.carregar(sb, dia, cfg.EXCLUIR_USUARIOS);
  const blocos = E.blocos(t);
  const lista = opcoes.forcar ? opcoes.forcar(blocos) : pendentes(blocos, minAgora, feitos, opcoes.fimDeRodada);
  let n = 0;
  for (const item of lista) {
    const b = item.bloco;
    const total = totalDoBloco(b);
    if (!total && !item.fech) continue;                     // sem produção ainda: não manda e-mail vazio
    const para = opcoes.para || cfg["CANAL_" + b.canal];
    if (!para) { log("   sem endereço de canal para " + b.id + " (CANAL_" + b.canal + " no .env)"); continue; }
    const assunto = E.assuntoDe(b, dia);
    const html = E.corpoEmail(b, dia, item.fech, item.horaTexto);
    if (mandar(para, assunto, html, log)) {
      n++;
      log("   e-mail enviado: " + b.tit + " · " + item.horaTexto + " · " + E.fmt(total) + " peças" +
        (item.fech ? " · às " + new Date().toLocaleTimeString("pt-BR") : ""));
      if (!opcoes.para && !opcoes.semRegistro) { feitos[item.chave] = new Date().toISOString(); salvarEstado(estado); }
    }
  }
  // guarda só os 7 dias mais recentes
  Object.keys(estado).sort().slice(0, -7).forEach(function (d) { delete estado[d]; });
  salvarEstado(estado);
  return n;
}

module.exports = { verificar: verificar, AGENDA: AGENDA, minutoOperacional: minutoOperacional, pendentes: pendentes };

/* ---------------- uso à mão ---------------- */
if (require.main === module) {
  const robo = require("./robo");
  const cfg = robo.lerEnv();
  const teste = process.argv.includes("--teste");
  const ensaio = process.argv.includes("--ensaio");   // agenda de verdade, destino de teste
  const soEste = process.argv[process.argv.indexOf("--teste") + 1];
  const dia = (process.argv.find(function (a) { return /^\d{4}-\d{2}-\d{2}$/.test(a); }) || "");
  const opcoes = {};
  if (dia) opcoes.agora = new Date(dia + "T23:59:00");
  if (ensaio) {
    opcoes.para = cfg.EMAIL_TESTE;
    if (!opcoes.para) { console.error("Preencha EMAIL_TESTE no .env"); process.exit(1); }
  }
  if (teste) {
    // --teste <id> --canal: manda no canal de verdade (CANAL_*), sem registrar como enviado
    const paraCanal = process.argv.includes("--canal");
    opcoes.semRegistro = true;
    if (!paraCanal) {
      opcoes.para = cfg.EMAIL_TESTE;
      if (!opcoes.para) { console.error("Preencha EMAIL_TESTE no .env"); process.exit(1); }
    }
    opcoes.forcar = function (blocos) {
      return blocos.filter(function (b) { return !soEste || soEste === b.id || soEste === b.grupo; })
        .map(function (b) { return { bloco: b, chave: b.id, fech: !!AGENDA[b.grupo || b.id].soDia, horaTexto: "teste" }; });
    };
  }
  verificar(cfg, console.log, opcoes)
    .then(function (n) { console.log(n + " e-mail(s) enviado(s)" + (opcoes.para ? " para " + opcoes.para : "")); process.exit(0); })
    .catch(function (e) { console.error("FALHOU: " + e.message); process.exit(1); });
}
