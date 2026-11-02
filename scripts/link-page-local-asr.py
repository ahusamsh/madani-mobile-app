"""Link additional Madani words by SAME-PAGE audio transcription with exact lexical evidence.
No trainer, web API or generated voices. Ambiguous samples remain unmatched.
All new alignments are unreviewed until a human listens to them.
"""
from pathlib import Path
from collections import defaultdict,Counter
from concurrent.futures import ThreadPoolExecutor,as_completed
import sys,json,re,subprocess,hashlib,math
import imageio_ffmpeg
sys.path.insert(0,str(Path(__file__).parent))
from align_book import ROOT,LIB,TRANS,OCR,normalize
FF=imageio_ffmpeg.get_ffmpeg_exe()
OUT=ROOT/'library-clips';OUT.mkdir(exist_ok=True)
existing=LIB['segments']
audit=[];jobs=[];stat=Counter()
def overlap(a,b):
 x,y,w,h=a;X,Y,W,H=b
 return max(0,min(x+w,X+W)-max(x,X))*max(0,min(y+h,Y+H)-max(y,Y))/max(1e-10,w*h)
def valid(z):
 box=z.get('box')
 return isinstance(box,list) and len(box)==4 and .005<box[2]<.43 and .008<box[3]<.17 and 0<=box[0]<1 and 0<=box[1]<1 and box[0]+box[2]<=1.01 and box[1]+box[3]<=1.01
def add(page,z,word,asr,method,confidence,source_zone=None):
 zid=z['id']
 if zid in existing or z.get('visionSkip'):return False
 start,end=asr['start'],asr['end']
 if not .19<=end-start<=4.3:return False
 src=ROOT/'library-audio'/f'page-{page-2:03d}.mp3'
 if not src.is_file():return False
 # Reject OCR rectangles on top of an already playable word.
 if method.startswith('ocr') and any(t['id'] in existing and overlap(z['box'],t['box'])>.18 for t in LIB['pages'][str(page)]['zones']):return False
 rel=f'./library-clips/lex-{page:03d}-{re.sub("[^a-zA-Z0-9_-]","",zid)}.mp3'
 clip=ROOT/rel[2:]
 existing[zid]=dict(page=page,start=round(start,3),end=round(end,3),clip=rel,reviewed=False,
  status='machine-aligned-pending-listening',alignmentMethod=method,confidence=round(float(confidence),3),
  transcript=asr['text'],sourcePage=page)
 jobs.append((src,clip,start,end))
 audit.append(dict(page=page,zone=zid,printed=z['text'],spoken=asr['text'],confidence=round(float(confidence),3),
  audioStart=round(start,3),audioEnd=round(end,3),method=method))
 stat[method]+=1
 return True
for tr in sorted(TRANS.glob('*.json')):
 page=int(tr.stem)
 if page<=2:continue
 words=json.loads(tr.read_text('utf8'))['words']
 tokens=defaultdict(list)
 for w in words:
  n=normalize(w.get('text',''))
  if len(n)>=4 and w['prob']>=.85 and .19<=w['end']-w['start']<=4.3: tokens[n].append(w)
 if not tokens:continue
 zones=LIB['pages'][str(page)]['zones']
 used_indices=set()
 # An exact page-local word is stronger than a cross-page string match.
 for i,z in enumerate(zones):
  if z['id'] in existing or z.get('visionSkip') or not valid(z):continue
  n=normalize(z.get('text',''))
  if len(n)<4 or n not in tokens:continue
  # Avoid treating a page's title/large phrase spanning other linked boxes as one word.
  if any(k!=i and t['id'] in existing and overlap(z['box'],t['box'])>.20 for k,t in enumerate(zones)):continue
  candidates=sorted(tokens[n],key=lambda w:(-w['prob'],w['start']))
  w=candidates[0]
  if add(page,z,z['text'],w,'page-local-exact-word',w['prob']):used_indices.add(i)
 # OCR rescue for text whose PDF extraction is broken; high confidence and *unambiguous*.
 op=OCR/f'{page:03}.json'
 if not op.is_file():continue
 ocr=json.loads(op.read_text('utf8'))['words']
 ocr_occ=Counter(normalize(x.get('text','')) for x in ocr if x.get('conf',0)>=74)
 for j,record in enumerate(ocr):
  n=normalize(record.get('text',''));conf=float(record.get('conf',0))
  if n not in tokens or len(n)<5 or conf<65 or ocr_occ[n]!=1 or len(tokens[n])!=1:continue
  z={'id':f'p{page}-ocr-reliable-{j+1:03d}','text':record['text'],'box':record['box'],
     'spokenText':record['text'],'kind':'word','reviewed':False,'geometryReviewed':False,
     'extractionStatus':'ocr-asr-exact-needs-human-review','ocrConfidence':conf}
  if not valid(z):continue
  if any(overlap(z['box'],t['box'])>.24 for t in zones if t['id'] in existing):continue
  w=tokens[n][0]
  if w['prob']<.90:continue
  if add(page,z,z['text'],w,'ocr-highconf-exact-word',min(w['prob'],conf/100)):
   # Replace only conflicting *unlinked* coarse PDF zone hit targets.
   for prev in zones:
    if prev['id'] not in existing and not prev.get('visionSkip') and overlap(z['box'],prev.get('box',[0,0,0,0]))>.55:
     prev['visionSkip']=True
   zones.append(z)
print('PLANNED',dict(stat),'total',len(jobs),flush=True)
report=ROOT/'vision'/'alignment'/'lexical-rescue-audit.json'
report.write_text(json.dumps(audit,ensure_ascii=False,indent=1),'utf8')
if '--dry-run' in sys.argv:sys.exit(0)
def crop(task):
 src,dst,start,end=task
 if dst.is_file() and dst.stat().st_size>700:return True
 dur=end-start+.055; s=max(0,start-.027)
 cmd=[FF,'-nostdin','-hide_banner','-loglevel','error','-y','-ss',f'{s:.3f}','-i',str(src),'-t',f'{dur:.3f}',
      '-vn','-ac','1','-ar','44100','-b:a','96k',str(dst)]
 try:
  p=subprocess.run(cmd,capture_output=True,timeout=60)
  return p.returncode==0 and dst.is_file() and dst.stat().st_size>700
 except Exception:return False
with ThreadPoolExecutor(max_workers=4) as pool:
 ok=list(pool.map(crop,jobs))
if not all(ok):
 for task,success in zip(jobs,ok):
  if not success:print('FAILED',task[1],flush=True)
 raise RuntimeError('Refused to save library because audio crop failure')
(ROOT/'data/audio-library.json').write_text(json.dumps(LIB,ensure_ascii=False,separators=(',',':'))+'\n','utf8')
print('SAVED',len(existing),'new',len(jobs),'statuses need listening review',flush=True)
