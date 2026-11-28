# conv2d 微基准：对比 cudnn 开/关
import time

import torch

torch.backends.cudnn.benchmark = False

x = torch.randn(1, 3, 512, 512, device="cuda")
conv = torch.nn.Conv2d(3, 64, 3, padding=1).cuda().eval()

with torch.no_grad():
    # cudnn on
    torch.cuda.synchronize()
    t0 = time.time()
    for _ in range(10):
        y = conv(x)
    torch.cuda.synchronize()
    t_on = time.time() - t0
    print(f"conv2d cudnn=ON : {t_on:.2f}s /10次")

    # cudnn off
    torch.backends.cudnn.enabled = False
    torch.cuda.synchronize()
    t0 = time.time()
    for _ in range(10):
        y = conv(x)
    torch.cuda.synchronize()
    t_off = time.time() - t0
    print(f"conv2d cudnn=OFF: {t_off:.2f}s /10次")
