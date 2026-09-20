/**
 * view.js — `mapd view`. Emits ONE self-contained HTML file (no server, no CDN,
 * data inlined) with three views the wishlist asked for:
 *   • graph  — workflows, their entry, and the file/edge counts (dynamic +
 *              unresolved edges and annotations called out)
 *   • heatmap — every file as a cell, recolorable by confidence-workflow, test
 *              credit, reachability, or dynamic-call density
 *   • diff    — per-workflow confidence vs the saved baseline (when present)
 *
 * Everything shown is derived from the real scored graph — no invented numbers.
 */

import { buildScoredGraph } from "./intelligence.js";
import { loadBaseline } from "./regression.js";
import { classifyTestCredit } from "./testGuidance.js";
import { ceilingScore } from "./score.js";

const ANON = /^<anon[:>]/;

export function buildViewModel(rootDir) {
  const graph = buildScoredGraph(rootDir);
  const credit = new Map(classifyTestCredit(graph).map((c) => [c.file, c.status]));
  const wfByFile = new Map();
  for (const w of graph.workflows) for (const f of w.files) {
    if (!wfByFile.has(f)) wfByFile.set(f, []);
    wfByFile.get(f).push(w.id);
  }

  // per-file dynamic/unresolved call density
  const dyn = new Map();
  for (const e of graph.callEdges ?? []) {
    if (e.resolution === "dynamic" || e.resolution === "unresolved") {
      const f = String(e.from).split("#")[0];
      dyn.set(f, (dyn.get(f) ?? 0) + 1);
    }
  }
  const reachClass = (file) => {
    const r = graph.reachability ?? {};
    for (const [bucket, label] of Object.entries({ generatedArtifacts: "generated", dynamicallyLoaded: "dynamic", intentionalDormant: "dormant", heuristicUnverified: "heuristic", trulyOrphaned: "orphan" })) {
      if ((r[bucket] ?? []).some((x) => (typeof x === "string" ? x : x.file) === file)) return label;
    }
    return wfByFile.has(file) ? "reachable" : "uncovered";
  };

  const files = graph.files.map((f) => ({
    file: f.file,
    loc: f.loc ?? 0,
    parser: f.parserKind ?? "ast",
    test: credit.get(f.file) ?? "untested",
    reach: reachClass(f.file),
    dynamic: dyn.get(f.file) ?? 0,
    anon: (f.functions ?? []).filter((fn) => !fn.name || ANON.test(fn.name)).length,
    workflows: wfByFile.get(f.file) ?? [],
    annotated: !!(graph.reachability?.intentionalDormant ?? []).some?.((x) => (typeof x === "string" ? x : x.file) === f.file),
  }));

  const loaded = loadBaseline(rootDir);
  const baseWf = loaded && !loaded.schemaMismatch ? new Map(loaded.graph.workflows.map((w) => [w.id, w.confidence.score])) : null;

  const workflows = graph.workflows.map((w) => ({
    id: w.id,
    entry: w.entry.file,
    kind: w.entry.kind,
    fileCount: w.files.length,
    confidence: w.confidence.score,
    signalCoverage: w.confidence.signalCoverage,
    signals: Object.fromEntries(Object.entries(w.confidence.signals).map(([k, s]) => [k, s.value])),
    baseline: baseWf ? baseWf.get(w.id) ?? null : null,
    dynamicEdges: (w.files.reduce((a, f) => a + (dyn.get(f) ?? 0), 0)),
  }));

  const ceiling = ceilingScore(rootDir, graph);

  return {
    generatedAt: new Date().toISOString(),
    root: rootDir,
    repoConfidence: graph.repoConfidence,
    ceiling: { value: ceiling.ceiling, signalCoverage: ceiling.ceilingSignalCoverage },
    stats: { files: graph.files.length, workflows: graph.workflows.length, orphans: (graph.orphans ?? []).length, resolutionRate: graph.stats.callResolutionRate },
    baselinePresent: !!baseWf,
    workflows,
    files,
  };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function renderViewHtml(model, { serve = false } = {}) {
  const json = JSON.stringify(model).replace(/</g, "\\u003c");
  const askTab = serve ? `<button class="tab" data-v="ask">💬 Ask Map'd</button>` : "";
  const askView = serve ? `<section class="view" id="v-ask">
<div class="card mut" style="font-size:13px">Ask about anything you see here — I read the real map and reports. Try: <b>what should I work on</b>, <b>what's the honest ceiling</b>, <b>show test gaps</b>, <b>explain finding &lt;id&gt;</b>, <b>is the project passing</b>. (Read-only: fixes &amp; approvals stay in the terminal.)</div>
<div id="chatlog"></div>
<div style="display:flex;gap:8px;margin-top:10px"><input id="chatin" placeholder="Ask Map'd…" style="flex:1;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--fg);font:inherit"><button id="chatsend" class="tab on" style="cursor:pointer">Send</button></div>
</section>` : "";
  const askCss = serve ? `.msg{margin:8px 0;padding:9px 12px;border-radius:8px;max-width:90%;white-space:pre-wrap;font-size:13px;overflow-x:auto}
.msg.you{background:var(--acc);color:#fff;margin-left:auto}.msg.mapd{background:var(--panel);border:1px solid var(--line)}
#chatlog{display:flex;flex-direction:column;min-height:120px}` : "";
  const askJs = serve ? `
const log=document.getElementById('chatlog'),inp=document.getElementById('chatin'),snd=document.getElementById('chatsend');
function add(who,txt){const d=document.createElement('div');d.className='msg '+who;d.textContent=txt;log.appendChild(d);log.scrollTop=log.scrollHeight;return d;}
const CMD=/(work on|ceiling|test gap|padding|passing|status|explain|score|improve|verify|resolution|trace|solution|diagnose|which files|untested)/i;
async function ask(){const q=inp.value.trim();if(!q)return;inp.value='';add('you',q);
  const slow=!CMD.test(q);const t=add('mapd',slow?'thinking… (free-form answers use the LLM and can take up to a minute)':'…');
  snd.disabled=true;inp.disabled=true;
  const ac=new AbortController();const to=setTimeout(()=>ac.abort(),180000);
  try{const r=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:q}),signal:ac.signal});const j=await r.json();t.textContent=j.reply;}
  catch(e){t.textContent=e.name==='AbortError'?'(that took too long and timed out — try a command-style question like "what should I work on", which answers instantly)':'(could not reach the Map\\'d server — is it still running in your terminal?)';}
  finally{clearTimeout(to);snd.disabled=false;inp.disabled=false;inp.focus();log.scrollTop=log.scrollHeight;}}
snd.onclick=ask;inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&!snd.disabled)ask();});
inp.focus();` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Map'd — ${esc(model.root)}</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#262b36;--fg:#e6e9ef;--dim:#8b93a3;--good:#3fb950;--warn:#d29922;--bad:#f85149;--acc:#58a6ff}
@media (prefers-color-scheme:light){:root{--bg:#f6f8fa;--panel:#fff;--line:#d0d7de;--fg:#1f2328;--dim:#656d76;--acc:#0969da}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{padding:20px 24px;border-bottom:1px solid var(--line)}h1{margin:0 0 4px;font-size:18px}.sub{color:var(--dim);font-size:13px}
.big{font-size:30px;font-weight:700}.stats{display:flex;gap:28px;flex-wrap:wrap;margin-top:12px}.stat b{display:block;font-size:20px}
main{padding:20px 24px;max-width:1200px;margin:0 auto}.tabs{display:flex;gap:8px;margin:16px 0}
.tab{padding:6px 14px;border:1px solid var(--line);border-radius:20px;background:var(--panel);color:var(--fg);cursor:pointer;font-size:13px}
.tab.on{background:var(--acc);border-color:var(--acc);color:#fff}
.view{display:none}.view.on{display:block}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:12px}
.wf{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}
.bar{height:8px;border-radius:4px;background:var(--line);overflow:hidden;flex:1;min-width:120px}.bar>i{display:block;height:100%}
.sig{display:grid;grid-template-columns:130px 1fr 48px;gap:8px;align-items:center;margin-top:6px;font-size:12px;color:var(--dim)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(16px,1fr));gap:3px;margin-top:8px}
.cell{aspect-ratio:1;border-radius:3px;cursor:pointer;border:1px solid rgba(0,0,0,.15)}
.legend{display:flex;gap:14px;flex-wrap:wrap;margin:10px 0;font-size:12px;color:var(--dim)}.legend span{display:inline-flex;align-items:center;gap:5px}
.sw{width:12px;height:12px;border-radius:3px;display:inline-block}
.metric{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.metric button{font-size:12px;padding:4px 10px;border:1px solid var(--line);background:var(--panel);color:var(--fg);border-radius:6px;cursor:pointer}.metric button.on{border-color:var(--acc);color:var(--acc)}
#detail{position:sticky;bottom:0;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin-top:10px;font-size:13px;min-height:20px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid var(--line);padding:7px 8px;text-align:left}
.up{color:var(--good)}.down{color:var(--bad)}.mut{color:var(--dim)}
.pill{font-size:11px;padding:1px 7px;border-radius:10px;border:1px solid var(--line);color:var(--dim)}
${askCss}
</style></head><body>
<header>
<h1>Map'd <span class="sub">— ${esc(model.root)}</span></h1>
<div class="stats">
<div class="stat"><span class="sub">repo confidence</span><b class="big" id="rc"></b></div>
<div class="stat"><span class="sub">honest ceiling</span><b id="cl"></b></div>
<div class="stat"><span class="sub">files</span><b id="nf"></b></div>
<div class="stat"><span class="sub">workflows</span><b id="nw"></b></div>
<div class="stat"><span class="sub">call resolution</span><b id="rr"></b></div>
</div>
<div class="sub" style="margin-top:6px" id="gen"></div>
</header>
<main>
<div class="tabs">
<button class="tab on" data-v="graph">Graph</button>
<button class="tab" data-v="heat">Heatmap</button>
<button class="tab" data-v="diff">Diff vs baseline</button>
${askTab}
</div>
${askView}
<section class="view on" id="v-graph"></section>
<section class="view" id="v-heat">
<div class="metric" id="metricbar"></div>
<div class="legend" id="legend"></div>
<div class="grid" id="heat"></div>
<div id="detail" class="mut">Hover or click a cell for file details.</div>
</section>
<section class="view" id="v-diff"></section>
</main>
<script id="data" type="application/json">${json}</script>
<script>
const M=JSON.parse(document.getElementById('data').textContent);
const conf=v=>v>=.8?'var(--good)':v>=.6?'var(--warn)':'var(--bad)';
document.getElementById('rc').textContent=M.repoConfidence;document.getElementById('rc').style.color=conf(M.repoConfidence);
document.getElementById('cl').textContent=M.ceiling.value+' ('+M.ceiling.signalCoverage+')';
document.getElementById('nf').textContent=M.stats.files;document.getElementById('nw').textContent=M.stats.workflows;
document.getElementById('rr').textContent=(M.stats.resolutionRate*100).toFixed(1)+'%';
document.getElementById('gen').textContent='generated '+M.generatedAt+(M.stats.orphans?(' · '+M.stats.orphans+' orphan(s)'):'');

// GRAPH: workflow cards with signal bars
const SIG=['parseIntegrity','resolutionRate','testPresence','stability','coverageOfRepo'];
document.getElementById('v-graph').innerHTML=M.workflows.map(w=>{
  const bars=SIG.map(s=>{const v=w.signals[s];const val=v==null?0:v;const txt=v==null?'n/a':val.toFixed(2);
    return '<div class="sig"><span>'+s+'</span><div class="bar"><i style="width:'+(val*100)+'%;background:'+conf(val)+'"></i></div><span>'+txt+'</span></div>';}).join('');
  return '<div class="card"><div class="wf"><div><b>'+w.id+'</b> <span class="pill">'+w.kind+'</span> <span class="mut">entry '+w.entry+'</span></div>'+
    '<div style="text-align:right"><b style="color:'+conf(w.confidence)+';font-size:18px">'+w.confidence+'</b><br><span class="mut">'+w.fileCount+' files · sigCov '+w.signalCoverage+(w.dynamicEdges?' · '+w.dynamicEdges+' dyn edges':'')+'</span></div></div>'+bars+'</div>';
}).join('');

// HEATMAP
const METRICS={
  confidence:{label:'workflow confidence',color:f=>{const w=M.workflows.filter(w=>f.workflows.includes(w.id));if(!w.length)return '#3a3f4b';return conf(Math.min(...w.map(x=>x.confidence)));},legend:[['#3fb950','high ≥.8'],['#d29922','.6–.8'],['#f85149','<.6'],['#3a3f4b','uncovered']]},
  test:{label:'test credit',color:f=>({'tested-real':'#3fb950','tested-shallow':'#58a6ff','tested-nameonly':'#d29922','untested':'#f85149'}[f.test]||'#3a3f4b'),legend:[['#3fb950','real'],['#58a6ff','shallow'],['#d29922','name-only'],['#f85149','untested']]},
  reach:{label:'reachability',color:f=>({reachable:'#3fb950',dynamic:'#58a6ff',dormant:'#8b5cf6',generated:'#8b93a3',heuristic:'#d29922',orphan:'#f85149',uncovered:'#3a3f4b'}[f.reach]||'#3a3f4b'),legend:[['#3fb950','reachable'],['#58a6ff','dynamic'],['#d29922','heuristic'],['#f85149','orphan'],['#8b93a3','generated']]},
  dynamic:{label:'dynamic-call density',color:f=>{const d=f.dynamic;return d===0?'#3a3f4b':d<3?'#d29922':d<10?'#e8703a':'#f85149';},legend:[['#3a3f4b','0'],['#d29922','1–2'],['#e8703a','3–9'],['#f85149','10+']]}
};
let metric='test';
const mbar=document.getElementById('metricbar');
mbar.innerHTML=Object.entries(METRICS).map(([k,m])=>'<button data-m="'+k+'"'+(k===metric?' class="on"':'')+'>'+m.label+'</button>').join('');
function drawHeat(){
  const m=METRICS[metric];
  document.getElementById('legend').innerHTML=m.legend.map(([c,l])=>'<span><i class="sw" style="background:'+c+'"></i>'+l+'</span>').join('');
  document.getElementById('heat').innerHTML=M.files.map((f,i)=>'<div class="cell" data-i="'+i+'" title="'+f.file.replace(/"/g,'')+'" style="background:'+m.color(f)+'"></div>').join('');
}
mbar.onclick=e=>{if(e.target.dataset.m){metric=e.target.dataset.m;[...mbar.children].forEach(b=>b.classList.toggle('on',b.dataset.m===metric));drawHeat();}};
const det=document.getElementById('detail');
document.getElementById('heat').addEventListener('mouseover',e=>{const i=e.target.dataset.i;if(i==null)return;const f=M.files[i];
  det.className='';det.innerHTML='<b>'+f.file+'</b> · '+f.loc+' LOC · '+f.parser+' · test: '+f.test+' · '+f.reach+(f.dynamic?' · '+f.dynamic+' dynamic calls':'')+(f.anon?' · '+f.anon+' anon fn':'')+(f.workflows.length?' · '+f.workflows.join(', '):' · not in a workflow');});
drawHeat();

// DIFF
const dv=document.getElementById('v-diff');
if(!M.baselinePresent){dv.innerHTML='<div class="card mut">No comparable baseline. Run <code>mapd baseline</code> to enable the diff view.</div>';}
else{dv.innerHTML='<table><tr><th>workflow</th><th>baseline</th><th>current</th><th>Δ</th></tr>'+M.workflows.map(w=>{const b=w.baseline;const d=b==null?null:+(w.confidence-b).toFixed(3);
  const cls=d==null?'mut':d>0?'up':d<0?'down':'mut';return '<tr><td>'+w.id+'</td><td>'+(b==null?'—':b)+'</td><td>'+w.confidence+'</td><td class="'+cls+'">'+(d==null?'new':(d>0?'+':'')+d)+'</td></tr>';}).join('')+'</table>';}

// TABS
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('on',x===t));
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('on'));
  document.getElementById('v-'+t.dataset.v).classList.add('on');
});
${askJs}
</script></body></html>`;
}
