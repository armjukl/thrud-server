import sys, os, UnityPy
path=sys.argv[1]
env=UnityPy.load(path)
for o in env.objects:
    t=o.type.name
    if t in ('TextAsset','MonoBehaviour','MonoScript','AssetBundle','ResourceFile'):
        try: d=o.read()
        except Exception as e: print(t,'ERR',e); continue
        if t=='TextAsset':
            s=d.m_Script
            if isinstance(s,str): b=s.encode('utf8','replace')
            else: b=bytes(s)
            print(f'--- TextAsset {d.m_Name} len={len(b)} ---')
            print(b[:600].decode('utf8','replace'))
        elif t=='MonoBehaviour':
            print(f'--- MonoBehaviour type={o.type} size={o.byte_size} ---')
        else:
            print('---',t,'---')
    else:
        print('obj',t,o.byte_size)
