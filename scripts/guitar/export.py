"""Exports the Riley et al. guitar transcription CRNN (a Kong et al. piano model, from
huggingface.co/xavriley/midi-transcription-models) for the browser: an ONNX graph whose weights live in
a separate file, shipped as float16 (half the download) and expanded to float32 in the worker.
Usage: python export.py <checkpoint.pth> <out-dir> <name> [--single]
  writes <name>.onnx and <name>.f16; with --single, one self-contained float32 <name>.onnx (for benchmarks)"""

import os
import sys

import numpy as np
import onnx
import torch
from onnx.external_data_helper import convert_model_to_external_data
from piano_transcription_inference.models import Regress_onset_offset_frame_velocity_CRNN

ckpt, out_dir, name = sys.argv[1:4]
model = Regress_onset_offset_frame_velocity_CRNN(frames_per_second=100, classes_num=88)
state = torch.load(ckpt, map_location="cpu", weights_only=False)
model.load_state_dict(state["model"] if "model" in state else state)
model.eval()


class Outputs(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, audio):
        d = self.m(audio)
        return d["reg_onset_output"], d["reg_offset_output"], d["frame_output"], d["velocity_output"]


tmp = os.path.join(out_dir, name + ".tmp.onnx")
with torch.no_grad():
    torch.onnx.export(Outputs(model).eval(), (torch.zeros(1, 160000),), tmp, input_names=["audio"], output_names=["onset", "offset", "frame", "velocity"],
                      dynamic_axes={k: {0: "n"} for k in ["audio", "onset", "offset", "frame", "velocity"]}, opset_version=17, dynamo=False)
if "--single" in sys.argv:
    os.replace(tmp, os.path.join(out_dir, name + ".onnx"))
    raise SystemExit(0)
m = onnx.load(tmp)
os.remove(tmp)
# every large tensor goes to one external file; all of them must be float32 to be stored as halves
for t in m.graph.initializer:
    if t.data_type != onnx.TensorProto.FLOAT and len(t.raw_data) > 1024:
        raise SystemExit(f"non-float initializer {t.name}")
convert_model_to_external_data(m, all_tensors_to_one_file=True, location=name + ".data", size_threshold=1024)
onnx.save_model(m, os.path.join(out_dir, name + ".onnx"))
raw = np.fromfile(os.path.join(out_dir, name + ".data"), np.float32)
raw.astype(np.float16).tofile(os.path.join(out_dir, name + ".f16"))
os.remove(os.path.join(out_dir, name + ".data"))
print("graph", os.path.getsize(os.path.join(out_dir, name + ".onnx")), "weights f16", os.path.getsize(os.path.join(out_dir, name + ".f16")))
