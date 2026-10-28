# Test clips for scripts/eval/tuner.mts (SESSION=1). Tuning sessions: one open string plucked 4 times (2 s apart) while the guitar's other open strings
# ring quietly (sympathetic resonance and earlier plucks), through a mic, a laptop and a phone.
# Notes: IDMT-SMT-Guitar open strings, 4 guitars.
import json, glob, re, numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt, fftconvolve, resample_poly
SR = 48000
rng = np.random.default_rng(2)
I = '/private/tmp/claude-501/-Users-halvis82-Documents-personal-coding/b264e90d-797a-400c-a1e4-4cb089baa30f/scratchpad/idmt/data/IDMT-SMT-GUITAR_V2/dataset1'
out = []
for g in sorted(glob.glob(I + '/*')):
    if 'Chords' in g: continue
    opens = {}
    for x in sorted(glob.glob(g + '/annotation/*.xml')):
        t = open(x).read()
        if '<fretNumber>0<' not in t or '<expressionStyle>NO' not in t: continue
        s = int(re.search(r'<stringNumber>(\d+)', t).group(1)) - 1
        if s in opens: continue
        w, r = sf.read(x.replace('annotation', 'audio').replace('.xml', '.wav'), dtype='float32')
        on = float(re.search(r'<onsetSec>([\d.]+)', t).group(1))
        w = w[int(on * r):]
        opens[s] = (resample_poly(w, 160, 147).astype(np.float32), int(re.search(r'<pitch>(\d+)', t).group(1)))
    if len(opens) < 6: continue
    n = int(8.5 * SR)
    for s, (w, midi) in opens.items():
        y = np.zeros(n, np.float32)
        for k in range(4):
            a = int((0.3 + 2 * k) * SR); seg = w[: n - a] * rng.uniform(0.7, 1.0); y[a:a + len(seg)] += seg
        for o, (wo, _) in opens.items():
            if o == s: continue
            seg = wo[:n] * 10 ** (rng.uniform(-26, -16) / 20); y[: len(seg)] += seg
        ir = rng.standard_normal(int(0.35 * SR)) * np.exp(-np.arange(int(0.35 * SR)) / SR * 6.9 / 0.35); ir[0] = 1
        y = fftconvolve(y, ir * 0.25)[:n]
        for cond, cut, snr in [('mic', None, 55), ('laptop', 150, 45), ('phone', 250, 35)]:
            z = y if cut is None else sosfilt(butter(2, cut, 'highpass', fs=SR, output='sos'), y)
            z = z / (np.abs(z).max() + 1e-9) * 0.3 + rng.standard_normal(n) * 0.3 * 10 ** (-snr / 20)
            name = f'{len(out):03d}_{cond}.f32'; z.astype(np.float32).tofile(name)
            out.append({'file': name, 'src': 'session', 'cond': cond, 'midi': midi, 'string': s})
json.dump(out, open('clips.json', 'w'))
print(len(out), 'sessions')
