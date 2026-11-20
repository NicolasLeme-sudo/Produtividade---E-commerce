@echo off
REM Grava os cliques no WMS para eu montar a captura de um relatorio novo (ex.: as telas de Corte).
REM Abre um Chrome do gravador e a janela "Playwright Inspector": entre no WMS, va ate a tela, ajuste os filtros e
REM exporte o .tsv; tudo que voce clicar fica anotado. Ao terminar, feche o Chrome: o arquivo robo\gravacao.js fica pronto.
REM gravacao.js tem login e senha do WMS: fica fora do Git (robo\.gitignore). A gravacao anterior vai para gravacao-anterior.js.
REM Nao mexe no Chrome do robo: o gravador abre um Chrome separado, com perfil proprio.
chcp 65001 >nul
cd /d "%~dp0"
title Gravador do WMS
if exist gravacao.js copy /y gravacao.js gravacao-anterior.js >nul
echo Abrindo o gravador do WMS... feche o Chrome quando terminar.
call npm.cmd run gravar
echo.
if exist gravacao.js echo Gravacao salva em %~dp0gravacao.js
pause
