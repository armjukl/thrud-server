// AUTO-GEN tools/gen_tables.py --tier 1 (do not edit)
// 改表改 tools/gen_tables.py, 手改这份下次就被覆盖。
// table=WeaponRefiningLock_Xls rows=4 srcEXT=0 srcAPK=4 mergedFromAPK=4 collisionEXTWins=0 shape=row cols=4
// EXT=- APK=58d74961083a7533706a5a1b33bbecff
// 树: EXT=/home/sld/res/phone/luaplain/toLua APK=/home/tmp/apklua_plain/toLua
const RAW = "{\"1\":{\"weaponRefining\":1,\"lockNum\":1,\"consume\":92001,\"consume2\":92005},\"2\":{\"weaponRefining\":2,\"lockNum\":2,\"consume\":92002,\"consume2\":92006},\"3\":{\"weaponRefining\":3,\"lockNum\":3,\"consume\":92003,\"consume2\":92007},\"4\":{\"weaponRefining\":4,\"lockNum\":4,\"consume\":92004,\"consume2\":92008}}";
// 只在真被取到时才 parse: 36 张 12 MB 全在 import 期 parse, 这笔钱就落在起服路径上。
let parsed: any = null;
export function raw(): any {
  if (parsed === null) parsed = JSON.parse(RAW);
  return parsed;
}
export const table = 'WeaponRefiningLock_Xls';
