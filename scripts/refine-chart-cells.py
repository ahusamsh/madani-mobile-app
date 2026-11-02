"""Update six lesson chart hit boxes to avoid overlapped adjacent rows.
Does not alter audio, mapping IDs or other book pages.
"""
import json
from pathlib import Path
from align_book import ROOT,LIB
from align_letter_charts import PAGES,grouped_boxes
p=ROOT/'data/audio-library.json'
count=0
for page in PAGES:
    new=grouped_boxes(page)
    if len(new)!=28:raise RuntimeError('missing chart geometry '+str(page))
    for i,box in enumerate(new):
        zid=f'p{page}-chart-{i+1:02}'
        old=next((z for z in LIB['pages'][str(page)]['zones'] if z['id']==zid),None)
        if old is None:raise RuntimeError(zid)
        old['box']=box['box'];count+=1
    rowpairs=[]
    for j in range(6):
        a=new[4*j]['box'];b=new[4*(j+1)]['box']
        assert a[1]+a[3]<b[1],(page,j,a,b)
p.write_text(json.dumps(LIB,ensure_ascii=False,separators=(',',':'))+'\n','utf8')
print('Refined chart cells',count,'on',len(PAGES),'pages; zero vertical row overlap.')
