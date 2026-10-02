Option Explicit

MsgBox "Этот VBS больше не запускает PowerShell и не используется для обновления из интерфейса." & vbCrLf & vbCrLf & _
       "Откройте расширение и нажмите «Обновить» — ход обновления и лог будут показаны в Chrome." & vbCrLf & _
       "Резервный способ: update.cmd.", _
       vbInformation, "ChatGPT Archiver"

WScript.Quit 0
