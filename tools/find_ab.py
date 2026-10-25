import json,sys
d=json.load(open('/home/qkzx/sld/sld/assets/res/abIndex.json',encoding='utf-8-sig'))
want=sys.argv[1:]
for i in d['mAbList']:
    for w in want:
        if w.lower() in i['mOriginName'].lower():
            print(i['mOriginName'],'->',i['mAbName'])
