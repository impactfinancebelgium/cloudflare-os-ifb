// Staff review page. Self-contained HTML + JS served by the worker. Prompts once for the
// ADMIN_KEY (kept in localStorage, sent as x-admin-key), lists candidates from /api/candidates
// with the traffic-light screening, and lets staff move stage/status. Colour rules mirror
// workflows/internship-recruiting/README.md. Cloudflare Access will wrap this at cutover.
//
// Styling: minimal, matching the cockpit (Claude look) so the mini apps read as one system:
// white surfaces, warm-neutral text/borders, a terracotta accent used sparingly. The only
// strong colour is the traffic light itself.

export function reviewPage(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>IFB Recruiting</title>
<style>
  :root{
    --bg:#faf9f5; --card:#fff; --fg:#3d3929; --card-fg:#141413; --muted:#83827d;
    --border:#e7e5de; --secondary:#e9e6dc; --secondary-fg:#28261b; --accent:#c96442;
    --radius:8px; --green:#2e7d57; --orange:#b8722e; --red:#b3402a;
  }
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
    color:var(--fg);background:var(--bg);-webkit-font-smoothing:antialiased}
  main{max-width:1000px;margin:0 auto;padding:26px 22px 64px}
  h1{margin:0;font-size:21px;font-weight:600;letter-spacing:-.01em;color:var(--card-fg)}
  .sub{margin:3px 0 18px;font-size:13px;color:var(--muted)}
  input,select,button{font:inherit;color:inherit}
  input,select{padding:7px 10px;border:1px solid var(--border);border-radius:7px;background:#fff;outline:none}
  input:focus,select:focus{border-color:#cdcabf}
  button{padding:6px 11px;border:1px solid var(--border);border-radius:7px;background:#fff;cursor:pointer}
  button:hover{background:var(--secondary)}
  button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
  button.primary:hover{background:#b4552d}
  .bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
  .chip{border:1px solid var(--border);border-radius:999px;padding:4px 11px;background:#fff;cursor:pointer;font-size:13px}
  .chip:hover{background:var(--secondary)}
  .chip.on{background:var(--secondary);border-color:var(--secondary);color:var(--secondary-fg);font-weight:500}
  .card{border:1px solid var(--border);border-radius:var(--radius);background:var(--card);padding:13px 15px;margin-bottom:9px}
  .row1{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  .name{font-weight:600;color:var(--card-fg)} .email{color:var(--muted);font-size:12.5px}
  .spacer{margin-left:auto;display:flex;gap:8px;align-items:center}
  .stage-sel{padding:4px 8px;font-size:12.5px;text-transform:capitalize}
  .verdict{border:1px solid;border-radius:6px;padding:1px 8px;font-size:12px;font-weight:500}
  .pos{color:var(--muted);font-size:12.5px;margin-top:2px}
  a.cv{color:var(--accent);text-decoration:none} a.cv:hover{text-decoration:underline}
  .lights{display:flex;flex-wrap:wrap;gap:5px 14px;margin-top:11px;font-size:12px}
  .l{display:inline-flex;align-items:center;gap:5px} .dot{width:8px;height:8px;border-radius:50%}
  .cmt{color:var(--muted);font-size:12.5px;margin-top:9px}
  .empty{color:var(--muted);font-size:13px;border:1px solid var(--border);border-radius:var(--radius);background:#fff;padding:14px 15px}
  #login{max-width:340px;margin:84px auto;text-align:center}
  #login .row{display:flex;gap:8px;margin-top:12px}
</style></head><body>
<main>
  <h1>Recruiting</h1>
  <p class="sub" id="sub">Candidate review, screening and pipeline</p>
  <div id="login" style="display:none">
    <p style="color:var(--muted);margin:0">Enter the review key to continue.</p>
    <div class="row"><input id="key" type="password" placeholder="Review key" style="flex:1">
    <button class="primary" onclick="saveKey()">Enter</button></div>
    <p id="loginerr" style="color:var(--red);font-size:13px"></p>
  </div>
  <div id="app" style="display:none">
    <div class="bar">
      <input id="q" placeholder="Search name, email, university…" style="flex:1;min-width:200px" oninput="render()">
      <span id="filters"></span>
      <button onclick="logout()">Sign out</button>
    </div>
    <div id="list"></div>
  </div>
</main>
<script>
const EU_C=["belg","austria","bulgaria","croatia","cyprus","czech","denmark","estonia","finland","france","germany","greece","hungary","ireland","italy","latvia","lithuania","luxembourg","malta","netherlands","poland","portugal","romania","slovak","sloven","spain","sweden"];
const EU_N=["belgian","austrian","bulgarian","croatian","cypriot","czech","danish","estonian","finnish","french","german","greek","hungarian","irish","italian","latvian","lithuanian","luxembourgish","maltese","dutch","polish","portuguese","romanian","slovak","sloven","spanish","swedish",...EU_C];
const hasAny=(s,l)=>!!s&&l.some(x=>s.toLowerCase().includes(x));
const isBE=s=>!!s&&/belg/i.test(s);
const langL=v=>v==="fluent"?"green":v==="knowledge"?"orange":v==="none"?"red":"neutral";
const expL=v=>!v?"neutral":/^no$/i.test(v.trim())?"red":/both/i.test(v)?"green":/yes/i.test(v)?"orange":"neutral";
const startL=v=>v==="good"?"green":v==="ok"?"orange":v==="off"?"red":"neutral";
const commitL=v=>!v?"neutral":/full/i.test(v)?"green":"orange";
const studyL=m=>m===1?"green":m===0?"orange":"neutral";
const countryL=c=>!c?"neutral":isBE(c)?"green":hasAny(c,EU_C)?"orange":"red";
const natL=(n,c)=>!n?"neutral":hasAny(n,EU_N)?"green":isBE(c)?"orange":"red";
const scoreL=s=>s==="good"?"green":s==="maybe"?"orange":s==="not_good"?"red":"neutral";
const COL={green:"#2e7d57",orange:"#b8722e",red:"#b3402a",neutral:"#83827d"};
const STAGES=["applied","cv_screen","interview_1","interview_2","decision"];
let DATA=[],KEY=localStorage.getItem("ifb_rec_key")||"",FILT=null;

function api(path,opts={}){return fetch(path,{...opts,headers:{"x-admin-key":KEY,"content-type":"application/json",...(opts.headers||{})}});}
function saveKey(){KEY=document.getElementById("key").value.trim();localStorage.setItem("ifb_rec_key",KEY);load();}
function logout(){localStorage.removeItem("ifb_rec_key");KEY="";show();}
function show(){document.getElementById("login").style.display=KEY?"none":"block";document.getElementById("app").style.display=KEY?"block":"none";}
async function load(){show();if(!KEY)return;const r=await api("/api/candidates");if(r.status===403){KEY="";localStorage.removeItem("ifb_rec_key");show();document.getElementById("loginerr").textContent="Wrong key.";return;}const d=await r.json();DATA=d.candidates||[];document.getElementById("sub").textContent=DATA.length+" candidates, with the screening status";renderFilters();render();}
function esc(s){return (s==null?"":String(s)).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
function light(l,label){return '<span class="l" style="color:'+COL[l]+'"><span class="dot" style="background:'+COL[l]+'"></span>'+esc(label)+'</span>';}
function renderFilters(){const m={};DATA.forEach(c=>{const s=c.stage||"applied";m[s]=(m[s]||0)+1});
  document.getElementById("filters").innerHTML='<span class="chip '+(!FILT?"on":"")+'" onclick="setF(null)">All '+DATA.length+'</span>'+
    STAGES.filter(s=>m[s]).map(s=>'<span class="chip '+(FILT===s?"on":"")+'" onclick="setF(\\''+s+'\\')">'+s+' '+m[s]+'</span>').join('');}
function setF(s){FILT=s;renderFilters();render();}
function render(){const q=(document.getElementById("q").value||"").toLowerCase();
  let list=DATA.filter(c=>(!FILT||(c.stage||"applied")===FILT));
  if(q)list=list.filter(c=>((c.first_name||"")+" "+(c.last_name||"")+" "+(c.email||"")+" "+(c.university||"")).toLowerCase().includes(q));
  document.getElementById("list").innerHTML=list.map(card).join("")||'<div class="empty">No candidates yet. Applications from the website careers form appear here.</div>';}
function d(v){return v&&String(v).trim()?esc(v):"-";}
function card(c){const name=esc(((c.first_name||"")+" "+(c.last_name||"")).trim()||"Unnamed");const sl=scoreL(c.score);
  const verdict=c.score==="good"?"Good":c.score==="maybe"?"Maybe":c.score==="not_good"?"Not good":"Unscored";
  return '<div class="card"><div class="row1"><span class="name">'+name+'</span><span class="email">'+d(c.email)+'</span>'+
    '<span class="spacer"><select class="stage-sel" onchange="patch(\\''+c.id+'\\',\\'stage\\',this.value)">'+STAGES.map(s=>'<option '+((c.stage||"applied")===s?"selected":"")+'>'+s+'</option>').join('')+'</select>'+
    '<span class="verdict" style="color:'+COL[sl]+';border-color:'+COL[sl]+'">'+verdict+'</span></span></div>'+
    '<div class="pos">'+d(c.position_applied)+(c.cv_key?' &middot; <a class="cv" href="/cv/'+c.id+'?k='+encodeURIComponent(KEY)+'" target="_blank">CV</a>':'')+'</div>'+
    '<div class="lights">'+
      light(startL(c.start_fit),"Start: "+d(c.start_month))+
      light(commitL(c.full_or_part_time),c.full_or_part_time?(/full/i.test(c.full_or_part_time)?"Full time":"Part time"):"Availability -")+
      light(studyL(c.mandatory_for_studies),"Study: "+d(c.study_level)+(c.mandatory_for_studies===1?" (mandatory)":""))+
      light(countryL(c.country_residence),"Lives: "+d(c.country_residence))+
      light(natL(c.nationality,c.country_residence),"Nat: "+d(c.nationality))+
      light(langL(c.lang_en),"EN")+light(langL(c.lang_fr),"FR")+light(langL(c.lang_nl),"NL")+
      light(expL(c.finance_experience),"Finance: "+d(c.finance_experience))+
      light(expL(c.impact_experience),"Impact: "+d(c.impact_experience))+
    '</div>'+
    (c.score_comment?'<div class="cmt">'+esc(c.score_comment)+'</div>':(c.score?'':'<div class="cmt">Not screened yet.</div>'))+
  '</div>';}
async function patch(id,field,value){await api("/api/candidates/"+id,{method:"PATCH",body:JSON.stringify({[field]:value})});const c=DATA.find(x=>x.id===id);if(c)c[field]=value;renderFilters();}
show();load();
</script>
</body></html>`;
}
