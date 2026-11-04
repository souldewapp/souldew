@echo off
rem Doppelklick startet souldew (Windows).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js fehlt. Installiere es von https://nodejs.org ^(LTS^) und starte dann erneut.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installiere Abhaengigkeiten ^(einmalig^) ...
  call npm install --no-audit --no-fund
)
node server\index.mjs
pause
