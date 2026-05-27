@echo off
setlocal

cd /d "%~dp0"

echo.
echo FC 26 Supabase Setup
echo ====================
echo.

if not exist ".env" (
  echo .env was not found.
  echo Copy .env.example to .env and add your SUPABASE_SERVICE_ROLE_KEY first.
  pause
  exit /b 1
)

echo Make sure you have run the SQL in supabase\schema.sql in your Supabase SQL editor.
echo.
echo Seeding FC 26 male 81+ players into Supabase...
call npm run seed:supabase
if errorlevel 1 (
  echo Supabase seeding failed.
  pause
  exit /b 1
)

echo.
echo Done. Restart run-fc26-app.bat to use Supabase persistence.
pause
