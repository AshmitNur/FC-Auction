@echo off
setlocal

cd /d "%~dp0"

echo.
echo FC 26 LAN Auction App
echo =====================
echo Project: %cd%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js, then run this file again.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Install Node.js with npm, then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

if not exist "data\fc26-players-81-plus.json" (
  echo Downloading EA FC 26 male 81+ player pool...
  call npm run scrape:players
  if errorlevel 1 (
    echo Player data download failed.
    pause
    exit /b 1
  )
)

if not exist "dist\index.html" (
  echo Building frontend...
  call npm run build
  if errorlevel 1 (
    echo Frontend build failed.
    pause
    exit /b 1
  )
)

echo.
echo Starting server at http://localhost:4000
echo Other devices on the same LAN can open http://YOUR-LAPTOP-IP:4000
echo Keep this window open while using the app.
echo.

start "" "http://localhost:4000"
call npm start

pause
