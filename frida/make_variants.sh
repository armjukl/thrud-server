#!/bin/sh
# 从唯一真源 hook_gadget_all.js 生成旋钮变体。**变体一律不许手改**, 改了基线就跑这个。
# 为什么要有这个脚本: 忘了重生成 → smoke 测试和真机测的都是旧脚本, 这个坑踩过两次(见 docs/README-改Lua脚本.md §5)。
# 用法: ./make_variants.sh   (每改一次 hook_gadget_all.js 都跑, 然后拿打出来的 md5 去核)
cd "$(dirname "$0")" || exit 1
B=hook_gadget_all.js
grep -q '^var WATCH = true;$' $B && grep -q '^var SKIP = false;$' $B &&
  grep -q '^var POOL = false;$' $B && grep -q '^var ZAXIS = false;$' $B || {
  echo "$B 的旋钮行不是预期形状(改过初值?), 脚本要跟着改"; exit 1; }

gen() { # 输出名 WATCH SKIP POOL ZAXIS 说明
  sed -e "s/^var WATCH = true;/var WATCH = $2;/" -e "s/^var SKIP = false;/var SKIP = $3;/" \
      -e "s/^var POOL = false;/var POOL = $4;/" -e "s/^var ZAXIS = false;/var ZAXIS = $5;/" $B > "$1" || exit 1
  node --check "$1" >/dev/null 2>&1 || { echo "语法不过: $1"; exit 1; }
  printf '%-32s %sB %s  %s\n' "$1" "$(wc -c <$1)" "$(md5sum <$1 | cut -c1-12)" "$6"
}

echo "基线: $(wc -c <$B)B md5=$(md5sum <$B | cut -c1-12)  (WATCH 观测登录视频)"
gen hook_gadget_all_skip.js false true false false 'SKIP: 跳过登录视频, 不改 Lua'
gen hook_gadget_pool.js true false true false 'WATCH+POOL: 只改卡池时间'
gen hook_gadget_pool_skip.js false true true false 'SKIP+POOL: 卡池(10-18 真机验证过的那份)'
gen hook_gadget_zaxis.js true false false true 'WATCH+ZAXIS: 只解战斗高度轴'
gen hook_gadget_zaxis_skip.js false true false true 'SKIP+ZAXIS: 只解高度(想单独验证用它)'
gen hook_gadget_pool_zaxis.js true false true true 'WATCH+POOL+ZAXIS: 卡池+高度'
gen hook_gadget_pool_zaxis_skip.js false true true true 'SKIP+POOL+ZAXIS: 推荐(两样都改 + 跳视频)'
