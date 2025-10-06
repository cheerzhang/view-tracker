/* ---- Utils: CSV parsing (robust, no lib) ---- */
function parseCSV(text){
  // Normalize newlines; strip BOM; split lines
  text = text.replace(/^\uFEFF/, "");
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(l=>l.trim().length);
  if(!lines.length) throw new Error("Empty CSV");
  // Split respecting simple quotes
  const split = (line)=>{
    const out=[]; let cur=""; let q=false;
    for(let i=0;i<line.length;i++){
      const c=line[i];
      if(c === '"'){ 
        if(line[i+1] === '"'){ cur+='"'; i++; } else { q=!q; }
      }else if(c === ',' && !q){ out.push(cur); cur=""; }
      else cur+=c;
    }
    out.push(cur);
    return out;
  };
  const headersRaw = split(lines[0]).map(h=>h.trim());
  const headers = headersRaw.map(h => h.replace(/^\uFEFF/,"").toLowerCase());
  const rows = [];
  for(let i=1;i<lines.length;i++){
    const cols = split(lines[i]);
    if(cols.length === 1 && cols[0].trim()==="") continue;
    const obj = {};
    headers.forEach((h,idx)=> obj[h] = (cols[idx]??"").trim());
    rows.push(obj);
  }
  return { headers, rows, headersRaw };
}

/* ---- Data model & cache ---- */
const CACHE_KEY = "b44_metrics_cache_v1";
function saveCache(payload){ localStorage.setItem(CACHE_KEY, JSON.stringify(payload)); }
function loadCache(){ try{ return JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); }catch{ return null; } }

/* ---- DOM refs ---- */
const els = {
  project: document.getElementById("projectSelect"),
  platform: document.getElementById("platformSelect"),
  range: document.getElementById("rangeSelect"),
  btnDaily: document.getElementById("btnDaily"),
  btnCum: document.getElementById("btnCum"),
  csv: document.getElementById("csvInput"),
  btnClear: document.getElementById("btnClear"),
  kViews: document.getElementById("kpiViews"),
  kLikes: document.getElementById("kpiLikes"),
  kComments: document.getElementById("kpiComments"),
  kAvg: document.getElementById("kpiAvg"),
  title: document.getElementById("chartTitle"),
  btnExport: document.getElementById("btnExportCsv"),
  versionTag: document.getElementById("versionTag"),
};

let STATE = {
  mode: "daily",   // "daily" | "cum"
  dataset: [],     // normalized rows
  colors: {},      // platform -> color
  projects: [],    // unique project names
  platforms: [],   // unique platforms for selected project
  series: [],      // echarts series
  x: [],           // dates
  echarts: null
};

/* ---- CSV normalization & business rules ---- */
const aliases = {
  "views":"views_daily", "view_count":"views_daily", "plays":"views_daily"
};

function normalizeHeaders(headers){
  return headers.map(h => {
    let k = h.trim().toLowerCase();
    k = k.replace(/^\uFEFF/,"");
    if (aliases[k]) return aliases[k];
    return k;
  });
}

function parseDate(s){
  if(!s) return null;
  const t = s.includes("/") ? s.replace(/\//g,"-") : s;
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
}

function normalizeRows(headers, rows){
  const idx = (name)=> headers.indexOf(name);
  const requireAny = [["views_daily","views_cum","views","view_count","plays"]];
  const required = ["date","project","platform","title"];

  // Validate presence (case-insensitive already)
  for(const r of required){
    if(!headers.includes(r)) throw new Error(`Missing required field: ${r}`);
  }
  if(!requireAny[0].some(k=>headers.includes(k))) throw new Error("CSV must include one of: views_daily, views_cum, views, view_count, plays");

  const out = [];
  for(const row of rows){
    const date = parseDate(row["date"]);
    if(!date) continue;
    const project = row["project"] || "Untitled";
    const platform = row["platform"] || "Unknown";
    const title = row["title"] || "";
    const ct = row["content_type"] || "";
    const likes = +(row["likes_daily"] || 0);
    const comments = +(row["comments_daily"] || 0);
    // choose views_daily or fall back to aliases / views_cum
    let vd = row["views_daily"]; 
    if(vd === "" || vd == null) vd = row["views"] ?? row["view_count"] ?? row["plays"];
    let viewsDaily = vd !== undefined && vd !== "" ? +vd : null;
    let viewsCum = row["views_cum"] ? +row["views_cum"] : null;

    out.push({
      dateISO: date.toISOString().slice(0,10),
      date,
      project, platform, title, content_type: ct,
      views_daily: viewsDaily,
      views_cum: viewsCum,
      likes_daily: likes, comments_daily: comments,
      platform_color: row["platform_color"] || "",
      project_color: row["project_color"] || ""
    });
  }
  return out.sort((a,b)=> +a.date - +b.date);
}

function computeDailyFromCum(list){
  // per (project, platform, title)
  const key = r => `${r.project}__${r.platform}__${r.title}`;
  const groups = new Map();
  for(const r of list){
    const k=key(r);
    if(!groups.has(k)) groups.set(k,[]);
    groups.get(k).push(r);
  }
  for(const arr of groups.values()){
    arr.sort((a,b)=>+a.date - +b.date);
    let prev = null;
    for(const r of arr){
      if(r.views_daily==null && r.views_cum!=null){
        const base = prev?.views_cum ?? 0;
        r.views_daily = Math.max(0, (r.views_cum - base));
      }
      prev = r;
    }
  }
  return list;
}

function buildPlatformColors(rows){
  const map = {};
  const palette = ["#22c55e","#8b5cf6","#06b6d4","#f59e0b","#ef4444","#3b82f6","#e879f9","#10b981","#f97316"];
  let pi=0;
  for(const r of rows){
    const p = r.platform;
    const pick = r.platform_color || r.project_color || map[p] || palette[pi%palette.length];
    if(!map[p]) { map[p]=pick; pi++; }
  }
  return map;
}

function computeAggregations(rows, project, mode, range){
  // Filter to project & date range
  const minDate = (()=>{
    if(range==="all") return null;
    const d = new Date(rows.at(-1)?.date || Date.now());
    const n = range==="90" ? 90 : 30;
    d.setDate(d.getDate() - n + 1);
    return d;
  })();

  const filtered = rows.filter(r => r.project===project && (!minDate || r.date >= minDate));

  // Build date axis (fill gaps)
  const days = new Map(); // dateISO -> {platform -> value}
  const setVal = (d,p,v)=> {
    if(!days.has(d)) days.set(d,{});
    days.get(d)[p] = (days.get(d)[p] || 0) + v;
  }

  // per platform per day values
  const platforms = new Set();
  for(const r of filtered){
    platforms.add(r.platform);
    const val = mode==="daily" ? (r.views_daily ?? 0) : (r.views_cum ?? 0);
    setVal(r.dateISO, r.platform, Math.max(0, +val || 0));
  }

  // only use dates that actually exist in CSV
  const x = Array.from(new Set(filtered.map(r => r.dateISO))).sort();

  const series = Array.from(platforms).map(p => ({
    name: p,
    type: 'line',
    smooth: true,
    showSymbol: true,
    symbolSize: 6,
    data: x.map(d => days.get(d)[p] ?? 0),
    lineStyle: { width: 2 },
    itemStyle: { color: STATE.colors[p] || '#8b5cf6' }
  }));

  // KPIs
  const totalViews = filtered.reduce((s,r) => s + (r.views_daily ?? 0), 0);
  const totalLikes = filtered.reduce((s,r) => s + (r.likes_daily ?? 0), 0);
  const totalComments = filtered.reduce((s,r) => s + (r.comments_daily ?? 0), 0);
  const avgPerUpload = (()=>{
    const items = new Set(filtered.map(r => r.title + "::" + r.platform));
    const count = items.size || 1;
    return Math.round(totalViews / count);
  })();

  return { x, series, platforms: Array.from(platforms), kpis:{ totalViews, totalLikes, totalComments, avgPerUpload } };
}

/* ---- Chart render ---- */
function ensureChart(){
  if(STATE.echarts) return STATE.echarts;
  STATE.echarts = echarts.init(document.getElementById('chart'));
  return STATE.echarts;
}
function renderChart(title, x, series){
  const chart = ensureChart();
  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger:'axis', axisPointer:{type:'line'}, formatter:(params)=>{
      const date = params?.[0]?.axisValueLabel || '';
      const lines = params.map(p => `<div style="display:flex;justify-content:space-between;gap:12px"><span>● ${p.seriesName}</span><b>${p.value.toLocaleString()}</b></div>`);
      const total = params.reduce((s,p)=>s+(+p.value||0),0);
      return `<div style="padding:6px 2px"><div style="margin-bottom:6px"><b>${date}</b></div>${lines.join("")}<hr style="border:none;border-top:1px solid #2a2f3d;margin:6px 0"/><div style="display:flex;justify-content:space-between"><span>Total</span><b>${total.toLocaleString()}</b></div></div>`;
    }},
    legend: { top: 0, textStyle:{color:'#aab2c5'} },
    grid: { left: 40, right: 20, top: 40, bottom: 40 },
    xAxis: { type:'category', data: x, boundaryGap:false, axisLine:{lineStyle:{color:'#2a2f3d'}}, axisLabel:{color:'#aab2c5'} },
    yAxis: { type:'value', min:0, splitLine:{lineStyle:{type:'dashed', color:'#2a2f3d'}}, axisLabel:{color:'#aab2c5'} },
    series
  });
}

/* ---- UI + events ---- */
function fillSelectors(projects, platforms){
  // Project
  els.project.innerHTML = projects.map(p => `<option value="${p}">${p}</option>`).join("");
  // Platform multi
  els.platform.innerHTML = platforms.map(p => `<option value="${p}" selected>${p}</option>`).join("");
}

function setKpis(k){
  els.kViews.textContent = k.totalViews.toLocaleString();
  els.kLikes.textContent = k.totalLikes.toLocaleString();
  els.kComments.textContent = k.totalComments.toLocaleString();
  els.kAvg.textContent = k.avgPerUpload.toLocaleString();
}

function exportCurrentCSV(){
  const proj = els.project.value;
  const rows = STATE.dataset.filter(r => r.project===proj);
  const headers = ["date","project","platform","content_type","title","views_daily","views_cum","likes_daily","comments_daily","platform_color","project_color"];
  const csv = [headers.join(",")].concat(
    rows.map(r=>[
      r.dateISO,r.project,r.platform,r.content_type,r.title,
      r.views_daily ?? "", r.views_cum ?? "", r.likes_daily ?? "", r.comments_daily ?? "",
      r.platform_color ?? "", r.project_color ?? ""
    ].join(","))
  ).join("\r\n");
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${proj}_export.csv`;
  a.click();
}

function recomputeAndRender(){
  const project = els.project.value || STATE.projects[0];
  const selectedPlats = Array.from(els.platform.selectedOptions).map(o=>o.value);
  const range = els.range.value;

  const mode = document.querySelector('.seg-btn.seg-active')?.dataset.mode || 'daily';
  STATE.mode = mode;

  const { x, series, platforms, kpis } = computeAggregations(STATE.dataset, project, mode, range);

  // Filter series by selected platforms
  const filteredSeries = series.filter(s => selectedPlats.includes(s.name))
    .map(s => ({...s, itemStyle:{color: STATE.colors[s.name] || s.itemStyle.color}, lineStyle:{width:2}}));

  setKpis(kpis);
  els.title.textContent = `${project} - Platform Performance`;
  fillSelectors(STATE.projects, platforms); // refresh list (keeps selected)
  // re-apply selected platforms
  for(const opt of els.platform.options){ opt.selected = selectedPlats.includes(opt.value); }

  renderChart(project, x, filteredSeries);
}

/* ---- CSV upload handling ---- */
async function handleCSV(file){
  const text = await file.text();
  const parsed = parseCSV(text);
  const headers = normalizeHeaders(parsed.headers);
  const rows = normalizeRows(headers, parsed.rows);
  const rows2 = computeDailyFromCum(rows);
  STATE.colors = buildPlatformColors(rows2);
  STATE.dataset = rows2;
  STATE.projects = Array.from(new Set(rows2.map(r=>r.project)));
  els.versionTag.textContent = `v1.0 • Last Import: ${new Date().toISOString().slice(0,10)}`;
  saveCache({ headers, rows: rows2 });
  // initialize selectors then render
  fillSelectors(STATE.projects, Array.from(new Set(rows2.filter(r=>r.project===STATE.projects[0]).map(r=>r.platform))));
  recomputeAndRender();
}

function resetData(){
  localStorage.removeItem(CACHE_KEY);
  STATE = { mode:'daily', dataset:[], colors:{}, projects:[], platforms:[], series:[], x:[], echarts:STATE.echarts };
  document.getElementById('chart').innerHTML = "";
  els.kViews.textContent = els.kLikes.textContent = els.kComments.textContent = els.kAvg.textContent = "-";
  els.project.innerHTML = els.platform.innerHTML = "";
}

/* ---- Event wiring ---- */
// --- local data.csv ---
fetch(`data2.csv?cb=${Date.now()}`, { cache: "no-store" })
  .then(res => res.text())
  .then(text => handleCSV(new File([text], "data2.csv")))
  .catch(err => console.error("无法加载 data2.csv:", err));
els.project.addEventListener('change', recomputeAndRender);
els.platform.addEventListener('change', recomputeAndRender);
els.range.addEventListener('change', recomputeAndRender);
els.btnDaily.addEventListener('click', ()=>{ els.btnDaily.classList.add('seg-active'); els.btnCum.classList.remove('seg-active'); recomputeAndRender(); });
els.btnCum.addEventListener('click', ()=>{ els.btnCum.classList.add('seg-active'); els.btnDaily.classList.remove('seg-active'); recomputeAndRender(); });
els.btnExport.addEventListener('click', exportCurrentCSV);

/* ---- Boot: load cache if present ---- */
(function boot(){
  const cache = loadCache();
  if(cache?.rows?.length){
    STATE.dataset = cache.rows.map(r => ({...r, date: new Date(r.dateISO)}));
    STATE.colors = buildPlatformColors(STATE.dataset);
    STATE.projects = Array.from(new Set(STATE.dataset.map(r=>r.project)));
    fillSelectors(STATE.projects, Array.from(new Set(STATE.dataset.filter(r=>r.project===STATE.projects[0]).map(r=>r.platform))));
    recomputeAndRender();
    els.versionTag.textContent = `v1.0 • Cached`;
  }
})();