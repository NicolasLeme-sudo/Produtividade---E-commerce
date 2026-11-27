/* Alerta de produção fora dos times (26/11): usuário do WMS que produziu no dia e não está em nenhum time da escalação
   (competicao_times). Manda UM e-mail para EMAIL_TESTE (a caixa do Nicolas, que notifica), com o usuário WMS e as peças — sem nome completo.
   - Limite: ALERTA_MIN_PECAS no .env (padrão 50 peças no dia).
   - Ignora o apoio da liderança: ALERTA_IGNORAR no .env (usuários WMS separados por vírgula).
   - Um aviso por usuário e por dia; se a produção do usuário dobrar depois do aviso, avisa de novo (alertas-enviados.json).
   Chamado no fim de cada rodada pelo robô (robo.js). Nunca derruba a rodada: erro só vai para o log. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");
const D = require("./dados-email");

const ARQ = path.join(__dirname, "alertas-enviados.json");
const PS1 = path.join(__dirname, "enviar-outlook.ps1");
let RB = null;
function regras() {
  if (RB) return RB;
  const ctx = { console: console, Date: Date, Math: Math, JSON: JSON, Map: Map, Set: Set }; ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(D.RAIZ, "regras-black.js"), "utf8"), ctx);
  RB = ctx.RegrasBlack; return RB;
}
function lerArq() { try { return JSON.parse(fs.readFileSync(ARQ, "utf8")); } catch (e) { return {}; } }

async function verificar(cfg, log) {
  if (!cfg.EMAIL_TESTE) return 0;
  const R = regras(), dia = D.diaOperacional(new Date());
  const limite = Number(cfg.ALERTA_MIN_PECAS) || 50;
  const ignorar = new Set(String(cfg.ALERTA_IGNORAR || "").split(",").map(function (x) { return R.chaveUsu(x); }).filter(Boolean));
  const sb = await D.cliente(cfg);
  const snap = (await sb.from("dashboard_snapshots").select("dados").eq("pagina", "outbound").maybeSingle()).data;
  const cad = (await sb.from("competicao_times").select("usuario_wms,nome,turno,time")).data;
  if (!snap || !snap.dados || !cad || !cad.length) return 0;       // sem escalação não dá para saber quem está fora
  const s = snap.dados, fontes = [(s.separacao || {}).checkoutDia, (s.separacao || {}).colmeiaDia, (s.conferencia || {}).confCheckoutDia, (s.conferencia || {}).confColmeiaUnitDia];
  const prod = {};
  fontes.forEach(function (f) {
    (f || []).filter(function (x) { return String(x.data).slice(0, 10) === dia; }).forEach(function (x) {
      Object.keys(x.itens || {}).forEach(function (u) { const k = R.chaveUsu(u); prod[k] = (prod[k] || 0) + (x.itens[u] || 0); });
    });
  });
  const escalados = new Set();
  // mesmas chaves que a Corrida usa para casar membro e produção (regras-black.js chavesDoMembro: usuário, nome e variações nome.sobrenome)
  const CONECT = ["DE", "DA", "DO", "DAS", "DOS", "E"];
  cad.forEach(function (r) {
    escalados.add(R.chaveUsu(r.usuario_wms)); escalados.add(R.chaveUsu(r.nome));
    const t = R.chaveUsu(r.nome).split(/\s+/).filter(function (x) { return x && CONECT.indexOf(x) === -1; });
    if (t.length > 1) { t.slice(1).forEach(function (x) { escalados.add(t[0] + "." + x); }); if (t.length > 2) escalados.add(t[0] + "." + t[1].charAt(0) + "." + t[t.length - 1]); }
  });
  const estado = lerArq(), feitos = estado[dia] || (estado[dia] = {});
  const novos = Object.keys(prod).filter(function (k) {
    if (prod[k] < limite || escalados.has(k) || ignorar.has(k)) return false;
    return !feitos[k] || prod[k] >= feitos[k] * 2;
  }).sort(function (a, b) { return prod[b] - prod[a]; });
  if (!novos.length) return 0;
  const linhas = novos.map(function (k) { return "<tr><td style=\"padding:2px 10px\">" + k + "</td><td style=\"padding:2px 10px;text-align:right\">" + prod[k] + " peças</td></tr>"; }).join("");
  const html = "<p>Usuários do WMS que <b>produziram hoje e não estão em nenhum time</b> da escalação:</p><table style=\"border-collapse:collapse\">" + linhas + "</table>" +
    "<p>Se for alguém que está usando o usuário de outra pessoa, ou um colaborador que faltou lançar no time, ajuste a escalação no Admin. (Aviso automático do robô, limite " + limite + " peças.)</p>";
  const arq = path.join(require("os").tmpdir(), "alerta-robo-" + Date.now() + ".json");
  fs.writeFileSync(arq, JSON.stringify({ para: cfg.EMAIL_TESTE, assunto: "Alerta Black · " + novos.length + " usuário(s) produzindo fora dos times", html: html }), "utf8");
  try {
    const r = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1, "-Arquivo", arq], { encoding: "utf8", timeout: 120000, windowsHide: true });
    if (!/OK/.test(r)) throw new Error(String(r).trim().split("\n")[0]);
  } catch (e) { log("   ERRO ao enviar o alerta de produção fora dos times: " + String(e.message).split("\n")[0]); return 0; }
  finally { try { fs.unlinkSync(arq); } catch (x) {} }
  novos.forEach(function (k) { feitos[k] = prod[k]; });
  Object.keys(estado).sort().slice(0, -7).forEach(function (d) { delete estado[d]; });
  fs.writeFileSync(ARQ, JSON.stringify(estado, null, 1));
  log("   alerta enviado: " + novos.length + " usuário(s) fora dos times (" + novos.slice(0, 5).join(", ") + ")");
  return novos.length;
}

module.exports = { verificar: verificar };
