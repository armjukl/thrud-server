// AUTO-GEN tools/gen_tables.py --tier 1 (do not edit)
// 改表改 tools/gen_tables.py, 手改这份下次就被覆盖。
// table=HangUpBattle_Xls rows=6 srcEXT=0 srcAPK=6 mergedFromAPK=6 collisionEXTWins=0 shape=row cols=7
// EXT=- APK=0fbfe539aade3bec8af69f85ed1fb84f
// 树: EXT=/home/sld/res/phone/luaplain/toLua APK=/home/tmp/apklua_plain/toLua
const RAW = "{\"1\":{\"id\":1,\"functionId\":294,\"unlockCondition\":1,\"maxNum\":10,\"modelSwitch\":2},\"2\":{\"id\":2,\"functionId\":295,\"unlockCondition\":1,\"maxNum\":10,\"modelSwitch\":2},\"3\":{\"id\":3,\"functionId\":296,\"unlockCondition\":1,\"maxNum\":10,\"modelSwitch\":2},\"4\":{\"id\":4,\"functionId\":297,\"unlockCondition\":1,\"maxNum\":10,\"modelSwitch\":2},\"5\":{\"id\":5,\"functionId\":298,\"unlockCondition\":1,\"maxNum\":10,\"modelSwitch\":2},\"6\":{\"id\":6,\"functionId\":4610,\"unlockCondition\":1,\"maxNum\":10,\"modelSwitch\":2}}";
// 只在真被取到时才 parse: 36 张 12 MB 全在 import 期 parse, 这笔钱就落在起服路径上。
let parsed: any = null;
export function raw(): any {
  if (parsed === null) parsed = JSON.parse(RAW);
  return parsed;
}
export const table = 'HangUpBattle_Xls';
