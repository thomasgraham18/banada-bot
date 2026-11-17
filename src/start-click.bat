@echo off
title Banada Bot
cd /d "%~dp0"

:Reconnected

node index.js

rem Wait before restarting so a crash loop does not hammer Discord's login.
echo Bot stopped. Restarting in 10 seconds... (Ctrl+C to cancel)
timeout /t 10 /nobreak >nul

goto Reconnected
