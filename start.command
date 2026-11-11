#!/bin/bash
# 双击即可启动路由器数据看板（macOS）
cd "$(dirname "$0")" || exit 1
URL="http://127.0.0.1:8787/"

# 首次运行提示配置
if [ ! -f config.env ]; then
  echo "未找到 config.env，正在从示例创建…"
  cp config.env.example config.env
  echo "请编辑 config.env 填入你的路由器地址和管理密码，然后重新运行。"
  open -e config.env
  exit 1
fi

if lsof -ti tcp:8787 >/dev/null 2>&1; then
  echo "看板服务已在运行，直接打开浏览器。"
  open "$URL"
  exit 0
fi

echo "正在启动 NROS 路由器数据看板…"
node server.js &
PID=$!
sleep 1
open "$URL"
echo "服务地址：$URL  （关闭此终端窗口即可停止服务）"
wait "$PID"
