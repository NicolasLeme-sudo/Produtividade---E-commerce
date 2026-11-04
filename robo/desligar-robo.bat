@echo off
REM Desliga o robô do telão: fecha o robô, o Chrome escondido dele e a janela preta do ligar-robo.bat.
REM (Procura pelos comandos de cada processo, não pelo título: no Windows 11 a janela fica no Terminal
REM e o título muda.) O Chrome com janela pode ficar aberto: ao ligar de novo, ele reaproveita as abas.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'robo\.js|baixar\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -match 'ChromeRobo' -and $_.CommandLine -match '--headless' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -match '\\ligar-robo\.bat' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo Robo desligado.
ping -n 4 127.0.0.1 >nul
