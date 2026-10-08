# On-device e-scrap classifier

`escrap-yolo11s-cls.onnx` is Ultralytics **YOLO11s-cls** (ImageNet-pretrained) fine-tuned to
sort a photo into one of 8 classes. The browser runs it with ONNX Runtime Web
(`vendor/onnxruntime-web`, MIT) — see `js/yolo-scrap.js`. No API key, no cost, works offline.

| Class | Platform material |
|---|---|
| `pcb` | `mat-pcb-high` (bare boards, whole phones/laptops/routers) |
| `copper_wire` | `mat-copper-wire` |
| `li_battery` | `mat-li-battery` |
| `crt` | `mat-crt-monitors` |
| `lcd` | `mat-lcd-led` |
| `motor` | `mat-electric-motors` (motors, fans, compressors, AC units) |
| `plastic` | `mat-e-plastics` (keyboards, remotes, mice, casings) |
| `other` | not e-waste — the scanner never prices it |

`escrap-labels.json` holds the class order, the class → material map and a calibration
`temperature`. The browser applies `p^(1/T)` (renormalised) because the raw softmax is
over-confident.

## Accuracy (held-out photos, same preprocessing as the browser)

- Top-1 overall: **69%**. Strong: motor 96%, pcb 86%, other 79%. Weak: crt 32%, plastic 45%,
  copper wire 48%, lcd 52%, battery 68%.
- After calibration, photos where it is **≥ 70% sure** (about half of all photos) are correct
  **~90%** of the time. That is the auto-accept threshold in `js/scrap-scanner.js`. Below it the
  customer picks from the model's top guesses, or Gemini's free tier answers if available.

These numbers come from about 2,700 web photos. Real customer photos will differ. Retraining on
photos taken through the app is the biggest accuracy win.

## Training data (all openly licensed)

- **GIZ/e-waste-dataset-yolo-labels** (CC-BY-4.0, GIZ Data Lab) — Ghana scrapyard photos,
  cropped to the labelled computers/laptops (→ pcb) and compressors/ACs (→ motor).
- **NeoAivara/Waste_Classification_data** (Apache-2.0) — battery photos and non-e-waste
  household waste for `other` (capped so its studio look doesn't dominate).
- **Openverse** search results (mostly Flickr, various Creative Commons licences) for each class.

## Rebuilding

The scripts in `training/` reproduce the model. They use absolute `C:\yx\...` working paths; edit
them before reuse. Order: `build_dataset.py` (GIZ + NeoAivara), `openverse.py`, split into
`train/`/`val/` folders, `train.py` (about 7 min on an RTX 2050), `export.py` (writes the ONNX +
labels here and prints per-class accuracy and the calibration temperature). It needs
`pip install ultralytics onnx onnxslim onnxruntime pyarrow` and a CUDA build of PyTorch for GPU
training.
