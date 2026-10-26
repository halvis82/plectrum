"""Exports a trained string classifier to ONNX. Usage: python export.py <net.pt> <out.onnx>"""
import os
import sys

import torch

sys.path.insert(0, os.path.dirname(__file__))
from train import StringNet  # noqa: E402

net = StringNet()
net.load_state_dict(torch.load(sys.argv[1], map_location="cpu"))
net.eval()
torch.onnx.export(net, (torch.zeros(1, 12, 200), torch.tensor([60.0])), sys.argv[2], input_names=["patch", "midi"], output_names=["logits"],
                  dynamic_axes={"patch": {0: "n"}, "midi": {0: "n"}, "logits": {0: "n"}}, opset_version=17, dynamo=False)
