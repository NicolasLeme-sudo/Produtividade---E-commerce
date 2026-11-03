/* Gera os PDFs A4 para imprimir (checklist da vistoria e regras/pontuação) com o Google Chrome.
   Uso (na raiz do repositório): node docs/black/gerar-pdfs.js "C:\Entrega de Arquivos"
   Usa o Playwright instalado na pasta robo/. */
"use strict";
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require(path.join(__dirname, "..", "..", "robo", "node_modules", "playwright"));

const destino = process.argv[2] || ".";
const ARQUIVOS = [["checklist-vistoria.html", "Checklist_Vistoria.pdf"], ["regras.html", "Regras_e_Pontuacao.pdf"]];

(async function () {
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  for (const [html, pdf] of ARQUIVOS) {
    await page.goto(pathToFileURL(path.join(__dirname, html)).href, { waitUntil: "load" });
    await page.waitForTimeout(300);
    await page.pdf({ path: path.join(destino, pdf), format: "A4", printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    console.log("ok", pdf);
  }
  await browser.close();
})().catch(function (e) { console.error(e.message); process.exit(1); });
