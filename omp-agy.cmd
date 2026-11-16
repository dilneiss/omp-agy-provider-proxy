@echo off
setlocal
cd /d "%~dp0"

powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://127.0.0.1:8788/health; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
if errorlevel 1 (
  start "provider-agy" /min cmd /c node "%~dp0server.js"
  timeout /t 2 /nobreak >nul
)

omp --model agy/gemini-3.8-flash-high %*
