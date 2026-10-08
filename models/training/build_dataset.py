"""Builds an e-scrap image-classification dataset for YOLO11s-cls.

Sources (all openly licensed):
  - Wikimedia Commons category photos (various CC licences) — fetched politely.
  - GIZ/e-waste-dataset-yolo-labels (CC-BY-4.0) — real Ghana scrapyard photos, cropped to boxes.
  - NeoAivara/Waste_Classification_data (Apache-2.0) — batteries + non-e-waste "other" class.
"""
import urllib.error, io, json, os, random, sys, time, urllib.parse, urllib.request
from PIL import Image

ROOT = r'C:\yx\data\raw'
UA = 'EcoScrapDatasetBuilder/1.0 (hackathon e-waste classifier; contact via github govardhanan2612)'
CAP = 420
random.seed(7)

COMMONS = {
    'pcb': ['Printed circuit boards', 'Motherboards', 'Mobile phone internals', 'Smartphones'],
    'copper_wire': ['Power cables', 'Copper wire', 'Electrical wires', 'Electrical cables', 'Coaxial cables'],
    'li_battery': ['Lithium-ion batteries', 'Laptop batteries', 'Mobile phone batteries', '18650 batteries'],
    'crt': ['Cathode ray tube televisions', 'CRT monitors', 'Cathode ray tubes', 'CRT televisions'],
    'lcd': ['LCD monitors', 'LCD televisions', 'Computer monitors', 'Flat panel displays'],
    'motor': ['Electric motors', 'Electric fans', 'Loudspeakers', 'Neodymium magnets'],
    'plastic': ['Computer keyboards', 'Remote controls', 'Computer mice'],
}
GIZ_MAP = {'Computers': 'pcb', 'Laptops': 'pcb', 'Compressors': 'motor', 'ACs': 'motor'}
NEO = {'battery': 0, 'other': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]}


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def http(url, tries=6, as_json=False):
    delay = 5
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            if as_json:
                return json.loads(data)
            return data
        except urllib.error.HTTPError as e:
            if e.code in (403, 404, 410):
                return None
            log('  retry', e.code, f'sleep {delay}s')
            time.sleep(delay)
            delay = min(delay * 2, 60)
        except Exception as e:  # rate-limit text / timeouts
            log('  retry', type(e).__name__, str(e)[:80], f'sleep {delay}s')
            time.sleep(delay)
            delay = min(delay * 2, 120)
    return None


def count(cls):
    d = os.path.join(ROOT, cls)
    return len(os.listdir(d)) if os.path.isdir(d) else 0


def save(cls, raw_bytes, name, crop=None):
    d = os.path.join(ROOT, cls)
    os.makedirs(d, exist_ok=True)
    try:
        im = Image.open(io.BytesIO(raw_bytes)).convert('RGB')
        if crop:
            im = im.crop(crop)
        if min(im.size) < 64:
            return False
        im.thumbnail((384, 384))
        im.save(os.path.join(d, name + '.jpg'), quality=88)
        return True
    except Exception:
        return False


# ---------------- Wikimedia Commons ----------------
API = 'https://commons.wikimedia.org/w/api.php'


def commons_api(params):
    params = {**params, 'format': 'json'}
    time.sleep(1.5)
    return http(API + '?' + urllib.parse.urlencode(params), as_json=True)


def commons_files(cat, depth=1, seen=None):
    seen = seen if seen is not None else set()
    if cat in seen:
        return []
    seen.add(cat)
    out, cont = [], {}
    while True:
        j = commons_api({'action': 'query', 'generator': 'categorymembers', 'gcmtitle': 'Category:' + cat,
                         'gcmtype': 'file', 'gcmlimit': 50, 'prop': 'imageinfo', 'iiprop': 'url|mime',
                         'iiurlwidth': 330, **cont})
        if not j:
            break
        for p in (j.get('query') or {}).get('pages', {}).values():
            ii = (p.get('imageinfo') or [{}])[0]
            if ii.get('mime') in ('image/jpeg', 'image/png') and ii.get('thumburl'):
                out.append((p['title'], ii['thumburl']))
        if 'continue' in j and len(out) < 600:
            cont = {k: v for k, v in j['continue'].items()}
        else:
            break
    if depth > 0:
        j = commons_api({'action': 'query', 'list': 'categorymembers', 'cmtitle': 'Category:' + cat,
                         'cmtype': 'subcat', 'cmlimit': 30})
        for sc in ((j or {}).get('query') or {}).get('categorymembers', [])[:20]:
            out += commons_files(sc['title'].split(':', 1)[1], depth - 1, seen)
    return out


def build_commons():
    for cls, cats in COMMONS.items():
        files = []
        for c in cats:
            got = commons_files(c)
            log(f'commons {cls} <- {c}: {len(got)}')
            files += got
        uniq = list(dict(files).items())
        random.shuffle(uniq)
        n = 0
        for title, url in uniq:
            if count(cls) >= CAP:
                break
            data = http(url)
            time.sleep(0.35)
            if data and save(cls, data, 'wc_' + str(abs(hash(title)))):
                n += 1
        log(f'commons {cls}: saved {n} (total {count(cls)})')


# ---------------- GIZ scrapyard photos ----------------
def build_giz(max_images=150):
    base = 'https://huggingface.co/datasets/GIZ/e-waste-dataset-yolo-labels/resolve/main/YOLO%20with%20Pictures/'
    meta = http('https://huggingface.co/api/datasets/GIZ/e-waste-dataset-yolo-labels', as_json=True)
    names = http(base + 'classes.txt').decode().split()
    labels = [s['rfilename'] for s in meta['siblings'] if s['rfilename'].startswith('YOLO with Pictures/labels/')]
    image_by_stem = {os.path.splitext(os.path.basename(s['rfilename']))[0]: os.path.basename(s['rfilename'])
                     for s in meta['siblings'] if s['rfilename'].startswith('YOLO with Pictures/images/')}
    random.shuffle(labels)
    used = 0
    for lf in labels:
        if used >= max_images:
            break
        txt = http(base + 'labels/' + urllib.parse.quote(os.path.basename(lf)))
        if not txt:
            continue
        boxes = []
        for line in txt.decode().splitlines():
            parts = line.split()
            if len(parts) == 5 and names[int(parts[0])] in GIZ_MAP:
                boxes.append((GIZ_MAP[names[int(parts[0])]], *map(float, parts[1:])))
        if not boxes:
            continue
        stem = os.path.splitext(os.path.basename(lf))[0]
        if stem not in image_by_stem:
            continue
        img = http(base + 'images/' + urllib.parse.quote(image_by_stem[stem]))
        if not img:
            continue
        try:
            W, H = Image.open(io.BytesIO(img)).size
        except Exception:
            continue
        for i, (cls, cx, cy, w, h) in enumerate(boxes):
            if count(cls) >= CAP:
                continue
            pad = 0.06
            box = (max(0, (cx - w / 2 - pad) * W), max(0, (cy - h / 2 - pad) * H),
                   min(W, (cx + w / 2 + pad) * W), min(H, (cy + h / 2 + pad) * H))
            save(cls, img, f'giz_{stem}_{i}', crop=box)
        used += 1
        if used % 25 == 0:
            log(f'giz images used {used}; pcb={count("pcb")} motor={count("motor")}')
    log(f'giz done: pcb={count("pcb")} motor={count("motor")}')


# ---------------- NeoAivara waste set ----------------
def build_neo():
    ds = 'NeoAivara%2FWaste_Classification_data'
    plan = [('li_battery', [0], 260), ('other', NEO['other'], CAP)]
    for cls, label_ids, want in plan:
        per_label = max(1, want // len(label_ids))
        for lid in label_ids:
            got = 0
            offset = random.randint(0, 200)
            while got < per_label and count(cls) < (CAP if cls == 'other' else CAP):
                url = (f'https://datasets-server.huggingface.co/filter?dataset={ds}&config=default&split=train'
                       f'&where=' + urllib.parse.quote(f'"label"={lid}') + f'&offset={offset}&length=50')
                j = http(url, as_json=True)
                rows = (j or {}).get('rows') or []
                if not rows:
                    break
                for r in rows:
                    if got >= per_label:
                        break
                    src = r['row']['image']['src']
                    data = http(src)
                    if data and save(cls, data, f'neo_{lid}_{offset}_{r["row_idx"]}'):
                        got += 1
                offset += 50
                time.sleep(0.5)
            log(f'neo {cls} label {lid}: {got} (total {count(cls)})')


if __name__ == '__main__':
    steps = sys.argv[1:] or ['neo', 'giz', 'commons']
    for s in steps:
        log('=== step', s)
        {'neo': build_neo, 'giz': build_giz, 'commons': build_commons}[s]()
    log('FINAL', {c: count(c) for c in sorted(os.listdir(ROOT))})
