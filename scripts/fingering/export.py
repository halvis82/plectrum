"""Exports the fingering model to ONNX: input x [1, T, 4] (model.features) -> logits [1, T, 6].
Usage: python export.py <model.pt> <out.onnx>"""

import os
import sys

import torch

sys.path.insert(0, os.path.dirname(__file__))
from model import FingerNet  # noqa: E402

net = FingerNet()
net.load_state_dict(torch.load(sys.argv[1], map_location="cpu"))
net.eval()
x = torch.zeros(1, 256, 4)
x[..., 0] = 52
torch.onnx.export(net, (x,), sys.argv[2], input_names=["x"], output_names=["logits"], dynamic_axes={"x": {1: "t"}, "logits": {1: "t"}}, opset_version=17, dynamo=False)
print("ok", os.path.getsize(sys.argv[2]))
