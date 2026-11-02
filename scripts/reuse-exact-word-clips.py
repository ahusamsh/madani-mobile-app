"""Reuse only already-isolated ORIGINAL word clips for exactly identical printed words.
No synthesized audio; no cross-language reuse; generated mappings remain machine-unreviewed.
"""
import json,shutil,re,collections,unicodedata
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
p=ROOT/'data/audio-library.json'; lib=json.loads(p.read_text('utf8')); segments=lib['segments']
word=lambda s:len(re.findall('[ء-ي]',unicodedata.normalize('NFKC',s or '')))>=3
sources=collections.defaultdict(list)
for page,info in lib['pages'].items():
 for z in info['zones']:
  sg=segments.get(z['id'])
  if not sg or z.get('visionSkip') or not word(z.get('text')):continue
  if z.get('kind') not in [None,'word']:continue
  if sg.get('status') not in ('machine-aligned-pending-listening','human-reviewed','reviewed') and not sg.get('reviewed'):continue
  src=ROOT/sg['clip'].removeprefix('./')
  if src.exists():sources[z['text']].append((z['id'],sg,src))
created=[]
for page,info in lib['pages'].items():
 for z in info['zones']:
  if z['id'] in segments or z.get('visionSkip') or not word(z.get('text')):continue
  if z.get('kind') not in [None,'word']:continue
  candidates=sources.get(z['text'],[])
  if not candidates:continue
  # Same exact Unicode word, same vocalization, unreviewed provenance disclosed.
  original_id,original,src=min(candidates,key=lambda t:(not t[1].get('reviewed',False),-(t[1].get('confidence',0)),t[0]))
  safe=re.sub('[^A-Za-z0-9_-]','',z['id'])
  dest=ROOT/'library-clips'/f'reuse-{int(page):03d}-{safe}.mp3'
  if dest.exists() and dest.stat().st_size!=src.stat().st_size:raise RuntimeError('unexpected existing output '+str(dest))
  if not dest.exists():shutil.copyfile(src,dest)
  segments[z['id']]={'page':int(page),'clip':'./'+dest.relative_to(ROOT).as_posix(),'reviewed':False,'status':'exact-text-reused-pending-listening','alignmentMethod':'exact-unicode-clip-reuse','reusedFrom':original_id,'confidence':round(min(.8,float(original.get('confidence',.8))),3)}
  created.append({'page':int(page),'zone':z['id'],'text':z['text'],'reusedFrom':original_id})
report=ROOT/'vision'/'alignment'/'reused-word-clips-audit.json';report.parent.mkdir(parents=True,exist_ok=True)
report.write_text(json.dumps(created,ensure_ascii=False,indent=1),'utf8')
p.write_text(json.dumps(lib,ensure_ascii=False,separators=(',',':'))+'\n','utf8')
print(json.dumps({'created':len(created),'remaining':sum(z['id'] not in segments for pg in lib['pages'].values() for z in pg['zones'] if not z.get('visionSkip')),'sourceWords':len(sources),'pages':len(set(x['page'] for x in created))}))
