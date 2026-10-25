import json,collections,io,zipfile
z=zipfile.ZipFile('/home/qkzx/sld_1.0.6.1338_20230926_061320_5fb48.apk')
names=[l.strip() for l in open('/home/qkzx/sld/sld/assets/toLua/toluaLoader') if l.strip()]
print('index entries:',len(names))
groups=collections.Counter()
samp=collections.defaultdict(list)
for n in names:
    arc='assets/toLua/Data/'+n
    try: b=z.read(arc)[:32]
    except KeyError:
        continue
    # bucket by first 4 bytes only
    groups[b[:4].hex()]+=1
    if len(samp[b[:4].hex()])<3: samp[b[:4].hex()].append((n,b.hex()))
print('distinct 4-byte prefixes among',sum(groups.values()),'files:',len(groups))
for k,v in groups.most_common(20): print(' ',k,v)
print()
for k in list(groups)[:6]:
    for n,h in samp[k]: print(k,n,h)
