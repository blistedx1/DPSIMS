@echo off
title Push DPSIMS to GitHub
cd /d "%~dp0"
echo Pushing to https://github.com/blistedx1/DPSIMS.git ...
git push -u origin main
echo.
pause
