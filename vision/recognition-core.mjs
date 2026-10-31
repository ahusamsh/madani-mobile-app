/** Camera recognition decision gate: no OCR guesses, no static screen-coordinate matching. */
export function project(h,{x,y}) {
 if (!Array.isArray(h)||h.length!==9||!Number.isFinite(x)||!Number.isFinite(y)) return null;
 const d=h[6]*x+h[7]*y+h[8]; if(!Number.isFinite(d)||Math.abs(d)<1e-7)return null;
 const px=(h[0]*x+h[1]*y+h[2])/d,py=(h[3]*x+h[4]*y+h[5])/d;
 return Number.isFinite(px)&&Number.isFinite(py)?{x:px,y:py}:null;
}
export function invertHomography(h) {
 if(!Array.isArray(h)||h.length!==9||h.some(x=>!Number.isFinite(x)))return null;
 const [a,b,c,d,e,f,g,i,j]=h;
 const cof=[e*j-f*i,c*i-b*j,b*f-c*e,f*g-d*j,a*j-c*g,c*d-a*f,d*i-e*g,b*g-a*i,a*e-b*d];
 const det=a*cof[0]+b*cof[3]+c*cof[6];
 return Number.isFinite(det)&&Math.abs(det)>1e-9?cof.map(x=>x/det):null;
}
export function distanceToBox({x,y},b){
 if(!b||![b.x,b.y,b.width,b.height].every(Number.isFinite)||b.width<=0||b.height<=0)return Infinity;
 return Math.hypot(Math.max(b.x-x,0,x-b.x-b.width),Math.max(b.y-y,0,y-b.y-b.height));
}
const validPoint=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y);
export function chooseTarget(tip,tokens,{minTextConfidence=.63,maxMissPx=9,tieMargin=.14}={}){
 if(!validPoint(tip)||!Array.isArray(tokens))return {target:null,reason:'no-pointer'};
 const ranked=[];
 for(const item of tokens){
  const b=item?.box,text=String(item?.text??'').trim(),conf=Number(item?.confidence??0);
  if(!text||!b||!Number.isFinite(conf)||conf<minTextConfidence)continue;
  const d=distanceToBox(tip,b),margin=Math.min(maxMissPx,Math.max(2,Math.min(b.width,b.height)*.28));
  if(d>margin)continue;
  ranked.push({item,score:(d===0?1:Math.max(0,1-d/(margin+1)))*.72+conf*.28});
 }
 ranked.sort((a,b)=>b.score-a.score);
 if(!ranked.length)return {target:null,reason:'no-text-at-tip'};
 if(ranked[1]&&Math.abs(ranked[0].score-ranked[1].score)<tieMargin&&ranked[0].item.id!==ranked[1].item.id)
  return {target:null,reason:'ambiguous-neighbours'};
 return {target:ranked[0].item,confidence:Math.min(1,ranked[0].score),reason:null};
}
export function choosePage(candidates,{minInliers=9,minInlierRatio=.53,minScore=.6,tieMargin=.13}={}){
 const rows=(candidates||[]).filter(c=>Number.isInteger(c?.page)&&c.page>0&&Number.isFinite(c.inliers)&&c.inliers>=minInliers&&Number.isFinite(c.matches)&&c.matches>=c.inliers&&Number.isFinite(c.score)&&c.score>=minScore&&c.inliers/c.matches>=minInlierRatio);
 rows.sort((a,b)=>b.score-a.score);
 if(!rows.length)return {page:null,reason:'insufficient-page-evidence'};
 if(rows[1]&&rows[0].page!==rows[1].page&&rows[0].score-rows[1].score<tieMargin)return {page:null,reason:'ambiguous-page'};
 return {page:rows[0].page,confidence:rows[0].score,registration:rows[0].registration??null,reason:null};
}
export class PointingGate{
 constructor({holdMs=190,frames=3,missingResetMs=180,repeatCooldownMs=550,minPointerConfidence=.75,minPageConfidence=.65}={}){
  Object.assign(this,{holdMs,frames,missingResetMs,repeatCooldownMs,minPointerConfidence,minPageConfidence});this.reset();
 }
 reset(){this.candidate=null;this.firstAt=0;this.count=0;this.lastSeen=0;this.lastEmit=null;this.lastEmitAt=-Infinity;this.armed=true;}
 update({at,page,pointer,tokens}={}){
  if(!Number.isFinite(at))throw new TypeError('frame timestamp required');
  const reject=reason=>({accepted:false,reason,page:page?.page??null,tip:pointer?.tip??null});
  if(!pointer||!validPoint(pointer.tip)||!['finger','pen'].includes(pointer.type)||!Number.isFinite(pointer.confidence)||pointer.confidence<this.minPointerConfidence){
   if(at-this.lastSeen>=this.missingResetMs){this.candidate=null;this.count=0;this.armed=true;}
   return reject('no-reliable-pointer');
  }
  this.lastSeen=at;
  if(!page||!Number.isInteger(page.page)||!Number.isFinite(page.confidence)||page.confidence<this.minPageConfidence)return reject('no-reliable-page');
  const selected=chooseTarget(pointer.tip,tokens);
  if(!selected.target){this.candidate=null;this.count=0;return reject(selected.reason);}
  const key=`${page.page}:${selected.target.id??selected.target.text}`;
  if(this.candidate!==key){this.candidate=key;this.firstAt=at;this.count=1;return reject('stabilizing');}
  this.count++;
  if(!this.armed)return reject('already-pointing');
  if(this.count<this.frames||at-this.firstAt<this.holdMs)return reject('stabilizing');
  if(this.lastEmit===key&&at-this.lastEmitAt<this.repeatCooldownMs)return reject('cooldown');
  this.armed=false;this.lastEmit=key;this.lastEmitAt=at;
  return {accepted:true,reason:null,page:page.page,tip:pointer.tip,kind:selected.target.kind??'word',targetText:selected.target.text,targetId:selected.target.id,confidence:Math.min(page.confidence,pointer.confidence,selected.confidence),sourceEvidence:{pointerType:pointer.type,page:page.evidence??'visual-features',text:selected.target.source??'aligned-text'}};
 }
}