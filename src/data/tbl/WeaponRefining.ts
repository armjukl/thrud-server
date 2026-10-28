// AUTO-GEN tools/gen_tables.py --tier 1 (do not edit)
// 改表改 tools/gen_tables.py, 手改这份下次就被覆盖。
// table=WeaponRefining_Xls rows=5 srcEXT=0 srcAPK=5 mergedFromAPK=5 collisionEXTWins=0 shape=row cols=4
// EXT=- APK=95a580f1973169f79f60982f0985a1e1
// 树: EXT=/home/sld/res/phone/luaplain/toLua APK=/home/tmp/apklua_plain/toLua
const RAW = "{\"1\":{\"weaponRefining\":1,\"weaponGrate\":1,\"consume\":91001,\"consume2\":91006},\"2\":{\"weaponRefining\":2,\"weaponGrate\":2,\"consume\":91002,\"consume2\":91007},\"3\":{\"weaponRefining\":3,\"weaponGrate\":3,\"consume\":91003,\"consume2\":91008},\"4\":{\"weaponRefining\":4,\"weaponGrate\":4,\"consume\":91004,\"consume2\":91009},\"5\":{\"weaponRefining\":5,\"weaponGrate\":5,\"consume\":91005,\"consume2\":91010}}";
// 只在真被取到时才 parse: 36 张 12 MB 全在 import 期 parse, 这笔钱就落在起服路径上。
let parsed: any = null;
export function raw(): any {
  if (parsed === null) parsed = JSON.parse(RAW);
  return parsed;
}
export const table = 'WeaponRefining_Xls';
