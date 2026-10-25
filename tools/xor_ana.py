import zipfile, collections
APK='/home/qkzx/sld_1.0.6.1338_20230926_061320_5fb48.apk'
z=zipfile.ZipFile(APK)
names=[l.strip() for l in open('/home/qkzx/sld/sld/assets/toLua/toluaLoader') if l.strip()]
grp=collections.defaultdict(list)
data={}
for n in names:
    try: b=z.read('assets/toLua/Data/'+n)
    except KeyError: continue
    data[n]=b; grp[b[:4].hex()].append(n)
G=max(grp.items(), key=lambda kv: len(kv[1]))
key,glist=G
print('largest group',key,len(glist))
# shared prefix length across the group
def common_prefix(bs):
    p=None
    for b in bs:
        if p is None: p=bytearray(b); continue
        i=0
        while i<len(p) and i<len(b) and p[i]==b[i]: i+=1
        del p[i:]
    return bytes(p)
cp=common_prefix([data[n] for n in glist])
print('common prefix in group:',len(cp),cp[:48].hex())
# per-position byte variety
for L in range(1,65):
    score=0; tot=0
    for pos in range(L):
        c=collections.Counter()
        for n in glist:
            b=data[n]
            if pos < len(b): c[b[pos]]+=1
        if not c: continue
        score+=c.most_common(1)[0][1]; tot+=sum(c.values())
    print(L, round(score/tot,4)) if L<20 or L%8==0 else None
