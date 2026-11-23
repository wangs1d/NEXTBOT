import json,sys
data=sys.stdin.read()
start=data.find('{"attributes"')
if start<0: sys.exit("no json")
# find matching end
j=json.loads(data[start:])
target=sys.argv[1]
idx=int(sys.argv[2]) if len(sys.argv)>2 else 0
found=[]
def walk(n):
    a=n.get('attributes',{})
    t=str(a.get('text',''))
    if t==target and a.get('bounds'):
        found.append(a)
    for c in n.get('children',[]): walk(c)
walk(j)
if not found: sys.exit(f"not found: {target}")
if idx>=len(found): sys.exit(f"only {len(found)} matches")
b=found[idx]['bounds'].replace('][',',').strip('[]').split(',')
x1,y1,x2,y2=map(int,b)
print(f"{(x1+x2)//2},{(y1+y2)//2}")
