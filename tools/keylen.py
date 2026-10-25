import zipfile, collections
APK='/home/qkzx/sld_1.0.6.1338_20230926_061320_5fb48.apk'
z=zipfile.ZipFile(APK)
names=[l.strip() for l in open('/home/qkzx/sld/sld/assets/toLua/toluaLoader') if l.strip()]
files=[]
for n in names:
    try: b=z.read('assets/toLua/Data/'+n)
    except KeyError: continue
    if len(b)>4096: files.append((n,b))
print('files>4k:',len(files))
hits=collections.Counter(); cand=collections.defaultdict(collections.Counter)
for n,b in files[:1500]:
    for L in range(2,73):
        # count adjacent repeats anywhere in file
        cnt=0; best=None
        i=0
        while i+2*L<=len(b):
            if b[i:i+L]==b[i+L:i+2*L]:
                cnt+=1
                if best is None: best=b[i:i+L]
            i+=1
        if cnt:
            hits[L]+=cnt
            if cnt>=3: cand[L][best]+=1
print('=== adjacent-repeat counts by lag ===')
for L,c in hits.most_common(15): print(' lag',L,'count',c)
print('=== most common repeat block for top lags ===')
for L,_ in hits.most_common(4):
    print('lag',L, cand[L].most_common(3))
