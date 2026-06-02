@echo off
REM record.cmd — Windows launcher for the recorder. Avoids the WSL-bash trap and
REM shell/quoting differences: run from ANY terminal (PowerShell or cmd), e.g.
REM   .\record.cmd mytest https://www.google.com
REM   .\record.cmd mytest https://app.example.com/start --app myapp
cd /d "%~dp0"
"C:\Program Files\Git\bin\bash.exe" bin/probe-record.sh capture %*
