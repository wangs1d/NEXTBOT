import json

d = json.load(open("/opt/pai/server/data/chat-threads.json", encoding="utf-8"))
for k in ["2378709729@qq.com", "master:2378709729@qq.com"]:
    v = d["sessions"].get(k)
    if not v:
        print("---", k, "missing")
        continue
    msgs = v["messages"]
    print("===", k, "msgs:", len(msgs))
    for i, m in enumerate(msgs):
        c = m.get("content")
        if isinstance(c, list):
            c = str(c)[:60]
        keys = [x for x in m.keys() if x not in ("role", "content")]
        print("[%d]" % i, m.get("role"), "| extra:", keys, "|", str(c)[:70].replace("\n", " "))
