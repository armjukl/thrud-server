import json, re, collections
p='/home/qkzx/sld/sld/assets/res/abIndex.json'
d=json.load(open(p,encoding='utf-8-sig'))
lst=d['mAbList']
print('total bundles:',len(lst))
names=[i['mOriginName'] for i in lst]
# extension distribution
ext=collections.Counter(os.ext if (os:=n.rsplit('.',1)) and len(n.split('.'))>1 else '(none)' for n in names)
print('top dirs (first path segment):')
c=collections.Counter(n.split('/')[0] for n in names)
for k,v in c.most_common(40): print('  %-30s %d'%(k,v))
print()
pat=re.compile(r'(?i)(proto|net|msg|message|cmd|command|packag|socket|tcp|http|login|server|config|cfg|table|excel|csv|json|xml|configdata|datatb|sproto|protobuf|pb$)')
hits=[n for n in names if pat.search(n)]
print('name hits on protocol/config keywords:',len(hits))
for n in hits[:120]: print('   ',n)
