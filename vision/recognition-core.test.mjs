import {test} from 'node:test';
import assert from 'node:assert/strict';
import {project,invertHomography,chooseTarget,choosePage,PointingGate} from './recognition-core.mjs';
const tokens=[{id:'one',text:'بِسْمِ',confidence:.96,box:{x:20,y:25,width:30,height:14}},{id:'two',text:'اللّٰهِ',confidence:.97,box:{x:59,y:25,width:31,height:14}}];
test('partial-page perspective transform invertibility',()=>{
 const h=[1.1,.08,100,-.03,1.3,55,.0004,.0002,1],p={x:65,y:25},back=project(invertHomography(h),project(h,p));
 assert.ok(Math.abs(back.x-p.x)<1e-6);assert.ok(Math.abs(back.y-p.y)<1e-6);
});
test('invalid homography never guesses',()=>{assert.equal(invertHomography([0,0,0,0,0,0,0,0,0]),null);assert.equal(project([0,0,0,0,0,0,0,0,0],{x:1,y:1}),null)});
test('missing or distant pointer never snaps to text',()=>{assert.equal(chooseTarget(null,tokens).target,null);assert.equal(chooseTarget({x:160,y:160},tokens).target,null)});
test('whole word selected from any indicated letter inside',()=>{assert.equal(chooseTarget({x:21,y:30},tokens).target.id,'one');assert.equal(chooseTarget({x:80,y:37},tokens).target.id,'two')});
test('ambiguous overlapping targets are rejected',()=>{assert.equal(chooseTarget({x:30,y:30},[tokens[0],{...tokens[0],id:'other'}]).reason,'ambiguous-neighbours')});
test('weak or tied page evidence rejected',()=>{
 assert.equal(choosePage([{page:2,inliers:5,matches:9,score:.9}]).page,null);
 assert.equal(choosePage([{page:2,inliers:11,matches:15,score:.76},{page:3,inliers:12,matches:16,score:.71}]).page,null);
 assert.equal(choosePage([{page:2,inliers:13,matches:16,score:.9},{page:3,inliers:11,matches:16,score:.63}]).page,2);
});
test('no visual pointing evidence means no output',()=>{const g=new PointingGate();for(let i=0;i<20;i++)assert.equal(g.update({at:i*40,page:{page:7,confidence:.9},tokens}).accepted,false)});
test('uncertain page blocks output',()=>{const g=new PointingGate(),pointer={type:'finger',confidence:.95,tip:{x:24,y:27}};for(let i=0;i<20;i++)assert.equal(g.update({at:i*60,page:{page:7,confidence:.4},pointer,tokens}).accepted,false)});
test('stabilization, one trigger while held, re-arm after lifting',()=>{
 const g=new PointingGate(),page={page:7,confidence:.9},pointer={type:'pen',confidence:.95,tip:{x:24,y:27}};
 const outputs=Array.from({length:12},(_,i)=>g.update({at:i*65,page,pointer,tokens}));
 assert.equal(outputs.filter(x=>x.accepted).length,1);assert.equal(outputs.find(x=>x.accepted).targetText,'بِسْمِ');
 g.update({at:1300,page,tokens});g.update({at:1550,page,tokens});
 const again=[1551,1620,1690,1760,1830].map(at=>g.update({at,page,pointer,tokens}));
 assert.equal(again.filter(x=>x.accepted).length,1);
});