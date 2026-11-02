"""Generate conservative, auditable, offline-safe WORD clips from ORIGINAL page recordings.
Combines unique exact text-ASR matches, high-confidence OCR evidence, and six deterministic
28-letter recitation charts. Fails closed; does not invent sound for unmatched words.
"""
import sys,json,re,subprocess,hashlib,collections,time
from pathlib import Path
import imageio_ffmpeg
from align_book import ROOT,LIB,TRANS,OCR,normalize,get_candidates,select_repeated_exact_lexemes as select
from align_letter_charts import PAGES,ALPHABET,grouped_boxes,phonetic
FFMPEG=imageio_ffmpeg.get_ffmpeg_exe()
OUT=ROOT/'library-clips'
OUT.mkdir(exist_ok=True)
stats=collections.Counter()
clips=[]
audit=[]
def overlap_share(box_a,box_b):
    x,y,w,h=box_a;X,Y,W,H=box_b
    inter=max(0,min(x+w,X+W)-max(x,X))*max(0,min(y+h,Y+H)-max(y,Y))
    return inter/max(1e-10,w*h)
def append_segment(page,zone_id,word,start,end,source,confidence,asr):
    if zone_id in LIB['segments']:return False
    if start is None or end is None:return False
    start=max(0.0,float(start));end=float(end)
    if end-start<0.19 or end-start>6.0 or not (end>start):return False
    sound=ROOT/'library-audio'/f'page-{page-2:03d}.mp3'
    if not sound.exists():return False
    rel=f'./library-clips/auto-{page:03d}-{re.sub("[^a-zA-Z0-9_-]","",zone_id)}.mp3'
    source_path=ROOT/rel[2:]
    # Defer extraction until source mapping has passed all consistency rules.
    LIB['segments'][zone_id]=dict(page=page,start=round(start,3),end=round(end,3),clip=rel,
       reviewed=False, status='machine-aligned-pending-listening',confidence=round(float(confidence),3),
       alignmentMethod=source, transcript=asr)
    clips.append((sound,source_path,start,end))
    stats[source]+=1
    audit.append(dict(page=page,id=zone_id,text=word,start=round(start,3),end=round(end,3),
                      transcript=asr,method=source,confidence=round(float(confidence),3)))
    return True
def chart_pairs(page,asr):
    letter_boxes=grouped_boxes(page)
    if len(letter_boxes)!=28:return ([],[])
    mode=PAGES[page]
    headings={25:'الفتحة',28:'الكسرة',31:'الضمة',39:'الفتحة',41:'الكسرتان',43:'الضمتان'}
    i0=next((i+1 for i,w in enumerate(asr) if normalize(w['text'])==normalize(headings[page])),None)
    if i0 is None:return ([],[])
    tail=asr[i0:]; n=28; m=len(tail)
    expected=[phonetic(c,mode) for c in ALPHABET]
    direct=sum(normalize(tail[i]['text']) in expected[i] for i in range(min(n,m)))
    if 28<=m<=30 and direct>=20:
        pairs={i:i for i in range(n)}
    elif m==27:
        # Ordered edit alignment: one omitted ASR token cannot shift every following letter.
        dp=[[(float('-inf'),None) for _ in range(m+1)] for __ in range(n+1)]
        dp[0][0]=(0,None)
        for i in range(n+1):
            for j in range(m+1):
                score=dp[i][j][0]
                if score==float('-inf'):continue
                if i<n and j<m:
                    good=normalize(tail[j]['text']) in expected[i]
                    sc=score+(5 if good else -3)
                    if sc>dp[i+1][j+1][0]:dp[i+1][j+1]=(sc,('pair',i,j))
                if i<n and score-2>dp[i+1][j][0]:dp[i+1][j]=(score-2,('skip-letter',i,j))
                if j<m and score-2>dp[i][j+1][0]:dp[i][j+1]=(score-2,('skip-audio',i,j))
        pairs={};i=n;j=m
        while i or j:
            item=dp[i][j][1]
            if item is None:break
            action,a,b=item
            if action=='pair':pairs[a]=b;i-=1;j-=1
            elif action=='skip-letter':i-=1
            else:j-=1
        good=sum(normalize(tail[j]['text']) in expected[i] for i,j in pairs.items())
        if good<18:return ([],[])
    else:return ([],[])
    # High aggregate evidence across the ordered lesson matters more than an isolated
    # poor ASR probability for a very short syllable.
    matches=[]
    for i,z in enumerate(letter_boxes):
        j=pairs.get(i)
        if j is None:continue
        w=tail[j]
        if w['end']<=w['start'] or w['end']-w['start']>4.5:continue
        matches.append((i,z,w,normalize(w['text']) in expected[i]))
    return (letter_boxes,matches)
def link_text_pages():
    for path in sorted(TRANS.glob('*.json')):
        page=int(path.stem)
        if page in [17,18,19,20,21] or page in PAGES:continue
        asr=json.loads(path.read_text('utf8'))['words']
        original=[z for z in LIB['pages'][str(page)]['zones'] if not z.get('visionSkip')]
        chosen=select(original,asr,get_candidates(original,asr))
        used=set()
        for c in chosen:
            w=asr[c['j']];tail=asr[c['k']]
            z=original[c['i']]
            if z['id'] in LIB['segments']:continue
            if any(j in used for j in range(c['j'],c['k']+1)):continue
            if append_segment(page,z['id'],z['text'],w['start'],tail['end'],'pdf-text-exact-asr',
                    min(asr[j]['prob'] for j in range(c['j'],c['k']+1)), ' '.join(asr[j]['text'] for j in range(c['j'],c['k']+1))):
                used.update(range(c['j'],c['k']+1))
        op=OCR/f'{page:03}.json'
        if not op.exists():continue
        words=json.loads(op.read_text('utf8'))['words']
        ocr=[dict(x) for x in words if x['conf']>=65 and len(normalize(x['text']))>=3 and len(normalize(x['text']))<=25]
        # Reading order: row approximately every 1.5% of page height; inside row, RTL.
        ocr.sort(key=lambda v:(round(v['box'][1]/.018),-v['box'][0]))
        cands=select(ocr,asr,get_candidates(ocr,asr))
        for c in cands:
            j,k=c['j'],c['k']
            if any(q in used for q in range(j,k+1)):continue
            rec=ocr[c['i']];box=rec['box']
            if not 0<=box[0]<=1 or not 0<=box[1]<=1 or box[2]<.009 or box[3]<.009 or box[2]>.35:continue
            old=LIB['pages'][str(page)]['zones']
            if any(z['id'] in LIB['segments'] and overlap_share(box,z['box'])>=.2 for z in old):continue
            zone_id=f'p{page}-ocr-{c["i"]+1:03d}'
            z=dict(id=zone_id,text=rec['text'],spokenText=rec['text'],kind='word',box=box,
              reviewed=False,geometryReviewed=False,extractionStatus='ocr-exact-asr-pending-review',
              ocrConfidence=rec['conf'])
            if append_segment(page,zone_id,z['text'],asr[j]['start'],asr[k]['end'],
                'ocr-word-exact-asr',min(asr[q]['prob'] for q in range(j,k+1)),
                ' '.join(asr[q]['text'] for q in range(j,k+1))):
                # These existing unlinked overlapping PDF zones must not override the more precise OCR word.
                for prev in old:
                    if prev['id'] not in LIB['segments'] and overlap_share(box,prev['box'])>=.35:
                        prev['visionSkip']=True
                old.append(z)
                used.update(range(j,k+1))
def link_example_syllables():
    # Only the early syllabic drill pages: in running prose 'في' could be a real
    # preposition instead of the pronunciation of the isolated letter فِ.
    marks={'َ':'ا','ِ':'ي','ُ':'و'}
    alphabet='ءابتثجحخدذرزسشصضطظعغفقكلمنهويأإآ'
    for page in range(26,37):
        if page in PAGES:continue # charts have dedicated ordered syllable links
        f=TRANS/f'{page:03}.json'
        if not f.exists():continue
        asr=json.loads(f.read_text('utf8'))['words']
        for z in LIB['pages'][str(page)]['zones']:
            if z['id'] in LIB['segments']:continue
            text=z['text']
            bases=[c for c in text if c in alphabet]
            vowel=[c for c in text if c in marks]
            if len(bases)!=1 or len(set(vowel))!=1 or len(vowel)>2 or any(c in text for c in 'ًٌٍّْ'):continue
            predicted=normalize(bases[0]+marks[vowel[0]])
            matches=[w for w in asr if normalize(w['text'])==predicted
                and w['prob']>=.75 and .19<=w['end']-w['start']<=2.5]
            if not matches:continue
            w=max(matches,key=lambda w:w['prob'])
            append_segment(page,z['id'],text,w['start'],w['end'],
                'exact-syllable-same-page',w['prob'],w['text'])
def link_letter_charts():
    vowel={25:'َ',28:'ِ',31:'ُ',39:'ً',41:'ٍ',43:'ٌ'}
    for page in PAGES:
        path=TRANS/f'{page:03}.json'
        if not path.exists():continue
        asr=json.loads(path.read_text('utf8'))['words']
        boxes,pairs=chart_pairs(page,asr)
        if not boxes:
            print('NO CHART',page,flush=True);continue
        print('CHART',page,'aligned',len(pairs),'of 28',flush=True)
        original=LIB['pages'][str(page)]['zones']
        for z in original:
            if '-chart-' not in z['id'] and z['box'][1]+z['box'][3]/2>=.195:
                z['visionSkip']=True
        for i,item in enumerate(boxes):
            zid=f'p{page}-chart-{i+1:02}'
            if any(z['id']==zid for z in original):continue
            base=item['letter']
            char=('أ' if page in [25,31] else 'إ') if base=='ء' and page in [25,28,31] else base
            label=char+vowel[page]
            zone=dict(id=zid,text=label,spokenText=label,kind='letter',
              row=item['group']+1,columnRtl=i%4+1,box=item['box'],reviewed=False,
              geometryReviewed=False,extractionStatus='rtl-chart-cell-unreviewed')
            original.append(zone)
        for i,item,w,spelled in pairs:
            z=next(z for z in original if z['id']==f'p{page}-chart-{i+1:02}')
            # Alignment accepted only with high sequence consistency; each result remains unreviewed.
            append_segment(page,z['id'],z['text'],w['start'],w['end'],
                'ordered-chart-28-letters',max(.55,w['prob']),w['text'])
def extract():
    failed=0
    for i,(src,dst,start,end) in enumerate(clips,1):
        if dst.exists() and dst.stat().st_size>700:continue
        st=max(0,start-0.025);dur=end-start+0.045
        cmd=[FFMPEG,'-nostdin','-v','error','-y','-ss',f'{st:.3f}','-i',str(src),'-t',f'{dur:.3f}',
          '-vn','-ac','1','-ar','44100','-b:a','96k',str(dst)]
        p=subprocess.run(cmd,capture_output=True,timeout=40)
        if p.returncode or not dst.exists() or dst.stat().st_size<700:
            print('CROP FAILED',dst.name,p.stderr[:200],flush=True);failed+=1
            seg_id=dst.stem.split('auto-')[-1]
        if i%50==0:print('CROPS',i,'/',len(clips),flush=True)
    return failed
def main():
    link_text_pages()
    link_example_syllables()
    link_letter_charts()
    print('MATCH COUNTS',dict(stats),'new clips',len(clips),'all segments',len(LIB['segments']),flush=True)
    audit_dir=ROOT/'vision'/'alignment'
    audit_dir.mkdir(exist_ok=True)
    audit_file=audit_dir/'new-links-review.json'
    previous=json.loads(audit_file.read_text('utf8')) if audit_file.exists() else []
    combined={x['id']:x for x in previous}
    combined.update({x['id']:x for x in audit})
    audit_file.write_text(json.dumps(list(combined.values()),ensure_ascii=False,indent=1),'utf8')
    if '--dry-run' in sys.argv:return
    err=extract()
    if err:raise RuntimeError(f'{err} audio clips failed extraction. No library changes saved.')
    (ROOT/'data'/'audio-library.json').write_text(json.dumps(LIB,ensure_ascii=False,separators=(',',':'))+'\n','utf8')
    print('SAVED segments',len(LIB['segments']),flush=True)
if __name__=='__main__':main()
