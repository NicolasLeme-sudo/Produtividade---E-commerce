' Liga o robô do telão sem nenhuma janela (nem a preta, nem o Chrome).
' O andamento fica em robo.log. Para desligar: desligar-robo.bat.
' O Chrome só fica sem janela com MOSTRAR_NAVEGADOR=nao no arquivo .env.
Set fso = CreateObject("Scripting.FileSystemObject")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = pasta
sh.Run "cmd /c """ & pasta & "\ligar-robo.bat"" escondido", 0, False
