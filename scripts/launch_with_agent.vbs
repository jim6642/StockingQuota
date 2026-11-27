' Silent zero-console companion launcher for Codex / Antigravity + StockingQuota V0.4
' Usage:
'   wscript.exe launch_with_agent.vbs codex
'   wscript.exe launch_with_agent.vbs antigravity
' Starts StockingQuota.exe silently alongside the Agent without requiring Windows boot startup!

Dim shell, fso, agent, scriptDir, sqExe, localAppData
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

agent = "codex"
If WScript.Arguments.Count > 0 Then
  agent = LCase(WScript.Arguments(0))
End If

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
sqExe = fso.BuildPath(scriptDir, "..\release\win-unpacked\StockingQuota.exe")
localAppData = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%")

If fso.FileExists(sqExe) Then
  shell.Run """" & sqExe & """ --silent --from-agent=" & agent, 0, False
End If

If agent = "codex" Then
  Dim codexExe
  codexExe = localAppData & "\Microsoft\WindowsApps\codex.exe"
  If fso.FileExists(codexExe) Then
    shell.Run """" & codexExe & """", 1, False
  Else
    shell.Run "codex", 1, False
  End If
ElseIf agent = "antigravity" Then
  Dim agyExe
  agyExe = localAppData & "\Programs\antigravity\Antigravity.exe"
  If fso.FileExists(agyExe) Then
    shell.Run """" & agyExe & """", 1, False
  End If
End If
