import json, sys, os, random, time
from concurrent.futures import ThreadPoolExecutor
from remotezip import RemoteZip
URL = 'https://zenodo.org/records/3371780/files/audio_hex-pickup_debleeded.zip?download=1'
names = [n for n, _ in json.load(open('list.json'))]
want = sorted(n for n in names if n[:2] in sys.argv[1].split(","))
random.seed(0); random.shuffle(want); want = want[: int(sys.argv[2])]
def get(n):
    if os.path.exists(n): return n
    for k in range(3):
        try:
            with RemoteZip(URL) as z: z.extract(n, '.')
            return n
        except Exception as e: time.sleep(2)
    return None
t = time.time()
with ThreadPoolExecutor(12) as ex:
    for i, r in enumerate(ex.map(get, want)): print(i, r, round(time.time() - t), flush=True)
