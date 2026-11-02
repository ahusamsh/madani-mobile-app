"""Reusable educational Arabic single-letter audio using diacritic-exact glyph equivalence.
Takes only already mapped *isolated letter* recordings, preserving exact hamza and vowel.
No audio synthesis, training-device access, audio guessing, or cross-word substring shortcuts.
All new entries are explicitly UNREVIEWED and include their source zone.
"""
from pathlib import Path
import json,unicodedata,collections,sys
ROOT=Path(__file__).resolve().parent.parent
FILE=ROOT/'data/audio-library.json'
LIB=json.loads(FILE.read_text(encoding='utf8'))
S=LIB['segments']

def signature(value):
    raw=unicodedata.normalize('NFC',value or '')
    raw=raw.replace(chr(0x640),'')
    base=[]; marks=[]
    for c in raw:
        cp=ord(c)
        if 0x621<=cp<=0x64a:
            base.append(c)
        elif 0x64b<=cp<=0x652:
            marks.append(c)
        elif c.isspace():
            continue
        else:
            return None
    # Precisely one printed letter; retain literal hamza, tanween, shadda,
    # fatha, damma, kasra and sukun. Haraka order is not meaningful.
    if len(base)!=1 or len(marks)>2 or len(marks)!=len(set(marks)):
        return None
    return (base[0],tuple(sorted(marks)))

sources=collections.defaultdict(list)
for page,rec in LIB['pages'].items():
    for zone in rec['zones']:
        sid=zone['id']
        if sid not in S or zone.get('kind')!='letter' or zone.get('visionSkip'):
            continue
        key=signature(zone.get('text',''))
        if not key:continue
        segment=S[sid]
        source=(ROOT/segment['clip'].removeprefix('./'))
        if not source.is_file():continue
        # Bare alphabet names come from manually prepared lesson audio, not
        # ordinary running text. Vowelled syllables come from ordered charts.
        method=segment.get('alignmentMethod')
        if not key[1] and int(page) not in (17,18,19,20,21):
            continue
        if key[1] and method not in ('ordered-chart-28-letters','exact-syllable-same-page'):
            continue
        sources[key].append((int(page),zone,segment))

audit=[]
for page,rec in LIB['pages'].items():
    pid=int(page)
    if pid<13:continue # introductory OCR frequently fragments running text
    for zone in rec['zones']:
        zid=zone['id']
        if zid in S or zone.get('kind')!='letter' or zone.get('visionSkip'):
            continue
        box=zone.get('box')
        if not isinstance(box,list) or len(box)!=4 or not all(isinstance(v,(float,int)) for v in box):
            continue
        # Skip headings and highly suspicious OCR/footnote fragments.
        if not (.18<=box[1]<=.92 and .01<=box[2]<=.17 and .018<=box[3]<=.15):
            continue
        key=signature(zone.get('text',''))
        if key not in sources:continue
        # Prefer a four-letter-form lesson clip (bare) or an ordered chart (vowelled).
        matches=sorted(sources[key],key=lambda src: (
            src[2].get('alignmentMethod')!='ordered-chart-28-letters',
            src[2].get('alignmentMethod') is not None,
            src[0],src[1]['id']))
        origin_page,origin_zone,origin_seg=matches[0]
        sclip=origin_seg['clip']
        if not (ROOT/sclip.removeprefix('./')).is_file():continue
        S[zid]=dict(page=pid,clip=sclip,reviewed=False,
            status='same-letter-same-harakat-reused-pending-listening',
            alignmentMethod='same-printed-letter-and-harakat',
            sourcePage=origin_page,reusedFrom=origin_zone['id'],
            sourceClipStatus=origin_seg.get('status','existing-unreviewed'),
            confidence=min(.82,float(origin_seg.get('confidence',.82))))
        audit.append(dict(page=pid,id=zid,printed=zone['text'],base=key[0],
            harakat=list(key[1]),sourcePage=origin_page,sourceZone=origin_zone['id'],
            sourcePrinted=origin_zone['text'],clip=sclip))
print('MATCHED:',len(audit),'PAGES:',len(set(x['page'] for x in audit)),
      'NEW_TOTAL:',len(S),'VOWELLED:',sum(bool(x['harakat']) for x in audit),flush=True)
if '--dry-run' in sys.argv:
    print('SAMPLES:',json.dumps(audit[:35],ensure_ascii=False))
    sys.exit(0)
if not audit:
    print('No additional matches; previous audit preserved.')
    sys.exit(0)
audit_path=ROOT/'vision/alignment/reused-letter-clips-audit.json'
audit_path.write_text(json.dumps(audit,ensure_ascii=False,indent=1),encoding='utf8')
FILE.write_text(json.dumps(LIB,ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf8')
