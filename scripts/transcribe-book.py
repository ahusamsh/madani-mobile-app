"""Locally transcribe source page recordings with word timestamps.
No cloud API and no training machine. Store results by page and resume safely.
Whisper transcript is NOT proof of a correct word-to-printed-zone association.
"""
from pathlib import Path
import json,time,sys
import av
_native_open=av.open
def _compatible_open(*a,**kw):
    kw.pop('metadata_errors',None)
    return _native_open(*a,**kw)
av.open=_compatible_open
from faster_whisper import WhisperModel
ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'vision'/'alignment'/'transcripts'
OUT.mkdir(parents=True,exist_ok=True)
library=json.loads((ROOT/'data'/'audio-library.json').read_text('utf8'))
pages=[p for p in sorted(map(int,library['pages'])) if library['pages'][str(p)].get('audioSourceCached') and p not in (17,18,19,20,21) and (ROOT/'library-audio'/f'page-{p-2:03}.mp3').is_file()]
if len(sys.argv)>1:
    pages=[int(v) for v in sys.argv[1].split(',') if int(v) in pages]
print(f'TRANSCRIBE pages={len(pages)} using local Whisper small CPU',flush=True)
model=WhisperModel('small',device='cpu',compute_type='int8',cpu_threads=6,num_workers=1,local_files_only=True)
start=time.perf_counter()
for index,page in enumerate(pages,1):
    dst=OUT/f'{page:03}.json'
    if dst.exists():
        print(f'SKIP page {page} exists ({index}/{len(pages)})',flush=True)
        continue
    mp3=ROOT/'library-audio'/f'page-{page-2:03}.mp3'
    t=time.perf_counter()
    try:
        segments,info=model.transcribe(str(mp3),language='ar',word_timestamps=True,beam_size=2,
            condition_on_previous_text=False,vad_filter=False,
            initial_prompt='القاعدة المدنية، الحروف الهجائية، الحركات، السكون، التنوين، الشدة')
        words=[]
        for s in segments:
            for w in s.words or []:
                if w.start is not None and w.end is not None:
                    words.append(dict(text=w.word.strip(),start=round(float(w.start),3),end=round(float(w.end),3),prob=round(float(w.probability),3)))
        result=dict(page=page,model='local-faster-whisper-small',duration=round(info.duration,2),words=words,
                    source='./library-audio/page-%03d.mp3'%(page-2),reviewed=False)
        dst.write_text(json.dumps(result,ensure_ascii=False,separators=(',',':')),'utf8')
        print(f'OK page={page} words={len(words)} duration={info.duration:.0f}s elapsed={time.perf_counter()-t:.1f}s [{index}/{len(pages)}]',flush=True)
    except Exception as e:
        print(f'ERROR page={page} {e}',flush=True)
print(f'DONE in {time.perf_counter()-start:.1f} sec',flush=True)
