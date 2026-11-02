"""Offline OCR of Arabic PDF to get actual word boxes; never send book images to a cloud API."""
from pathlib import Path
import subprocess,json,sys,time,os,csv,io
import fitz
ROOT=Path(__file__).resolve().parent.parent
TESS=r'C:\Program Files\Tesseract-OCR\tesseract.exe'
TESSDATA=r'C:\Users\00003\Projects\madani-dev-tools\tessdata'
OUT=ROOT/'vision'/'alignment'/'ocr'
OUT.mkdir(parents=True,exist_ok=True)
pdf=fitz.open(ROOT/'books/ar.pdf')
pages=[int(x) for x in sys.argv[1].split(',')] if len(sys.argv)>1 else list(range(1,pdf.page_count+1))
print('OCR pages',len(pages),flush=True)
for i,p in enumerate(pages,1):
    dst=OUT/f'{p:03d}.json'
    if dst.exists():continue
    t=time.perf_counter();page=pdf[p-1];scale=2.7
    pix=page.get_pixmap(matrix=fitz.Matrix(scale,scale),colorspace=fitz.csGRAY,alpha=False)
    # Tesseract input via temp file, normalized bounding box coordinates.
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        src=Path(tmp)/'page.png';pix.save(src)
        cmd=[TESS,str(src),'stdout','--tessdata-dir',TESSDATA,'-l','ara','--psm','11','-c','tessedit_create_tsv=1','-c','tessedit_create_txt=0']
        env=os.environ.copy();env['OMP_THREAD_LIMIT']='2'
        proc=subprocess.run(cmd,capture_output=True,encoding='utf-8',errors='replace',env=env,timeout=120)
        if proc.returncode:
            print('FAIL',p,proc.stderr[:200],flush=True);continue
    words=[]
    print('TSV head',repr(proc.stdout[:160]),flush=True) if p==pages[0] else None
    for row in csv.DictReader(io.StringIO(proc.stdout.lstrip('\ufeff')),delimiter='\t'):
        if row['level']!='5' or not row['text'].strip():continue
        try:
            conf=float(row['conf']);x=float(row['left'])/pix.width;y=float(row['top'])/pix.height
            w=float(row['width'])/pix.width;h=float(row['height'])/pix.height
        except Exception:continue
        if w<0.006 or h<0.006:continue
        words.append(dict(text=row['text'].strip(),conf=round(conf,1),box=[round(x,7),round(y,7),round(w,7),round(h,7)],
            block=int(row['block_num']),paragraph=int(row['par_num']),line=int(row['line_num']),word=int(row['word_num'])))
    data=dict(page=p,engine='tesseract-ara-best-5.4',width=pix.width,height=pix.height,words=words,reviewed=False)
    dst.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')),'utf8')
    print(f'OCR page={p} words={len(words)} sec={time.perf_counter()-t:.1f} [{i}/{len(pages)}]',flush=True)
