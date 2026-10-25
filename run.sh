#!/bin/bash
# 斯露德(Thrud/sld) 离线假服
# 用法: 手机装 1.0.7 APK, 把 res/phone/files.zip 解到包名目录(见 docs), 起本假服即可进游戏.
#   无热更: getClientUpdateData 固定回 resVersion=1583(与资源包一致) -> 客户端直接读盘上的资源.
#   可选环境变量: SLD_HTTP_PORT / SLD_KCP_PORT / SLD_PUBLIC_HOST / SLD_TLS / SLD_NET_MODE.
#   抽卡调试: SLD_GACHA_FORCE_QUALITY=5 -> 十连强制金色本体(默认 0=按池真实掉落).
#             SLD_GACHA_FORCE_TYPE=leader|weapon 指定角色/律叶(留空按掉落类型推断).
set -e
cd "$(dirname "$0")"
npm run --silent build
export SLD_TLS="${SLD_TLS:-1}"
export SLD_HTTP_PORT="${SLD_HTTP_PORT:-9443}"
export SLD_KCP_PORT="${SLD_KCP_PORT:-19005}"
export SLD_PUBLIC_HOST="${SLD_PUBLIC_HOST:-23.147.232.29}"
export SLD_GACHA_FORCE_QUALITY="${SLD_GACHA_FORCE_QUALITY:-0}"
export SLD_GACHA_FORCE_TYPE="${SLD_GACHA_FORCE_TYPE:-}"
exec node dist/index.js
