import json, zipfile
z=zipfile.ZipFile('/home/qkzx/sld_1.0.6.1338_20230926_061320_5fb48.apk')
have={n.split('/')[-1] for n in z.namelist() if n.startswith('assets/res/data/')}
d=json.load(open('/home/qkzx/sld/sld/assets/res/abIndex.json',encoding='utf-8-sig'))['mAbList']
idx={i['mAbName'] for i in d}
print('apk files',len(have),'index entries',len(idx))
def ext(n): return n[:-3] if n.endswith('.ab') else n
have_stem={ext(h) for h in have}
miss=[m for m in idx if m not in have_stem]
print('index entries missing from apk:',len(miss), miss[:5])
un=sorted(have_stem-idx)
print('apk bundles not in abIndex:',len(un), un[:3])
# DepData coverage
dd=json.load(open('/home/qkzx/sld/sld/assets/res/AssetBundleDepData.json',encoding='utf-8-sig'))['mItemList']
ddn={i['mName'] for i in dd}
print('DepData items',len(ddn),'cover all apk bundles?',len(have_stem-ddn), 'extra in dep', len(ddn-have_stem))
