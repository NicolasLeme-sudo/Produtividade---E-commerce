@echo off
REM Desliga o robô do telão (fecha a janela "Robo do Telao"). A janela do Chrome do robô pode ficar aberta:
REM ao ligar de novo, ele reaproveita as abas do WMS.
taskkill /FI "WINDOWTITLE eq Robo do Telao*" /T /F >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'robo\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo Robo desligado.
timeout /t 3 >nul
