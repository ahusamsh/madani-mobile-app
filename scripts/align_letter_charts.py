"""Split only known 7-row letter charts (28 Arabic letters) into four RTL hit areas per row.
Use confirmed ASR syllable text to obtain original-recording timestamps. Uncertain sounds rejected.
"""
from pathlib import Path
import json,unicodedata,re,collections
from align_book import ROOT,LIB,TRANS,normalize
ALPHABET='ءبتثجحخدذرزسشصضطظعغفقكلمنهوي'
PAGES={25:'fatha',28:'kasra',31:'damma',39:'tanween',41:'tanween',43:'tanween'}
# In this book each of these six charts has seven rows of four letters, read right-to-left.
def base_letters(text):
    s=''.join(c for c in unicodedata.normalize('NFKC',text) if not unicodedata.combining(c) and c!='ـ')
    return [c for c in s if c in ALPHABET+'أإ']
def grouped_boxes(page):
    zones=[z for z in LIB['pages'][str(page)]['zones'] if '-chart-' not in z['id']]
    groups=[]
    for z in zones:
        x,y,w,h=z['box']
        if y+h/2<0.195:continue
        if page in [25,28,31]:
            n=len(base_letters(z['text']))
        else:
            n=4
        if not 1<=n<=4 or w<0.024:continue
        groups.append(dict(zone=z,n=n,cy=y+h/2))
    rows=[]
    for g in sorted(groups,key=lambda g:g['cy']):
        if not rows or abs(rows[-1][0]['cy']-g['cy'])>0.065:rows.append([g])
        else:rows[-1].append(g)
    if len(rows)!=7 or sum(x['n'] for row in rows for x in row)!=28:
        print('INVALID rows',page,[(len(r),sum(g['n'] for g in r)) for r in rows])
        return []
    out=[]
    for ridx,row in enumerate(rows):
        seq=[]
        for g in sorted(row,key=lambda g:g['zone']['box'][0],reverse=True):
            x,y,w,h=g['zone']['box'];n=g['n']
            for k in range(n):
                seq.append([round(x+w*(n-k-1)/n,7),y,round(w/n,7),h])
        if len(seq)!=4:return []
        row_center=sum(g['cy'] for g in row)/len(row)
        for k,box in enumerate(seq):
            x,y,w,h=box
            # PDF-extracted row rectangles overlap vertically by ~20%; crop to a
            # small nonoverlapping target around the actual row center.
            safe_h=min(h,0.078)
            safe_box=[x,round(row_center-safe_h/2,7),w,round(safe_h,7)]
            out.append(dict(page=page,letter=ALPHABET[ridx*4+k],box=safe_box,group=ridx,index=ridx*4+k))
    return out
def phonetic(letter,mode):
    b=normalize(letter)
    if letter=='ء':
        if mode=='tanween':return {'ان'}
        return {'ا','اي','او','اء'}
    if mode=='fatha':return {b+'ا'} | ({'ا','اا'} if letter=='ء' else set())
    if mode=='kasra':return {b+'ي'}
    if mode=='damma':return {b+'و'}
    return {b+'ن'}
def align(page,zones,asr):
    mode=PAGES[page]
    result=[]
    heading={25:'الفتحة',28:'الكسرة',31:'الضمة',39:'الفتحة',41:'الكسرتان',43:'الضمتان'}[page]
    after=next((i+1 for i,w in enumerate(asr) if normalize(w['text'])==normalize(heading)), 2)
    for i,z in enumerate(zones):
        expect=phonetic(z['letter'],mode)
        choices=[]
        for j in range(after,min(len(asr),after+6)):
            if normalize(asr[j]['text']) in expect:
                choices.append((j,asr[j]['prob']))
        if choices:
            j,p=max(choices,key=lambda v:v[1]-.05*(v[0]-after))
            if p>=.6:
                result.append(dict(index=i,page=page,letter=z['letter'],word=asr[j]['text'],time=[asr[j]['start'],asr[j]['end']],prob=p,box=z['box'],asrIndex=j))
                after=j+1;continue
        # Never assign an uncertain word or a guessed timestamp.
        result.append(dict(index=i,page=page,letter=z['letter'],word=None,time=None,prob=0,box=z['box'],asrIndex=None))
    return result
if __name__=='__main__':
    total=0
    for p in PAGES:
        zones=grouped_boxes(p)
        f=TRANS/f'{p:03}.json'
        if not zones or not f.exists():print('UNAVAILABLE',p);continue
        asr=json.loads(f.read_text('utf8'))['words']
        result=align(p,zones,asr)
        good=[x for x in result if x['time']]
        print('PAGE',p,'segments',len(good),'of',len(result),'detail',[(x['letter'],x['word'],x['prob']) for x in result])
        total+=len(good)
    print('TOTAL',total)
