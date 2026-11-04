@echo off
REM Liga o robô do telão. Ele fica rodando até você desligar:
REM   feche esta janela, aperte Ctrl+C nela ou dê duplo clique em desligar-robo.bat.
REM Antes de ligar, baixa a versão nova do GitHub.
chcp 65001 >nul
cd /d "%~dp0"
title Robo do Telao
REM "ligar-robo.bat agendado" (tarefa do Agendador): só liga de segunda a sexta, das 07h50 às 17h33.
if /I "%~1"=="agendado" (
  powershell -NoProfile -Command "$d = Get-Date; if ($d.DayOfWeek -eq 'Saturday' -or $d.DayOfWeek -eq 'Sunday' -or $d.TimeOfDay -lt [TimeSpan]'07:50' -or $d.TimeOfDay -gt [TimeSpan]'17:33') { exit 1 }"
  if errorlevel 1 (
    echo Fora do horario agendado (seg a sex, 07h55 as 17h33^): robo nao ligado.
    timeout /t 8 >nul
    exit /b
  )
)
echo === %date% %time% - atualizando do GitHub ===
git pull origin main
call npm.cmd install --no-audit --no-fund
title Robo do Telao
echo === robo ligado (feche esta janela para desligar) ===
node robo.js
if /I "%~1"=="escondido" exit /b
echo.
echo Robo desligado. Para ligar de novo: duplo clique em ligar-robo.bat
pause
