// AUTO-GEN tools/gen_tables.py --tier 1 (do not edit)
// 改表改 tools/gen_tables.py, 手改这份下次就被覆盖。
// table=SignActivity_Xls rows=7 srcEXT=0 srcAPK=7 mergedFromAPK=7 collisionEXTWins=0 shape=row cols=5
// EXT=- APK=084257eb7a8cb069eebe57b5d857dfff
// 树: EXT=/home/sld/res/phone/luaplain/toLua APK=/home/tmp/apklua_plain/toLua
const RAW = "{\"1\":{\"id\":1,\"type\":1,\"times\":1,\"markType\":0,\"fixedRewardID\":801001},\"2\":{\"id\":2,\"type\":1,\"times\":2,\"markType\":1,\"fixedRewardID\":801002},\"3\":{\"id\":3,\"type\":1,\"times\":3,\"markType\":0,\"fixedRewardID\":801003},\"4\":{\"id\":4,\"type\":1,\"times\":4,\"markType\":0,\"fixedRewardID\":801004},\"5\":{\"id\":5,\"type\":1,\"times\":5,\"markType\":0,\"fixedRewardID\":801005},\"6\":{\"id\":6,\"type\":1,\"times\":6,\"markType\":1,\"fixedRewardID\":801006},\"7\":{\"id\":7,\"type\":1,\"times\":7,\"markType\":1,\"fixedRewardID\":801007}}";
// 只在真被取到时才 parse: 36 张 12 MB 全在 import 期 parse, 这笔钱就落在起服路径上。
let parsed: any = null;
export function raw(): any {
  if (parsed === null) parsed = JSON.parse(RAW);
  return parsed;
}
export const table = 'SignActivity_Xls';
