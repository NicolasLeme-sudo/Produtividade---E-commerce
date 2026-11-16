@echo off
REM Liga o robo do telao. Ele fica rodando ate voce desligar:
REM   feche esta janela, aperte Ctrl+C nela ou de duplo clique em desligar-robo.bat.
REM Antes de ligar, baixa a versao nova do GitHub.
chcp 65001 >nul
cd /d "%~dp0"
title Robo do Telao
REM "ligar-robo.bat agendado" (tarefa do Agendador): liga a qualquer hora; o robo fica ligado 24 h
REM (fora do horario de operacao so atualiza Acompanhamento OP e Itens de NF). Se ja estiver rodando, nao abre outro.
echo === %date% %time% - atualizando do GitHub ===
git pull origin main
call npm.cmd install --no-audit --no-fund
title Robo do Telao
echo === robo ligado (feche esta janela para desligar) ===
node robo.js
REM 3 = ja tinha um robo rodando: fecha esta janela sem esperar tecla
if errorlevel 3 if not errorlevel 4 exit /b
if /I "%~1"=="escondido" exit /b
echo.
echo Robo desligado. Para ligar de novo: duplo clique em ligar-robo.bat
pause
