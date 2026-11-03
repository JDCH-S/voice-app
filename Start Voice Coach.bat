@echo off
setlocal EnableExtensions
title Voice Coach
cd /d "%~dp0"

echo.
echo   Voice Coach is starting...
echo.

set "PORT=5173"
set "VENV=%~dp0server\.venv"
set "VPY=%VENV%\Scripts\python.exe"

if exist "%VPY%" goto have_venv

rem ---- find Python 3.10 to 3.13; 3.12 preferred ----
set "PY="
for %%V in (3.12 3.13 3.11 3.10) do (
  if not defined PY (
    py -%%V -c "import sys" >nul 2>nul && set "PY=py -%%V"
  )
)
if defined PY goto make_venv
python -c "import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,13) else 1)" >nul 2>nul && set "PY=python"
if defined PY goto make_venv

echo   Python 3.12 is needed and was not found.
echo.
echo   1. Open https://www.python.org/downloads/release/python-31210/
echo   2. Scroll down to Files and click "Windows installer 64-bit".
echo   3. Run it. On the first screen tick "Add python.exe to PATH", then click Install Now.
echo   4. Double-click this file again.
echo.
pause
exit /b 1

:make_venv
echo   Setting up Voice Coach for the first time. This only happens once.
%PY% -m venv "%VENV%"
if errorlevel 1 goto fail

:have_venv
rem ---- analysis engine: reinstalled only when requirements.txt changes ----
fc /b "server\requirements.txt" "%VENV%\req-installed.txt" >nul 2>nul
if not errorlevel 1 goto have_base
echo   Installing the analysis engine...
"%VPY%" -m pip install --disable-pip-version-check -r "server\requirements.txt"
if errorlevel 1 goto fail
copy /y "server\requirements.txt" "%VENV%\req-installed.txt" >nul

:have_base
rem ---- vocal separation: installed once ----
if exist "%VENV%\separation-installed.txt" goto have_sep
echo.
echo   Installing vocal separation. The first time this downloads several hundred MB
echo   and can take 10 to 20 minutes. Next time Voice Coach starts in seconds.
echo.
"%VPY%" -m pip install --disable-pip-version-check torch torchaudio --index-url https://download.pytorch.org/whl/cpu
if errorlevel 1 goto fail
"%VPY%" -m pip install --disable-pip-version-check -r "server\requirements-separation.txt"
if errorlevel 1 goto fail
echo ok> "%VENV%\separation-installed.txt"

:have_sep
rem ---- build the web app ----
where npm.cmd >nul 2>nul
if errorlevel 1 goto no_node
echo   Preparing the app...
pushd web
call npm.cmd install --no-audit --no-fund --loglevel=error
if errorlevel 1 (popd & goto fail)
call npm.cmd run build --silent
if errorlevel 1 (popd & goto fail)
popd

echo.
echo   ============================================================
echo    Voice Coach is running at http://localhost:%PORT%
echo    Your browser opens by itself.
echo    Keep this window open while you sing. Close it to stop.
echo   ============================================================
echo.
set "VOICECOACH_OPEN_BROWSER=http://localhost:%PORT%/"
"%VPY%" -m uvicorn main:app --app-dir server --host 127.0.0.1 --port %PORT% --log-level warning

echo.
echo   Voice Coach stopped.
echo   If it said the address is already in use, another Voice Coach window
echo   or "npm run dev" is still running. Close it and double-click this file again.
echo.
pause
exit /b 0

:no_node
echo.
echo   Node.js was not found. Install the LTS version from https://nodejs.org
echo   and double-click this file again.
echo.
pause
exit /b 1

:fail
echo.
echo   Something went wrong during setup. The error is shown above.
echo   Copy the text of this window and send it for help.
echo.
pause
exit /b 1
