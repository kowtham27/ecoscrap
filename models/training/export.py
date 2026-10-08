"""Export the trained classifier to ONNX + a labels file the browser reads, and report
per-class accuracy on the held-out validation photos."""
import json, os, shutil
import numpy as np
import onnxruntime as ort
from PIL import Image
from ultralytics import YOLO

OUT = r'C:\python\HackITon 26\EcoScrap-AI\models'
BEST = r'C:\yx\runs\escrap2\weights\best.pt'
MATERIAL_BY_CLASS = {
    'pcb': 'mat-pcb-high', 'copper_wire': 'mat-copper-wire', 'li_battery': 'mat-li-battery',
    'crt': 'mat-crt-monitors', 'lcd': 'mat-lcd-led', 'motor': 'mat-electric-motors',
    'plastic': 'mat-e-plastics', 'other': None,
}

model = YOLO(BEST)
names = [model.names[i] for i in range(len(model.names))]
onnx_path = model.export(format='onnx', imgsz=224, opset=17, simplify=True, dynamic=False)
os.makedirs(OUT, exist_ok=True)
shutil.copy(onnx_path, os.path.join(OUT, 'escrap-yolo11s-cls.onnx'))
json.dump({'imgsz': 224, 'classes': names, 'materialByClass': {c: MATERIAL_BY_CLASS[c] for c in names}},
          open(os.path.join(OUT, 'escrap-labels.json'), 'w'), indent=2)


# Same pre-processing the browser does (js/yolo-scrap.js): short side -> 224, centre crop, /255.
def prep(path, size=224):
    im = Image.open(path).convert('RGB')
    s = size / min(im.size)
    im = im.resize((round(im.width * s), round(im.height * s)), Image.BILINEAR)
    l, t = (im.width - size) // 2, (im.height - size) // 2
    a = np.asarray(im.crop((l, t, l + size, t + size)), dtype=np.float32) / 255
    return a.transpose(2, 0, 1)[None]


sess = ort.InferenceSession(onnx_path)
inp = sess.get_inputs()[0].name
val = r'C:\yx\data\ds\val'
total = correct = 0
per = {}
for cls in names:
    files = os.listdir(os.path.join(val, cls))
    ok = 0
    for f in files:
        p = sess.run(None, {inp: prep(os.path.join(val, cls, f))})[0][0]
        ok += names[int(p.argmax())] == cls
    per[cls] = (ok, len(files))
    total += len(files); correct += ok
print('softmax sums to', round(float(p.sum()), 4))
for c, (ok, n) in per.items():
    print(f'{c:12s} {ok:3d}/{n:3d}  {100 * ok / n:5.1f}%')
print(f'OVERALL {correct}/{total} = {100 * correct / total:.1f}% (browser-identical preprocessing, held-out photos)')
print('model size MB', round(os.path.getsize(os.path.join(OUT, 'escrap-yolo11s-cls.onnx')) / 1e6, 1))


# Temperature calibration: the raw softmax is over-confident (e.g. 98% on a wrong answer).
# Fit one temperature T on the held-out photos so probabilities match how often it's right;
# the browser applies p^(1/T), renormalised. Stored in the labels file.
P, Y = [], []
for ci, cls in enumerate(names):
    for f in os.listdir(os.path.join(val, cls)):
        P.append(sess.run(None, {inp: prep(os.path.join(val, cls, f))})[0][0]); Y.append(ci)
P, Y = np.clip(np.array(P), 1e-9, 1), np.array(Y)
def nll(T):
    q = P ** (1 / T); q /= q.sum(1, keepdims=True)
    return -np.log(q[np.arange(len(Y)), Y]).mean()
T = min(np.arange(0.5, 6.01, 0.05), key=nll)
q = P ** (1 / T); q /= q.sum(1, keepdims=True)
conf = q.max(1); right = q.argmax(1) == Y
print(f'temperature T={T:.2f}  NLL raw={nll(1.0):.3f} -> {nll(T):.3f}')
for lo in (0.55, 0.7, 0.85):
    m = conf >= lo
    print(f'  answers with calibrated conf >= {lo:.2f}: {m.mean()*100:.0f}% of photos, correct {right[m].mean()*100:.0f}% of the time')
meta = json.load(open(os.path.join(OUT, 'escrap-labels.json')))
meta['temperature'] = round(float(T), 2)
json.dump(meta, open(os.path.join(OUT, 'escrap-labels.json'), 'w'), indent=2)
