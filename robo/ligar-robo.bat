@echo off
REM Liga o robô do telão. Ele fica rodando até você desligar:
REM   feche esta janela, aperte Ctrl+C nela ou dê duplo clique em desligar-robo.bat.
REM Antes de ligar, baixa a versão nova do GitHub.
chcp 65001 >nul
cd /d "%~dp0"
title Robo do Telao
REM "ligar-robo.bat agendado" (tarefa do Agendador): só liga de seg a sex a partir das 04h55, ou até 00h30 da madrugada seguinte (fim do 2º turno, 00h16).
if /I "%~1"=="agendado" (
  powershell -NoProfile -Command "$d = Get-Date; $h = $d.TimeOfDay; $dia = [int]$d.DayOfWeek; $ok = (($dia -ge 1 -and $dia -le 5) -and $h -ge [TimeSpan]'04:55') -or (($dia -ge 2 -and $dia -le 6) -and $h -lt [TimeSpan]'00:30'); if (-not $ok) { exit 1 }"
  if errorlevel 1 (
    echo Fora do horario agendado (seg a sex, 05h00 ate 00h30 do dia seguinte^): robo nao ligado.
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
REM 3 = já tinha um robô rodando: fecha esta janela sem esperar tecla
if errorlevel 3 if not errorlevel 4 exit /b
if /I "%~1"=="escondido" exit /b
echo.
echo Robo desligado. Para ligar de novo: duplo clique em ligar-robo.bat
pause
