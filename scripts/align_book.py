"""Conservatively align printed PDF text-zone candidates with locally transcribed original recordings.
All unreviewed output remains marked machine-aligned. Ambiguities are rejected.
"""
import json,re,unicodedata,sys,collections
from pathlib import Path
from difflib import SequenceMatcher
ROOT=Path(__file__).resolve().parent.parent
LIB=json.loads((ROOT/'data'/'audio-library.json').read_text('utf8'))
TRANS=ROOT/'vision'/'alignment'/'transcripts'
OCR=ROOT/'vision'/'alignment'/'ocr'
def normalize(s):
    s=unicodedata.normalize('NFKC',s or '').replace('ٱ','ا')
    s=''.join(ch for ch in s if not unicodedata.combining(ch))
    s=re.sub('[إأآٲٳٵ]','ا',s).replace('ى','ي').replace('ؤ','و').replace('ئ','ي').replace('ة','ه')
    return re.sub('[^ءاآ-ي]','',s)
def get_candidates(zones,asr):
    zw=[normalize(z.get('text','')) for z in zones]
    aw=[normalize(w['text']) for w in asr]
    candidates=[]
    for i,z in enumerate(zones):
        word=zw[i]
        if len(word)<3 or len(word)>60:continue
        for j in range(len(aw)):
            if not aw[j] or aw[j][0]!=word[0]:continue
            if asr[j]['prob']<0.70:continue
            for k in range(j,min(len(aw),j+5)):
                chunk=''.join(aw[j:k+1])
                if len(chunk)>len(word):break
                if chunk==word:
                    probs=[w['prob'] for w in asr[j:k+1]]
                    if min(probs)>=0.70 and sum(probs)/len(probs)>=0.78 and 0.18<=asr[k]['end']-asr[j]['start']<=6:
                        candidates.append(dict(i=i,j=j,k=k,score=len(word)+1.5*sum(probs)/len(probs),kind='exact',norm=word))
                    break
    return candidates
def select(zones,asr,candidates):
    zcounter=collections.Counter(normalize(z.get('text')) for z in zones)
    acounter=collections.Counter(normalize(w['text']) for w in asr)
    by_zone=collections.defaultdict(list)
    for c in candidates:by_zone[c['i']].append(c)
    # Exact, uniquely recognisable matches: cannot confuse repeated phrases.
    strong=[]
    for c in candidates:
        if c['j']==c['k'] and zcounter[c['norm']]==1 and acounter[c['norm']]==1 and len(c['norm'])>=4:
            strong.append(c)
    strong.sort(key=lambda c:c['i'])
    # Need both reading order and audio order to avoid a mismatched layout.
    anchors=[]
    for c in strong:
        if anchors and (c['j']<=anchors[-1]['k'] or c['i']==anchors[-1]['i']):continue
        anchors.append(c)
    # include non-unique candidates only if sandwiched by distinct anchors and monotone
    selected=list(anchors)
    for c in candidates:
        if c in selected:continue
        left=[a for a in anchors if a['i']<c['i'] and a['k']<c['j']]
        right=[a for a in anchors if a['i']>c['i'] and a['j']>c['k']]
        if not left or not right:continue
        l=left[-1];r=right[0]
        if r['i']-l['i']>8 or r['j']-l['j']>16:continue
        if len(by_zone[c['i']])!=1:continue
        if any((a['i']==c['i'] or (a['j']<=c['k'] and c['j']<=a['k'])) for a in selected):continue
        if c['j']>l['k'] and c['k']<r['j']: selected.append(c)
    return sorted(selected,key=lambda c:c['i'])
def run():
    total=collections.Counter()
    for f in sorted(TRANS.glob('*.json')):
        p=int(f.stem);z=LIB['pages'][str(p)]['zones'];a=json.loads(f.read_text('utf8'))['words']
        candidates=get_candidates(z,a);sel=select(z,a,candidates)
        total['pages']+=1;total['candidates']+=len(candidates);total['linked']+=len(sel)
        print('PAGE',p,'zones',len(z),'asr',len(a),'candidates',len(candidates),'select',len(sel),'sample',[(z[c['i']]['text'],a[c['j']]['text']) for c in sel[:8]])
    print('TOTAL',dict(total))
if __name__=='__main__':run()

def select_extended(zones,asr,candidates):
    """Conservative exact text match within a two-anchor bounded reading interval."""
    anchors=select(zones,asr,candidates)
    chosen=list(anchors)
    used_audio=set()
    for c in chosen:
        used_audio.update(range(c['j'],c['k']+1))
    for left,right in zip(anchors,anchors[1:]):
        if right['i']-left['i']>13 or right['j']-left['k']>36:
            continue
        # All text/audio between the anchors is a self-contained ordered interval.
        interior=[c for c in candidates if left['i']<c['i']<right['i']
            and left['k']<c['j'] and c['k']<right['j']
            and len(c['norm'])>=3 and all(j not in used_audio for j in range(c['j'],c['k']+1))]
        by_zone=collections.defaultdict(list)
        for c in interior:by_zone[c['i']].append(c)
        unique=[c[0] for c in by_zone.values() if len(c)==1]
        unique.sort(key=lambda c:(c['i'],c['j']))
        # Do not force matches where the local word order is contradictory.
        last_audio=left['k']
        for c in unique:
            if c['j']<=last_audio or c['k']>=right['j']:continue
            if any(k in used_audio for k in range(c['j'],c['k']+1)):continue
            chosen.append(c)
            used_audio.update(range(c['j'],c['k']+1))
            last_audio=c['k']
    return sorted(chosen,key=lambda c:c['i'])

def select_blocks(zones,asr,candidates):
    """Require contiguous correct words as independent evidence, not isolated guesses."""
    strong=select_extended(zones,asr,candidates)
    chosen=list(strong)
    if len(strong)<4 or len(zones)<12:
        return chosen
    from difflib import SequenceMatcher
    A=[normalize(z['text']) for z in zones]
    B=[normalize(w['text']) for w in asr]
    sm=SequenceMatcher(None,A,B,autojunk=False)
    used_z={c['i'] for c in chosen}
    used_a=set(j for c in chosen for j in range(c['j'],c['k']+1))
    for i,j,n in sm.get_matching_blocks():
        if n<3:continue
        for offset in range(n):
            zi=i+offset;aj=j+offset
            if zi in used_z or aj in used_a:continue
            if len(A[zi])<3 or asr[aj]['prob']<.78:continue
            if A[zi]!=B[aj] or not (.19<=asr[aj]['end']-asr[aj]['start']<=4.0):continue
            # When a page contains many repeated words, a 3-word ordered
            # block is needed to disambiguate the individual repetition.
            c=dict(i=zi,j=aj,k=aj,norm=A[zi],kind='sequence-exact',score=len(A[zi]))
            chosen.append(c);used_z.add(zi);used_a.add(aj)
    return sorted(chosen,key=lambda c:c['i'])

def select_repeated_exact_lexemes(zones,asr,candidates):
    """One printed lexical word can be recited multiple times: use a HIGH-CONFIDENCE
    occurrence of precisely that same word, without pretending to know which repetition.
    Short diacritic-sensitive particles are excluded."""
    chosen=select_blocks(zones,asr,candidates)
    used_z={c['i'] for c in chosen}
    used_a=set(j for c in chosen for j in range(c['j'],c['k']+1))
    zcounter=collections.Counter(normalize(z.get('text')) for z in zones)
    by_z=collections.defaultdict(list)
    for c in candidates:
        if c['j']==c['k'] and len(c['norm'])>=5:
            by_z[c['i']].append(c)
    for i,items in by_z.items():
        if i in used_z:continue
        label=normalize(zones[i]['text'])
        if zcounter[label]!=1:continue
        picks=[c for c in items if c['j'] not in used_a and asr[c['j']]['prob']>=.88
            and .22<=asr[c['j']]['end']-asr[c['j']]['start']<=4]
        if not picks:continue
        # The actual sound is a repeated exact lexical item on the SAME page.
        best=max(picks,key=lambda c:asr[c['j']]['prob'])
        best={**best,'kind':'exact-lexeme-repetition'}
        chosen.append(best)
        used_z.add(i);used_a.add(best['j'])
    return sorted(chosen,key=lambda c:c['i'])
