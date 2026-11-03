@echo off
REM Liga o robô do telão. Ele fica rodando até você desligar:
REM   feche esta janela, aperte Ctrl+C nela ou dê duplo clique em desligar-robo.bat.
REM Antes de ligar, baixa a versão nova do GitHub.
chcp 65001 >nul
cd /d "%~dp0"
title Robo do Telao
echo === %date% %time% - atualizando do GitHub ===
git pull origin main
call npm.cmd install --no-audit --no-fund
echo === robo ligado (feche esta janela para desligar) ===
node robo.js
echo.
echo Robo desligado. Para ligar de novo: duplo clique em ligar-robo.bat
pause
