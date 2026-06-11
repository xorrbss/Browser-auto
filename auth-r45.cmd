@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM Visible manual Hiworks auth helper for the r45 app profile.
REM Double-click this file from Windows Explorer, log in in the browser,
REM then return to this window and press Enter only after the approval list is open.

cd /d "%~dp0"

set "GIT_BASH=C:\Program Files\Git\bin\bash.exe"
if not exist "%GIT_BASH%" (
  echo [auth-r45] Git Bash not found: %GIT_BASH%
  exit /b 1
)

set "REPO_WIN=%CD%"
set "DRIVE=%REPO_WIN:~0,1%"
set "REST=%REPO_WIN:~2%"
set "REST=%REST:\=/%"
if /I "%DRIVE%"=="C" set "DRIVE=c"
set "REPO_BASH=/%DRIVE%%REST%"

set "RUN_DIR=%REPO_WIN%\artifacts\auth-r45-manual"
set "STOPFILE=%RUN_DIR%\save.flag"
set "STOPFILE_BASH=%REPO_BASH%/artifacts/auth-r45-manual/save.flag"

mkdir "%RUN_DIR%" >nul 2>nul
del "%STOPFILE%" >nul 2>nul

set "LOGIN_URL=https://approval.office.hiworks.com/ibizsoftware.net/approval/document/lists/W"
set "SUCCESS_NEEDLE=__MANUAL_SAVE_ONLY__"
set "AUTH_CMD=cd %REPO_BASH% && AQA_AUTH_STOPFILE=%STOPFILE_BASH% HUMAN_TIMEOUT_MS=900000 bash setup/auth.sh r45 %LOGIN_URL% %SUCCESS_NEEDLE%"

if "%AUTH_R45_DRY_RUN%"=="1" (
  echo [auth-r45] dry run
  echo repo: %REPO_WIN%
  echo bash repo: %REPO_BASH%
  echo stopfile: %STOPFILE%
  echo command: !AUTH_CMD!
  exit /b 0
)

echo [auth-r45] Starting visible Git Bash auth runner...
start "Browser-auto r45 auth" "%GIT_BASH%" -lc "!AUTH_CMD!"

echo.
echo [auth-r45] 1. Log in to Hiworks in the browser that opens.
echo [auth-r45] 2. Navigate to the approval document list.
echo [auth-r45] 3. Return to this window and press Enter only after the list is visible.
echo.
echo [auth-r45] Target page:
echo [auth-r45] %LOGIN_URL%
echo.
pause

>"%STOPFILE%" echo save

echo.
echo [auth-r45] Save requested.
echo [auth-r45] Watch the Git Bash auth window until it reports that fixtures/auth/playwright/r45.state.json was saved.
echo [auth-r45] Then tell Codex: auth saved.
echo.
pause
