// AUTO-GEN tools/gen_tables.py --tier 1 (do not edit)
// 改表改 tools/gen_tables.py, 手改这份下次就被覆盖。
// table=TaskMissionType_Xls rows=5 srcEXT=0 srcAPK=5 mergedFromAPK=5 collisionEXTWins=0 shape=row cols=3
// EXT=- APK=cbe8331be60d18730efb5de82122bfb0
// 树: EXT=/home/sld/res/phone/luaplain/toLua APK=/home/tmp/apklua_plain/toLua
const RAW = "{\"1\":{\"missionTypeId\":1,\"taskTypeIconSmall\":\"task_icon1\",\"taskTrackPriority\":2},\"2\":{\"missionTypeId\":2,\"taskTypeIconSmall\":\"task_icon2\",\"taskTrackPriority\":1},\"3\":{\"missionTypeId\":3,\"taskTypeIconSmall\":\"task_type_icon1_1\"},\"4\":{\"missionTypeId\":4,\"taskTypeIconSmall\":\"task_type_icon1_1\"},\"401\":{\"missionTypeId\":401,\"taskTypeIconSmall\":\"task_type_icon1_1\"}}";
// 只在真被取到时才 parse: 36 张 12 MB 全在 import 期 parse, 这笔钱就落在起服路径上。
let parsed: any = null;
export function raw(): any {
  if (parsed === null) parsed = JSON.parse(RAW);
  return parsed;
}
export const table = 'TaskMissionType_Xls';
