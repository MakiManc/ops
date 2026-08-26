#!/usr/bin/env python3
"""Build the claude.ai-Artifact edition of Ops Command from the Pages build.

    python3 builders/build_command_artifact.py [out.html]

command/index.html targets GitHub Pages and the Cowork desktop artifact
runtime. Four things stop it working as a claude.ai artifact unchanged, and
this script rewrites each one, leaving the Pages build untouched:

  1. The artifact CSP blocks cross-origin fetch, so the baked JSON that the
     Pages build pulls from makimanc.github.io is embedded instead. Only the
     latest snapshot fits (the full set is ~20MB against a 16MB ceiling), so
     the roll-back selector is narrowed to that one date.
  2. window.cowork.callMcpTool does not exist in a claude.ai artifact; MCP is
     reached through claude.use('mcp').callTool(server, tool, args), and
     connectors are addressed by display name rather than installed-server UUID.
  3. Gmail and Calendar were called with Google-API argument names
     (q/maxResults, timeMin/timeMax). The connectors take query/pageSize and
     startTime/endTime - the old names are silently wrong on both runtimes.
  4. A Gmail thread carries subject/sender/snippet on messages[], not on the
     thread object, so every row rendered as "(no subject)".

Re-run after each Pipe 9 bake and republish; on Pages a refresh stays a commit.
"""
import json, pathlib, sys

REPO = pathlib.Path(__file__).resolve().parent.parent
SRC  = REPO / "command/index.html"
DATA = REPO / "data/ops_command"
OUT  = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else REPO / "command/artifact.html")

src = SRC.read_text(encoding="utf-8")

def sub(old, new, why):
    """Replace exactly once, or fail loudly - a silent miss ships a broken page."""
    n = src.count(old)
    if n != 1:
        raise SystemExit(f"FAIL [{why}]: expected 1 occurrence, found {n}\n  {old[:110]!r}")
    return src.replace(old, new, 1)

# ---- 1. shell: strip the document skeleton (the publisher supplies it) ----
head_end = "</style></head><body>"
if src.count(head_end) != 1:
    raise SystemExit("FAIL: head/body boundary not found")
body_end = "</script></body></html>"
if not src.rstrip().endswith(body_end):
    raise SystemExit("FAIL: unexpected document tail")

start = src.index("<style>")
src = src[start:]
src = src.replace(head_end, "</style>", 1)
src = src.rstrip()
assert src.endswith(body_end)
src = src[: -len(body_end)] + "</script>"
src = "<title>Ops Command</title>\n" + src

# ---- 2. data plane: embed the baked JSON, drop the Pages fetches ----
index  = json.loads((DATA / "snapshot_index.json").read_text())
health = json.loads((DATA / "health_latest.json").read_text())
latest = index["latest"]
snapshot = json.loads((DATA / f"snapshot_{latest}.json").read_text())

# Only the latest snapshot is embedded: the full set is ~20MB, over the
# artifact ceiling. The roll-back selector is narrowed to match rather than
# left offering dates that cannot resolve.
inline = {
    "index": {**index, "dates": [latest]},
    "health": health,
    "snapshots": {latest: snapshot},
}
# '<' only ever occurs inside JSON string values, so < is a safe,
# lossless escape that cannot terminate the script element early.
payload = json.dumps(inline, separators=(",", ":")).replace("<", "\\u003c")

src = sub(
    """const BASES = window.OPS_BASE ? [window.OPS_BASE]
  : location.hostname.endsWith('github.io') ? ['../data/ops_command/']
  : ['https://makiramen.github.io/ops/data/ops_command/',
     'https://makimanc.github.io/ops/data/ops_command/'];
let BASE = BASES[0];""",
    """/* Artifact build: the artifact CSP blocks cross-origin fetch, so the baked
   JSON is embedded above rather than pulled from Pages. A data refresh is a
   rebuild of this artifact - on Pages it stays a commit. */
const INLINE = JSON.parse(document.getElementById('ops-inline-data').textContent);""",
    "data plane base",
)

src = sub(
    """    const r=await fetch(BASE+'health_latest.json'+cb(),{cache:'no-store'});
    if(r.ok) HEALTH=await r.json();""",
    """    HEALTH=INLINE.health||null;""",
    "health fetch",
)

src = sub(
    """  const r=await fetch(BASE+'snapshot_'+date+'.json'+cb(),{cache:'no-store'});
  if(!r.ok) throw new Error('snapshot_'+date+'.json → HTTP '+r.status);
  SNAP=await r.json(); render(SNAP);""",
    """  const s=INLINE.snapshots[date];
  if(!s) throw new Error('snapshot '+date+' is not embedded in this artifact');
  SNAP=s; render(SNAP);""",
    "snapshot fetch",
)

src = sub(
    """async function fetchIndex(){
  let lastErr;
  for(const b of BASES){
    try{
      const r=await fetch(b+'snapshot_index.json'+cb(),{cache:'no-store'});
      if(r.ok){ BASE=b; return await r.json(); }
      lastErr=new Error('HTTP '+r.status+' from '+b);
    }catch(e){ lastErr=e; }
  }
  throw lastErr||new Error('no data source reachable');
}""",
    """async function fetchIndex(){ return INLINE.index; }""",
    "index fetch",
)

src = sub(
    """      Expected <code>${esc(BASE)}snapshot_index.json</code> — if this is a fresh deploy, give GitHub Pages a minute.</div>`;""",
    """      The snapshot baked into this artifact could not be read.</div>`;""",
    "boot error copy",
)

# ---- 3. MCP: window.cowork -> the artifact runtime's claude.use('mcp') ----
src = sub(
    """const MAIL='mcp__598036e9-89ad-45a1-8ef2-b85a1f625af1__search_threads';
const CAL='mcp__d7c8cd5b-a2a7-42b7-95b5-71789965a6d2__list_events';
const ASANA='mcp__3534415d-a90c-44e8-a60a-c8f5fc6fb5dc__get_my_tasks';""",
    """/* Artifact build: connectors are addressed by display name here, not by the
   installed-server UUID the Cowork runtime used. */
const MAIL=['Gmail','search_threads'];
const CAL=['Google Calendar','list_events'];
const ASANA=['Asana','get_my_tasks'];""",
    "mcp tool constants",
)

src = sub(
    """function isPermErr(e){return /allowlist|not permitted|permission|denied|not granted|unauthori/i.test(String(e&&e.message||e));}""",
    """const PERM_CODES=['not_granted','not_in_manifest','blocked_by_policy','approval_required',
  'needs_reauth','server_not_connected','server_not_found','selection_required'];
function isPermErr(e){
  if(e&&e.code) return PERM_CODES.includes(e.code);
  return /allowlist|not permitted|permission|denied|not granted|unauthori/i.test(String(e&&e.message||e));
}""",
    "isPermErr",
)

src = sub(
    """function mcp(tool,args){
  if(!window.cowork||typeof window.cowork.callMcpTool!=='function')
    return Promise.reject(new Error('no-viewer'));
  return Promise.race([window.cowork.callMcpTool(tool,args),
    new Promise((_,rej)=>setTimeout(()=>rej(new Error('Timed out after 120s')),120000))]);
}""",
    """/* claude.use() resolves the namespace once, later than first script run and
   null outside a viewer - so memoise the promise and design for absence. */
let MCPNS;
function mcpReady(){
  if(MCPNS===undefined)
    MCPNS=(window.claude&&typeof window.claude.use==='function')
      ? window.claude.use('mcp').catch(()=>null)
      : Promise.resolve(null);
  return MCPNS;
}
async function mcp(server,tool,args){
  const ns=await mcpReady();
  if(!ns) throw new Error('no-viewer');
  const r=await Promise.race([ns.callTool(server,tool,args),
    new Promise((_,rej)=>setTimeout(()=>rej(new Error('Timed out after 120s')),120000))]);
  return r&&r.payload!==undefined?r.payload:r;   // payload is the JSON answer
}""",
    "mcp()",
)

src = sub(
    """  if(!window.cowork||typeof window.cowork.callMcpTool!=='function'){""",
    """  if(!(await mcpReady())){""",
    "loadDay viewer guard",
)

# ---- 4. call the connectors with the argument names they actually take ----
src = sub(
    """    mcp(MAIL,{q:`after:${since} (supplier OR delivery OR maintenance OR order OR invoice OR Lynas)`,maxResults:25}),
    mcp(CAL,{timeMin:now.toISOString(),timeMax:wk.toISOString(),maxResults:25}),
    mcp(ASANA,{completed_since:'now'})]);""",
    """    mcp(...MAIL,{query:`after:${since} (supplier OR delivery OR maintenance OR order OR invoice OR Lynas)`,pageSize:25}),
    mcp(...CAL,{startTime:now.toISOString(),endTime:wk.toISOString(),pageSize:25,orderBy:'startTime'}),
    mcp(...ASANA,{completed_since:'now',limit:50})]);""",
    "connector arguments",
)

# ---- 5. a Gmail thread carries its fields on messages[], not on the thread ----
src = sub(
    """      const th=raw.map(t=>({subj:String(pick(t,['subject','title'])||'(no subject)'),
        from:String(pick(t,['from','sender'])||''),snip:String(pick(t,['snippet','preview'])||'')}))""",
    """      const th=raw.map(t=>{
        const ms=Array.isArray(t.messages)&&t.messages.length?t.messages:null;
        const m=ms?ms.reduce((a,b)=>String(b.date||'')>String(a.date||'')?b:a):t;   // newest in thread
        return {subj:String(pick(m,['subject','title'])||pick(t,['subject','title'])||'(no subject)'),
          from:String(pick(m,['from','sender'])||''),
          snip:String(pick(m,['snippet','preview'])||'')};
      })""",
    "gmail thread shape",
)

src = sub(
    """    '<div class="s">Granted once at artifact creation — this artifact is never updated, so grants stick</div></div>'+""",
    """    '<div class="s">Granted by you on first open — calls run against your own connectors</div></div>'+""",
    "connector card copy",
)

# ---- 6. inject the embedded data ahead of the shell script ----
marker = "<script>\n/* ------------ data plane: baked JSON on GitHub Pages ------------ */"
if src.count(marker) != 1:
    raise SystemExit("FAIL: script marker not found")
src = src.replace(
    marker,
    '<script type="application/json" id="ops-inline-data">' + payload + "</script>\n" + marker,
    1,
)

# ---- 7. CSV export: a.download is inert in the viewer, so route it through
#         the downloads capability (and hide the button where unavailable) ----
src = sub(
    r"""$('tr-csv').addEventListener('click',e=>{
  e.stopPropagation();
  const out=(SNAP&&SNAP.training&&SNAP.training.outstanding)||[];
  const rows=out.filter(o=>(TR_MODE!=='mand'||o.mand)&&(TR_KIND==='all'||regionOf(o.site)===TR_KIND));
  const q=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
  const csv='site,person,module,status,due\n'+
    rows.map(o=>[o.site,o.person,o.module,o.status,o.due||''].map(q).join(',')).join('\n');
  const a=document.createElement('a');
  a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download=(TR_MODE==='mand'?'mandatory':'all')+'_training_outstanding_'+(TR_KIND!=='all'?TR_KIND+'_':'')+((SNAP&&SNAP.pull_date)||'latest')+'.csv';
  document.body.appendChild(a); a.click(); a.remove();
});""",
    r"""let DLNS;
function dlReady(){
  if(DLNS===undefined)
    DLNS=(window.claude&&typeof window.claude.use==='function')
      ? window.claude.use('downloads').catch(()=>null)
      : Promise.resolve(null);
  return DLNS;
}
/* The viewer blocks a page's own download link, so the file goes through
   downloads.save(), which asks the viewer before writing anything. */
dlReady().then(dl=>{ if(!dl) $('tr-csv').style.display='none'; });
$('tr-csv').addEventListener('click',async e=>{
  e.stopPropagation();
  const out=(SNAP&&SNAP.training&&SNAP.training.outstanding)||[];
  const rows=out.filter(o=>(TR_MODE!=='mand'||o.mand)&&(TR_KIND==='all'||regionOf(o.site)===TR_KIND));
  const q=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
  const csv='site,person,module,status,due\n'+
    rows.map(o=>[o.site,o.person,o.module,o.status,o.due||''].map(q).join(',')).join('\n');
  const stem=(TR_MODE==='mand'?'mandatory':'all')+'_training_outstanding_'+(TR_KIND!=='all'?TR_KIND+'_':'')+((SNAP&&SNAP.pull_date)||'latest');
  const dl=await dlReady(); if(!dl) return;
  const btn=$('tr-csv'), lb=btn.textContent;
  const say=m=>{btn.textContent=m; setTimeout(()=>{btn.textContent=lb;},2600);};
  try{
    await dl.save({filename:stem+'.csv',data:csv});
  }catch(err){
    const c=err&&err.code;
    if(c==='declined') return;                    // the viewer said no - never retry
    if(c==='extension_not_enabled'){              // .csv is in the extended set; .txt always allowed
      try{ await dl.save({filename:stem+'.txt',data:csv}); }
      catch(e2){ if(e2&&e2.code!=='declined') say(e2&&e2.code==='too_large'?'too large':'save failed'); }
      return;
    }
    say(c==='too_large'?'too large':c==='rate_limited'?'try again':'save failed');
  }
});""",
    "csv export via downloads capability",
)

OUT.write_text(src, encoding="utf-8")
mb = OUT.stat().st_size / 1e6
print(f"OK  {OUT}  {mb:.2f} MB  (snapshot {latest}, {len(snapshot.get('sites') or [])} sites)")
if mb > 15:
    raise SystemExit(f"FAIL: {mb:.2f} MB exceeds the 16MB artifact ceiling")
