@echo off
title Push DPSIMS to GitHub
cd /d "%~dp0"
echo Staging and committing changes...
git add .
git commit -m "Deploy latest updates: VAPID push notifications and animation fixes" 2>nul
echo Pushing to https://github.com/blistedx1/DPSIMS.git ...
git push origin main
echo.
pause

