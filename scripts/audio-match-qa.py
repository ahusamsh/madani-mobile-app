"""Verify new original-audio lexical rescue links, page provenance and exact Arabic labels."""
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
from align_book import ROOT,normalize
L=json.loads((ROOT/'data/audio-library.json').read_text('utf8'))
audit=json.loads((ROOT/'vision/alignment/lexical-rescue-audit.json').read_text('utf8'))
seen=set()
for item in audit:
 page=item['page']; zid=item['zone']
 assert zid not in seen,('duplicate zone',zid)
 seen.add(zid)
 zone=next(z for z in L['pages'][str(page)]['zones'] if z['id']==zid)
 seg=L['segments'][zid]
 assert seg['page']==page
 assert seg['status']=='machine-aligned-pending-listening'
 assert not seg['reviewed']
 assert normalize(item['printed'])==normalize(item['spoken'])==normalize(zone['text'])
 assert seg['start']>=0 and seg['end']>seg['start']
 assert (ROOT/seg['clip'].removeprefix('./')).stat().st_size>700
 assert seg['alignmentMethod']==item['method']
# Check all existing original links, including 143 older ones, remain intact.
assert len(L['segments'])>=840
assert all((ROOT/x['clip'].removeprefix('./')).is_file() for x in L['segments'].values())
print(json.dumps({'passed':True,'newVerifiedByTextAndFile':len(audit),'totalLinked':len(L['segments']),
 'pagesWithNewLinks':len(set(x['page'] for x in audit)),'humanReviewed':0}))
