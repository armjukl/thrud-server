import json, zipfile, io, sys, collections
sys.path.insert(0,'/home/tmp/venv/lib/python3.10/site-packages')
import UnityPy
z=zipfile.ZipFile('/home/qkzx/sld_1.0.6.1338_20230926_061320_5fb48.apk')
abs_=[n for n in z.namelist() if n.endswith('.ab') and n.startswith('assets/res/data/')][:6]
for n in abs_:
    b=z.read(n)
    try:
        env=UnityPy.load(io.BytesIO(b))
    except Exception as e:
        print(n,'LOAD ERR',e); continue
    types=collections.Counter(o.type.name for o in env.objects)
    names=[]
    for o in env.objects:
        if o.type.name in ('TextAsset','MonoBehaviour'):
            try:
                d=o.read(); names.append((o.type.name, getattr(d,'m_Name','?'), getattr(d,'byte_size','')))
            except Exception: pass
    print('==',n.split('/')[-1], 'size',len(b), dict(types))
    for t in names[:6]: print('    ',t)
