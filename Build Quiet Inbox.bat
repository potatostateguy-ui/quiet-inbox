@echo off
rem Double-click this file to build Quiet Inbox. It installs anything that is missing.
title Quiet Inbox build
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build.ps1"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
