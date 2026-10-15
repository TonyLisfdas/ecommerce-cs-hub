@echo off
setlocal
echo Current tags:
git tag
set /p TAG=Enter tag to rollback to (e.g. v4-baseline): 
git checkout %TAG% -- .
echo.
echo Rolled back to %TAG%. Restart the app to verify.
pause
