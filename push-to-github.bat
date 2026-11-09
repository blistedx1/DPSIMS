@echo off
title Push DPSIMS to GitHub
cd /d "%~dp0"
echo Staging and committing changes...
git add .
git commit -m "Deploy latest updates: server-verified WebAuthn passkey flow, PWA auto-onboarding, and UI fixes" 2>nul
echo Pushing to https://github.com/blistedx1/DPSIMS.git ...
git push -u origin main
echo.
pause

