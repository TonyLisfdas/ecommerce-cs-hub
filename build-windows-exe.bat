@echo off
chcp 65001 >nul
title 打包生成 Windows 独立 EXE 安装包

echo ============================================================================
echo   正在将「聚客宝 · 八大电商平台聚合客服工作台」打包为 Windows .exe 可执行程序
echo ============================================================================
echo.

set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

if not exist "node_modules" (
    call npm install --registry=https://registry.npmmirror.com
)

call npm run build:win
echo.
echo [完成] 打包成功！请打开 release 文件夹查看生成的 Windows .exe 程序。
pause
