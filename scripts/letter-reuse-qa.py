"""Audit exact Arabic letter-vowel equivalence for original recording reuse."""
from pathlib import Path
import json
import unicodedata

def signature(value):
    raw=unicodedata.normalize('NFC',value or '').replace(chr(0x640),'')
    base=[];marks=[]
    for c in raw:
        cp=ord(c)
        if 0x621<=cp<=0x64a:base.append(c)
        elif 0x64b<=cp<=0x652:marks.append(c)
        elif c.isspace():continue
        else:return None
    return (base[0],tuple(sorted(marks))) if len(base)==1 and len(marks)<=2 and len(marks)==len(set(marks)) else None
root=Path(__file__).resolve().parent.parent
lib=json.loads((root/'data/audio-library.json').read_text(encoding='utf8'))
audit=json.loads((root/'vision/alignment/reused-letter-clips-audit.json').read_text(encoding='utf8'))
assert len(audit)>=60,len(audit)
assert signature(chr(0x628)+chr(0x64e))!=signature(chr(0x628)+chr(0x650))
assert signature(chr(0x628)+chr(0x64e))!=signature(chr(0x628)+chr(0x64f))
assert signature(chr(0x623))!=signature(chr(0x627))
assert signature(chr(0x626))!=signature(chr(0x64a))
assert signature(chr(0x628)+chr(0x640)+chr(0x64e))==signature(chr(0x64e)+chr(0x628))
for rec in audit:
 zid=rec['id']
 seg=lib['segments'][zid]
 target=next(z for z in lib['pages'][str(rec['page'])]['zones'] if z['id']==zid)
 source=next(z for z in lib['pages'][str(rec['sourcePage'])]['zones'] if z['id']==rec['sourceZone'])
 source_seg=lib['segments'][rec['sourceZone']]
 assert signature(target['text'])==signature(source['text'])
 assert seg['page']==rec['page']
 assert seg['reusedFrom']==rec['sourceZone']
 assert seg['clip']==source_seg['clip']
 assert not seg['reviewed']
 assert (root/seg['clip'].removeprefix('./')).stat().st_size>700
assert len(lib['segments'])>=906
print(json.dumps({'passed':True,'verifiedLetterLinks':len(audit),'linkedBookZones':len(lib['segments']),
                  'newVowelled':sum(bool(x['harakat']) for x in audit)}))
