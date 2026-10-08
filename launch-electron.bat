@echo off
title Agent Workbench (Electron)
cd /d "%~dp0"
echo 正在启动 Agent Workbench 桌面客户端...
call pnpm dev:electron
pause
