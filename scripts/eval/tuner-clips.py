# Test clips for scripts/eval/tuner.mts: acoustic bank notes (labeled pitch) and IDMT electric single notes, each
# clean, through a "laptop mic" (low end cut, room, noise) and a "phone" (stronger cut, more noise).
import json, glob, re, numpy as np, soundfile as sf
from scipy.signal import butter, sosfilt, fftconvolve, resample_poly
SR = 48000
rng = np.random.default_rng(0)
bank = json.load(open('/Users/halvis82/Documents/personal_coding/plectrum/public/guitar/v1/bank.json'))
y, sr = sf.read('bank.wav', dtype='float32')
clips = []
for s in bank['slots']:
    if s['fret'] in (0, 2, 5):
        a = int(s['at'] * SR); clips.append(('bank', s['string'], s['fret'], s['midi'], y[a:a + int(3.0 * SR)]))
idmt = '/private/tmp/claude-501/-Users-halvis82-Documents-personal-coding/b264e90d-797a-400c-a1e4-4cb089baa30f/scratchpad/idmt/data/IDMT-SMT-GUITAR_V2/dataset1'
for x in sorted(glob.glob(idmt + '/Fender Strat Clean Neck SC/annotation/*.xml')):
    t = open(x).read()
    if '<expressionStyle>NO' not in t or '<excitationStyle>PK' not in t: continue
    fret = int(re.search(r'<fretNumber>(\d+)', t).group(1))
    if fret not in (0, 5): continue
    w, r = sf.read(x.replace('annotation', 'audio').replace('.xml', '.wav'), dtype='float32')
    clips.append(('idmt', int(re.search(r'<stringNumber>(\d+)', t).group(1)) - 1, fret, float(re.search(r'<pitch>(\d+)', t).group(1)), resample_poly(w, 160, 147).astype(np.float32)))
def room(x):
    n = int(0.4 * SR); ir = rng.standard_normal(n) * np.exp(-np.arange(n) / SR * 6.9 / 0.4); ir[0] = 1
    return fftconvolve(x, ir * 0.3)[: len(x)]
def dev(x, cut, snr):
    x = sosfilt(butter(2, cut, 'highpass', fs=SR, output='sos'), room(x))
    x = x / (np.abs(x).max() + 1e-9) * 0.3
    return (x + rng.standard_normal(len(x)) * 0.3 * 10 ** (-snr / 20)).astype(np.float32)
out = []
for k, (src, st, fret, midi, x) in enumerate(clips):
    for cond, f in [('clean', lambda x: (x / (np.abs(x).max() + 1e-9) * 0.3).astype(np.float32)), ('laptop', lambda x: dev(x, 150, 45)), ('phone', lambda x: dev(x, 250, 35))]:
        z = f(x); name = f'{k:03d}_{cond}.f32'; z.tofile(name)
        out.append({'file': name, 'src': src, 'string': st, 'fret': fret, 'midi': midi, 'cond': cond})
json.dump(out, open('clips.json', 'w'))
print(len(out), 'clips')
