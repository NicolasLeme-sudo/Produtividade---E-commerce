@echo off
REM Liga o robô do telão. Antes de cada partida baixa a versão nova do GitHub.
REM O robô se reinicia sozinho a cada 6 h, e aí este laço atualiza de novo.
chcp 65001 >nul
cd /d "%~dp0"
title Robo do Telao
:inicio
echo.
echo === %date% %time% - atualizando do GitHub ===
git pull origin main
call npm.cmd install --no-audit --no-fund
echo === ligando o robo ===
node robo.js
echo Robo parou. Reiniciando em 10 segundos (feche esta janela para desligar)...
timeout /t 10 /nobreak >nul
goto inicio
