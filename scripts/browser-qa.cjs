const sleep=t=>new Promise(r=>setTimeout(r,t));
async function main(){
let tabs=await fetch("http://127.0.0.1:9222/json").then(r=>r.json());
const page=tabs.find(t=>t.type==="page"&&t.url.includes("8765"));
if(!page)throw Error("NO_PAGE");
const ws=new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true})});
let id=0;const tasks=new Map(),exceptions=[];
ws.addEventListener("message",e=>{const d=JSON.parse(e.data);if(d.id&&tasks.has(d.id)){tasks.get(d.id)(d);tasks.delete(d.id)}else if(d.method==="Runtime.exceptionThrown")exceptions.push(d.params.exceptionDetails?.text||"exception")});
function send(method,params={}){const key=++id;return new Promise((resolve,reject)=>{tasks.set(key,resolve);ws.send(JSON.stringify({id:key,method,params}));setTimeout(()=>{if(tasks.has(key)){tasks.delete(key);reject(Error(method+" timeout"))}},20000)})}
async function evaluate(expr){const res=await send("Runtime.evaluate",{expression:expr,returnByValue:true,awaitPromise:true});if(res.result?.exceptionDetails)throw Error(JSON.stringify(res.result.exceptionDetails).slice(0,400));return res.result?.result?.value}
await send("Runtime.enable");await send("Page.enable");
const results={};
results.home=await evaluate("({languages:document.querySelectorAll('#edition option').length,library:document.querySelector('#status').textContent,app:document.title})");
await evaluate("document.querySelector('[data-go=reader]').click()");
await sleep(2500);
results.arabic_first=await evaluate("({canvas:document.querySelector('#sheet').width,page:document.querySelector('#pageName').textContent,load:document.querySelector('#loading').textContent,hidden:document.querySelector('#loading').classList.contains('hidden')})");
await evaluate("let s=document.querySelector('#seek');s.value=17;s.dispatchEvent(new Event('change',{bubbles:true}))");
await sleep(1800);
results.arabic_17=await evaluate("({canvas:document.querySelector('#sheet').width,page:document.querySelector('#pageName').textContent,zones:document.querySelectorAll('.zone').length,feedback:document.querySelector('#feedback').textContent})");
await evaluate("let l=document.querySelector('#edition');l.value='en';l.dispatchEvent(new Event('change',{bubbles:true}))");
await sleep(2900);
results.english=await evaluate("({edition:document.querySelector('#edition').value,direction:document.documentElement.dir,canvas:document.querySelector('#sheet').width,page:document.querySelector('#pageName').textContent,loadingHidden:document.querySelector('#loading').classList.contains('hidden')})");
await evaluate("document.querySelector('[data-go=index]').click()");
await sleep(400);
results.index=await evaluate("({items:document.querySelectorAll('#toc button').length,shown:!document.querySelector('#index').classList.contains('hidden')})");
results.exceptions=exceptions;
console.log(JSON.stringify(results,null,2));ws.close();
if(!results.arabic_17.canvas||!results.english.canvas||results.home.languages!==19)process.exitCode=1;
}
main().catch(err=>{console.error(err);process.exitCode=1});