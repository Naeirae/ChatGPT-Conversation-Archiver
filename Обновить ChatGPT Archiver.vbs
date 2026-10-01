Option Explicit

Dim shell, fso, baseDir, updaterPath, manifestPath, logPath, command, rc, version

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If HasArgument("--self-test") Then
  WScript.Quit 0
End If

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
updaterPath = fso.BuildPath(baseDir, "update.ps1")
manifestPath = fso.BuildPath(baseDir, "manifest.json")
logPath = fso.BuildPath(baseDir, "updater-last.log")

If Not fso.FileExists(updaterPath) Then
  MsgBox "Не найден update.ps1 рядом с оболочкой обновления." & vbCrLf & _
         "Положите файл в папку распакованного ChatGPT Archiver.", _
         vbCritical, "ChatGPT Archiver"
  WScript.Quit 1
End If

If Not fso.FileExists(manifestPath) Then
  MsgBox "Не найден manifest.json рядом с оболочкой обновления." & vbCrLf & _
         "Запускайте обновление из папки распакованного расширения.", _
         vbCritical, "ChatGPT Archiver"
  WScript.Quit 1
End If

shell.Popup "Проверяю обновления ChatGPT Archiver…", 2, "ChatGPT Archiver", 64

command = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File " & Quote(updaterPath)
rc = shell.Run(command, 0, True)

If rc = 0 Then
  version = ReadManifestVersion(manifestPath)
  If version <> "" Then
    MsgBox "Обновление завершено." & vbCrLf & _
           "Версия: " & version & vbCrLf & vbCrLf & _
           "Теперь нажмите Reload у расширения на chrome://extensions.", _
           vbInformation, "ChatGPT Archiver"
  Else
    MsgBox "Обновление завершено." & vbCrLf & vbCrLf & _
           "Теперь нажмите Reload у расширения на chrome://extensions.", _
           vbInformation, "ChatGPT Archiver"
  End If
  WScript.Quit 0
End If

If MsgBox("Обновление завершилось с ошибкой." & vbCrLf & _
          "Код: " & rc & vbCrLf & vbCrLf & _
          "Открыть updater-last.log?", _
          vbYesNo + vbExclamation, "ChatGPT Archiver") = vbYes Then
  If fso.FileExists(logPath) Then
    shell.Run "notepad.exe " & Quote(logPath), 1, False
  Else
    MsgBox "updater-last.log не найден.", vbExclamation, "ChatGPT Archiver"
  End If
End If

WScript.Quit rc

Function HasArgument(expected)
  Dim i
  HasArgument = False
  For i = 0 To WScript.Arguments.Count - 1
    If LCase(CStr(WScript.Arguments(i))) = LCase(expected) Then
      HasArgument = True
      Exit Function
    End If
  Next
End Function

Function Quote(value)
  Quote = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function

Function ReadManifestVersion(path)
  Dim file, text, re, matches
  ReadManifestVersion = ""

  On Error Resume Next
  Set file = fso.OpenTextFile(path, 1, False)
  If Err.Number <> 0 Then
    Err.Clear
    On Error GoTo 0
    Exit Function
  End If

  text = file.ReadAll
  file.Close

  Set re = New RegExp
  re.Pattern = """version""\s*:\s*""([^""]+)"""
  re.IgnoreCase = True
  re.Global = False

  Set matches = re.Execute(text)
  If matches.Count > 0 Then
    ReadManifestVersion = matches(0).SubMatches(0)
  End If
  On Error GoTo 0
End Function
