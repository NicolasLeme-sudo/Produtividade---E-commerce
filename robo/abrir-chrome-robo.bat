@echo off
REM Abre o Google Chrome que o robô usa para baixar os relatórios do WMS.
REM Deixe esta janela do Chrome aberta; pode minimizar. Não feche as abas do WMS.
REM (O Chrome só deixa o robô controlar uma janela com perfil separado, por isso a pasta ChromeRobo.)
REM Os --disable-background... mantêm as abas do WMS funcionando com a janela minimizada.
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\ChromeRobo" --no-first-run --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding https://vulcaprd.seniorcloud.com.br/siltwms/
