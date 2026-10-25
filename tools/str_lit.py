import re
d=open('/home/qkzx/sld/sld/assets/bin/Data/Managed/Metadata/global-metadata.dat','rb').read()
lo,hi=0x20A10,0x8B704
region=d[lo:hi]
out=open('/home/qkzx/sld/sld/strlit.txt','w',encoding='utf8')
# utf8 runs
for m in re.finditer(rb'[\x20-\x7e\xe4-\xe9\x80-\xbf]{6,}',region):
    out.write(m.group().decode('utf8','replace')+'\n')
# utf16le runs
for m in re.finditer(rb'(?:[\x20-\x7e]\x00){6,}',region):
    out.write(m.group().decode('utf16','replace')+'\n')
out.close()
print('lines',sum(1 for _ in open('/home/qkzx/sld/sld/strlit.txt')))
