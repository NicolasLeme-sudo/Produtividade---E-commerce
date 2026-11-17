# Envia um e-mail pelo Outlook do notebook, sem abrir janela.
# Uso:  powershell -NoProfile -ExecutionPolicy Bypass -File enviar-outlook.ps1 -Arquivo <json>
# O JSON (UTF-8) tem: { "para": "...", "assunto": "...", "html": "..." }
param([Parameter(Mandatory = $true)][string]$Arquivo)

$ErrorActionPreference = 'Stop'
try {
  $txt = [System.IO.File]::ReadAllText($Arquivo, [System.Text.Encoding]::UTF8)
  $msg = $txt | ConvertFrom-Json
  if (-not $msg.para)    { throw 'sem destinatario' }
  if (-not $msg.assunto) { throw 'sem assunto' }

  $ol = New-Object -ComObject Outlook.Application     # Outlook classico; nao mostra janela
  $mail = $ol.CreateItem(0)                           # 0 = olMailItem
  $mail.To = $msg.para
  $mail.Subject = $msg.assunto
  $mail.HTMLBody = $msg.html
  $mail.Send()
  'OK'
} catch {
  "FALHOU: $($_.Exception.Message)"
  exit 1
}
