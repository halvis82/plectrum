"""Splits the chord model into a graph and float16 weights (half the download; the worker turns them back
into float32), and checks the result against the original on random normalized inputs.
Usage: python chords_half.py <btc.onnx> <out dir> <name>"""

import os
import sys

import numpy as np
import onnx
import onnxruntime as ort
from onnx.external_data_helper import convert_model_to_external_data

src, out_dir, name = sys.argv[1:4]
m = onnx.load(src)
for t in m.graph.initializer:
    if t.data_type != onnx.TensorProto.FLOAT and len(t.raw_data) > 1024:
        raise SystemExit(f"non-float initializer {t.name}")
convert_model_to_external_data(m, all_tensors_to_one_file=True, location=name + ".data", size_threshold=1024)
onnx.save_model(m, os.path.join(out_dir, name + ".onnx"))
data = os.path.join(out_dir, name + ".data")
raw = np.fromfile(data, np.float32)
half = raw.astype(np.float16)
half.tofile(os.path.join(out_dir, name + ".f16"))
# what the browser will run: the halves widened back to float32
half.astype(np.float32).tofile(data)
a = ort.InferenceSession(src)
b = ort.InferenceSession(os.path.join(out_dir, name + ".onnx"))
inp = a.get_inputs()[0]
rng = np.random.default_rng(0)
agree, worst = 0, 0.0
for _ in range(50):
    x = rng.standard_normal([d if isinstance(d, int) else 1 for d in inp.shape]).astype(np.float32)
    ya, yb = a.run(None, {inp.name: x})[0], b.run(None, {inp.name: x})[0]
    worst = max(worst, float(np.abs(ya - yb).max()))
    agree += float((ya.argmax(-1) == yb.argmax(-1)).mean())
os.remove(data)
print(f"graph {os.path.getsize(os.path.join(out_dir, name + '.onnx'))} bytes, weights {half.nbytes} bytes; same chord on {100 * agree / 50:.2f}% of frames, largest log-prob difference {worst:.4f}")
