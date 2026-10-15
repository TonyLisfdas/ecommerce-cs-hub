Set fso = CreateObject("Scripting.FileSystemObject")
Set ws = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
ws.CurrentDirectory = appDir
exe = appDir & "\node_modules\electron\dist\electron.exe"
cmd = """"" & exe & """" & " """ & appDir & """"
ws.Run cmd, 1, False
