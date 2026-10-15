@echo off
cd /d "%~dp0"
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_CUSTOM_DIR=v31.0.0
set ELECTRON_CUSTOM_FILENAME=electron-v31.0.0-win32-x64.zip
set npm_config_registry=https://registry.npmmirror.com
set npm_config_electron_mirror=https://npmmirror.com/mirrors/electron/
if not exist "node_modules\electron\dist\electron.exe" (
    echo [1/2] Installing Electron from npmmirror.com...
    call npm install electron@31.0.0 --no-save --registry=https://registry.npmmirror.com
    if not exist "node_modules\electron\dist\electron.exe" (
        node "node_modules\electron\install.js"
    )
)
echo [2/2] Starting Ecommerce CS Hub...
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0
