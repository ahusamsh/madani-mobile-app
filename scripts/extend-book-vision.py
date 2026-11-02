"""Ensure each of the 104 Madani book pages has a local reference image for camera matching.
No AI server, GPU trainer or cloud API is used. Existing page images and audio are preserved.
"""
import json
from pathlib import Path
import fitz
ROOT = Path(__file__).resolve().parent.parent
p = ROOT / 'data/audio-library.json'
lib = json.loads(p.read_text(encoding='utf8'))
book = fitz.open(ROOT / 'books/ar.pdf')
out = ROOT / 'vision/reference-pages'
out.mkdir(exist_ok=True, parents=True)
missing = []
for page_no in range(1, book.page_count + 1):
    page = lib['pages'].get(str(page_no))
    if page is None:
        raise ValueError(f'library missing book page {page_no}')
    image = page.get('image')
    if image and (ROOT / image.removeprefix('./')).is_file():
        continue
    destination = out / f'page-{page_no:03}.png'
    if not destination.exists():
        src = book.load_page(page_no - 1)
        scale = 800 / src.rect.width
        src.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False).save(destination)
    page['image'] = f'./vision/reference-pages/page-{page_no:03}.png'
    missing.append(page_no)
assert book.page_count == 104
assert all((ROOT / p['image'].removeprefix('./')).exists() for p in lib['pages'].values())
p.write_text(json.dumps(lib, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf8')
print('Book pages:', book.page_count, 'generated reference images:', missing, 'total images:', len(lib['pages']))
