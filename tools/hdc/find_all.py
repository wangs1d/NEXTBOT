import json,sys
data=sys.stdin.read()
start=data.find('{"attributes"')
j=json.loads(data[start:])
target=sys.argv[1]
found=[]
def walk(n):
    a=n.get('attributes',{})
    if str(a.get('text',''))==target and a.get('bounds'):
        found.append((a['bounds'],a.get('type','')))
    for c in n.get('children',[]): walk(c)
walk(j)
for b,t in found: print(b,t)
