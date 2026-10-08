import io, json, os, re, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from PIL import Image

ROOT = r'C:\yx\data\raw'
UA = 'EcoScrapDatasetBuilder/1.0'
TARGET = int(os.environ.get('OV_TARGET', 160))
QUERIES = {
    'other': ['shoes', 'coffee mug', 'potted plant', 'kitchen utensils', 'books on shelf', 'fruit basket',
              'wooden chair', 'plastic bottle', 'clothes pile', 'cardboard box', 'dog', 'person portrait'],
    'pcb': ['circuit board', 'motherboard', 'printed circuit board electronics', 'smartphone disassembled', 'arduino board', 'raspberry pi', 'old mobile phone', 'hard disk drive', 'router electronics'],
    'copper_wire': ['copper wire', 'electrical cable', 'cable scrap', 'power cord', 'usb cable', 'wire bundle', 'tangled cables', 'extension cord', 'stripped wire'],
    'crt': ['crt television', 'crt monitor', 'old television set', 'cathode ray tube', 'vintage tv', 'old computer monitor', 'tube tv'],
    'lcd': ['lcd monitor', 'flat screen television', 'computer monitor', 'lcd screen', 'led tv', 'broken tv screen', 'laptop screen'],
    'motor': ['electric motor', 'fan motor', 'air conditioner compressor', 'speaker magnet'],
    'plastic': ['computer keyboard', 'remote control', 'computer mouse', 'plastic electronics casing', 'tv remote', 'keyboard keys', 'game controller', 'printer'],
    'li_battery': ['lithium ion battery', 'laptop battery', 'phone battery', '18650 battery', 'power bank', 'battery pack', 'mobile phone battery', 'swollen battery'],
}


def get(url, as_json=False, tries=4):
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=30) as r:
                d = r.read()
            return json.loads(d) if as_json else d
        except urllib.error.HTTPError as e:
            if e.code in (404, 403, 410):
                return None
            time.sleep(3 * (k + 1))
        except Exception:
            time.sleep(2)
    return None


def small(url):
    m = re.match(r'(https://live\.staticflickr\.com/\d+/\d+_[0-9a-f]+)(_[a-z])?\.jpg$', url)
    return m.group(1) + '_n.jpg' if m else url


def fetch_one(args):
    cls, rid, url = args
    path = os.path.join(ROOT, cls, f'ov_{rid}.jpg')
    if os.path.exists(path):
        return 0
    d = get(small(url)) or get(url)
    if not d:
        return 0
    try:
        im = Image.open(io.BytesIO(d)).convert('RGB')
        if min(im.size) < 80:
            return 0
        im.thumbnail((384, 384))
        im.save(path, quality=88)
        return 1
    except Exception:
        return 0


for cls in (sys.argv[1:] or QUERIES):
    os.makedirs(os.path.join(ROOT, cls), exist_ok=True)
    have = len(os.listdir(os.path.join(ROOT, cls)))
    need = TARGET - (len([f for f in os.listdir(os.path.join(ROOT, cls)) if f.startswith('ov_')]) if cls in ('other', 'li_battery') else have)
    if need <= 0:
        continue
    seen, jobs = set(), []
    for q in QUERIES[cls]:
        for page in range(1, 3):
            if len(jobs) >= need * 1.4:
                break
            j = get('https://api.openverse.org/v1/images/?' + urllib.parse.urlencode(
                {'q': q, 'page_size': 20, 'page': page, 'extension': 'jpg'}), as_json=True)
            time.sleep(2.5)
            for r in (j or {}).get('results', []):
                if r['id'] not in seen:
                    seen.add(r['id'])
                    jobs.append((cls, r['id'], r['url']))
    with ThreadPoolExecutor(8) as ex:
        got = sum(ex.map(fetch_one, jobs[:int(need * 1.4)]))
    print(time.strftime('%H:%M:%S'), cls, 'added', got, 'total', len(os.listdir(os.path.join(ROOT, cls))), flush=True)
