@echo off
REM Desliga o robô do telão (fecha a janela "Robo do Telao" ou o robô escondido).
REM O Chrome escondido do robô (sem janela) também fecha. O Chrome com janela pode ficar aberto:
REM ao ligar de novo, ele reaproveita as abas do WMS.
taskkill /FI "WINDOWTITLE eq Robo do Telao*" /T /F >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'robo\.js|baixar\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -match 'ChromeRobo' -and $_.CommandLine -match '--headless' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }"
echo Robo desligado.
timeout /t 3 >nul
