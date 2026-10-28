// AUTO-GEN tools/gen_tables.py --tier 1 (do not edit)
// 改表改 tools/gen_tables.py, 手改这份下次就被覆盖。
// table=SignBingo_Xls rows=7 srcEXT=0 srcAPK=7 mergedFromAPK=7 collisionEXTWins=0 shape=row cols=3
// EXT=- APK=825b543cb025d33e96da0dfd4887c6d7
// 树: EXT=/home/sld/res/phone/luaplain/toLua APK=/home/tmp/apklua_plain/toLua
const RAW = "{\"1\":{\"id\":1,\"num\":8,\"award\":802000},\"2\":{\"id\":2,\"num\":16,\"award\":802001},\"3\":{\"id\":3,\"num\":24,\"award\":802002},\"4\":{\"id\":4,\"num\":32,\"award\":802003},\"5\":{\"id\":5,\"num\":40,\"award\":802004},\"6\":{\"id\":6,\"num\":48,\"award\":802005},\"7\":{\"id\":7,\"num\":56,\"award\":802006}}";
// 只在真被取到时才 parse: 36 张 12 MB 全在 import 期 parse, 这笔钱就落在起服路径上。
let parsed: any = null;
export function raw(): any {
  if (parsed === null) parsed = JSON.parse(RAW);
  return parsed;
}
export const table = 'SignBingo_Xls';
