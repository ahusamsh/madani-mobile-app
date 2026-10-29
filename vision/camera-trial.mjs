import * as pdfjs from '../vendor/pdf.mjs';
import {project,invertHomography,choosePage,PointingGate} from './recognition-core.mjs';
pdfjs.GlobalWorkerOptions.workerSrc='../vendor/pdf.worker.mjs';
const $=id=>document.getElementById(id);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let cv,handLandmarker,stream,doc,active=false,refPages=[],frames=0,latestMatch=null,lastPageAt=0,gate=new PointingGate();
let orb,matcher;const videoCanvas=document.createElement('canvas');
const log=s=>{$('debug').textContent=String(s)};
const status=s=>{$('progress').textContent=s};
function jsScript(src){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=()=>reject(Error('Cannot load '+src));document.head.append(s)})}
async function loadOpenCV(){
 if(!window.cv)await jsScript('https://docs.opencv.org/4.x/opencv.js');
 const end=performance.now()+15000;
 while(performance.now()<end){if(window.cv?.Mat){cv=window.cv;return}await wait(100)}
 throw Error('OpenCV did not initialize');
}
async function loadHandTracking(){
 const {FilesetResolver,HandLandmarker}=await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/+esm');
 const vision=await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm');
 handLandmarker=await HandLandmarker.createFromOptions(vision,{baseOptions:{modelAssetPath:'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',delegate:'CPU'},runningMode:'VIDEO',numHands:1,minHandDetectionConfidence:.72,minTrackingConfidence:.65});
}
function frameGray(){
 const v=$('video');videoCanvas.width=640;videoCanvas.height=Math.round(v.videoHeight*640/v.videoWidth);
 videoCanvas.getContext('2d',{willReadFrequently:true}).drawImage(v,0,0,videoCanvas.width,videoCanvas.height);
 const rgba=cv.imread(videoCanvas),gray=new cv.Mat();
 cv.cvtColor(rgba,gray,cv.COLOR_RGBA2GRAY);rgba.delete();return gray;
}
function features(gray){
 const points=new cv.KeyPointVector(),descriptors=new cv.Mat(),mask=new cv.Mat();
 orb.detectAndCompute(gray,mask,points,descriptors);mask.delete();return {points,descriptors};
}
function deleteFeatures(f){f?.points?.delete();f?.descriptors?.delete()}
function imageTextSegments(textContent,vp){
 const out=[];
 for(const t of textContent.items||[]){
  const str=(t.str||'').trim();if(!str||!t.width)continue;
  const m=pdfjs.Util.transform(vp.transform,t.transform),height=Math.max(7,Math.hypot(m[2],m[3])),width=Math.max(1,t.width*vp.scale),baseX=m[4],baseY=m[5]-height;
  const pieces=[...str.matchAll(/\S+/gu)];
  for(const piece of pieces){
   const start=piece.index/str.length,ratio=piece[0].length/str.length;
   const x=t.dir==='rtl'?baseX+width*(1-start-ratio):baseX+width*start;
   out.push({id:out.length+1,text:piece[0],confidence:.95,source:'registered-pdf-text',kind:piece[0].length===1?'letter':'word',box:{x,y:baseY,width:width*ratio,height}});
  }
 }
 return out;
}
async function indexReference(pageNo){
 if(!doc||pageNo>doc.numPages)return;
 const page=await doc.getPage(pageNo),base=page.getViewport({scale:1}),vp=page.getViewport({scale:640/base.width});
 const canvas=document.createElement('canvas');canvas.width=Math.ceil(vp.width);canvas.height=Math.ceil(vp.height);
 await page.render({canvasContext:canvas.getContext('2d',{alpha:false}),viewport:vp}).promise;
 const img=cv.imread(canvas),gray=new cv.Mat();cv.cvtColor(img,gray,cv.COLOR_RGBA2GRAY);img.delete();
 const feature=features(gray),text=await page.getTextContent();gray.delete();
 refPages.push({page:pageNo,features:feature,tokens:imageTextSegments(text,vp)});page.cleanup();
 status('الفهرسة البصرية: '+refPages.length+' / '+doc.numPages+' صفحة • تعمل الكاميرا بالتوازي');
}
function matchOne(live,ref){
 if(live.descriptors.empty()||ref.features.descriptors.empty())return null;
 const matches=new cv.DMatchVectorVector();let mask=null,H=null,from=null,to=null;
 try{
  matcher.knnMatch(ref.features.descriptors,live.descriptors,matches,2);
  const pairs=[];
  for(let i=0;i<matches.size();i++){
   const row=matches.get(i);if(row.size()>=2){const a=row.get(0),b=row.get(1);if(a.distance<.72*b.distance)pairs.push([a.queryIdx,a.trainIdx])}row.delete();
  }
  if(pairs.length<10)return null;
  const src=[],dst=[];
  for(const [i,j] of pairs){const a=ref.features.points.get(i).pt,b=live.points.get(j).pt;src.push(a.x,a.y);dst.push(b.x,b.y)}
  from=cv.matFromArray(pairs.length,1,cv.CV_32FC2,src);to=cv.matFromArray(pairs.length,1,cv.CV_32FC2,dst);
  mask=new cv.Mat();H=cv.findHomography(from,to,cv.RANSAC,4,mask);
  if(H.empty())return null;
  const inliers=Array.from(mask.data).filter(v=>v!==0).length;
  const score=Math.min(.99,(inliers/pairs.length)*(.68+.32*Math.min(inliers,32)/32));
  if(inliers<9)return null;
  return {page:ref.page,inliers,matches:pairs.length,score,registration:Array.from(H.data64F.length?H.data64F:H.data32F)};
 }finally{matches.delete();from?.delete();to?.delete();mask?.delete();H?.delete()}
}
function getPointer(frameWidth,frameHeight){
 const result=handLandmarker.detectForVideo($('video'),performance.now()),lm=result.landmarks?.[0];if(!lm)return null;
 const d=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
 // Finger extension evidence; missing or curled hand does not count.
 if(!(d(lm[8],lm[5])>1.18*d(lm[6],lm[5])&&d(lm[8],lm[0])>1.12*d(lm[6],lm[0])))return null;
 const conf=result.handednesses?.[0]?.[0]?.score??0;
 return conf>=.75?{type:'finger',confidence:Math.min(conf,.97),tip:{x:lm[8].x*frameWidth,y:lm[8].y*frameHeight}}:null;
}
function drawOverlay(pointer,page,box){
 const can=$('overlay');can.width=videoCanvas.width;can.height=videoCanvas.height;const ctx=can.getContext('2d');ctx.lineWidth=3;
 if(pointer){ctx.strokeStyle='#ffd038';ctx.beginPath();ctx.arc(pointer.tip.x,pointer.tip.y,9,0,2*Math.PI);ctx.stroke()}
 if(page?.registration&&box){
  const {x,y,width,height}=box,pts=[{x,y},{x:x+width,y},{x:x+width,y:y+height},{x,y:y+height}].map(p=>project(page.registration,p));
  if(pts.every(Boolean)){ctx.strokeStyle='#38e5a5';ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);for(let i=1;i<4;i++)ctx.lineTo(pts[i].x,pts[i].y);ctx.closePath();ctx.stroke()}
 }
}
async function step(){
 if(!active)return;
 let gray=null;
 try{
  if($('video').readyState<2){requestAnimationFrame(step);return}
  frames++;gray=frameGray();const w=gray.cols,h=gray.rows;
  let pointer=null;try{pointer=getPointer(w,h)}catch(e){console.warn('hand detector',e)}
  if(frames%10===1&&refPages.length){
   const lf=features(gray),batch=refPages.filter(x=>x.page===latestMatch?.page),start=Math.floor(frames/10)%Math.max(1,Math.ceil(refPages.length/14))*14;
   const refs=[...batch,...refPages.slice(start,start+14)].filter((x,i,a)=>a.findIndex(z=>z.page===x.page)===i),options=[];
   for(const ref of refs){const item=matchOne(lf,ref);if(item)options.push(item)}
   deleteFeatures(lf);
   const chosen=choosePage(options);
   if(chosen.page){latestMatch={...chosen,registration:options.find(x=>x.page===chosen.page)?.registration};lastPageAt=performance.now()}
   else if(performance.now()-lastPageAt>1300)latestMatch=null;
  }
  if(!latestMatch||performance.now()-lastPageAt>1300)latestMatch=null;
  const pageRef=refPages.find(x=>x.page===latestMatch?.page),inv=latestMatch?.registration?invertHomography(latestMatch.registration):null;
  const point=inv&&pointer?project(inv,pointer.tip):null,pointerPage=pointer&&point?{...pointer,tip:point}:null;
  const decision=gate.update({at:performance.now(),page:latestMatch,pointer:pointerPage,tokens:pageRef?.tokens??[]});
  if(decision.accepted){$('result').textContent='الصفحة '+decision.page+' • '+decision.targetText;log(JSON.stringify(decision,null,2))}
  else if(!pointer)$('result').textContent='لا توجد إشارة إصبع موثوقة';
  else if(!latestMatch)$('result').textContent='جاري التحقق من الصفحة...';
  drawOverlay(pointer,latestMatch,decision.accepted?pageRef?.tokens.find(x=>x.id===decision.targetId)?.box:null);
 }catch(e){console.error(e);log('فشل بصري؛ لا يتم تخمين نتيجة: '+e.message)}
 finally{gray?.delete();if(active)setTimeout(()=>requestAnimationFrame(step),45)}
}
async function start(){
 $('start').disabled=true;status('تحميل النماذج...');
 try{
  await Promise.all([loadOpenCV(),loadHandTracking()]);
  orb=new cv.ORB(500);matcher=new cv.BFMatcher(cv.NORM_HAMMING,false);
  doc=await pdfjs.getDocument({url:'../books/ar.pdf',cMapUrl:'../vendor/cmaps/',cMapPacked:true}).promise;
  stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:640},height:{ideal:480}},audio:false});
  $('video').srcObject=stream;await $('video').play();active=true;$('stop').disabled=false;requestAnimationFrame(step);
  for(let p=1;active&&p<=doc.numPages;p++){await indexReference(p);await wait(20)}
 }catch(e){log(e.stack||String(e));status('تعذر تشغيل المحرك: '+e.message);stop()}
}
function stop(){
 active=false;stream?.getTracks().forEach(t=>t.stop());stream=null;$('video').srcObject=null;gate.reset();
 refPages.forEach(x=>deleteFeatures(x.features));refPages=[];doc?.destroy();doc=null;orb?.delete();matcher?.delete();orb=matcher=null;
 $('start').disabled=false;$('stop').disabled=true;status('متوقف');
}
$('start').onclick=start;$('stop').onclick=stop;
