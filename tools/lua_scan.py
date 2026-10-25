import zipfile, collections, re
APK='/home/qkzx/sld_1.0.6.1338_20230926_061320_5fb48.apk'
z=zipfile.ZipFile(APK)
names=[l.strip() for l in open('/home/qkzx/sld/sld/assets/toLua/toluaLoader') if l.strip()]
plain=[]; sig=[]
tot=0
for n in names:
    try: b=z.read('assets/toLua/Data/'+n)
    except KeyError: continue
    tot+=1
    if b[:4]==b'\x1bLua': sig.append(n)
    pr=sum(1 for c in b[:200] if 32<=c<127 or c in (9,10,13))
    if pr/len(b[:200])>0.90: plain.append((n,len(b),b[:120]))
print('total',tot,'plaintext lua source:',len(plain),'with \\x1bLua sig:',len(sig))
for t in plain[:10]: print(t[0],t[1],repr(t[2]))
