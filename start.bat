@echo off
chcp 65001 >nul
title Saliency module - local server
cd /d "%~dp0"
echo.
echo  ============================================
echo   Saliency module - local server
echo  ============================================
echo.
echo  Open: http://localhost:8765/
echo  Stop: close this window
echo.

REM Try Python launcher first, then python.exe
where py >nul 2>nul
if %errorlevel%==0 (
    start "" http://localhost:8765/
    py -m http.server 8765
    goto :end
)

where python >nul 2>nul
if %errorlevel%==0 (
    start "" http://localhost:8765/
    python -m http.server 8765
    goto :end
)

echo Python not found. Either:
echo  - use salience.html (single-file, no server needed)
echo  - install Python from python.org
echo.
pause

:end
