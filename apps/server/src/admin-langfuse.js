import "./config.js";
const cache = new Map();
const label = v => typeof v === "string" && /^[a-z0-9_.:/ -]{1,120}$/i.test(v) && !/Bearer|sk-|pk-/i.test(v) ? v : "unknown";
export function aggregateObservations(observations) {
  const traces = new Set(observations.filter(o => /^(cart\.|preferences\.|checkout\.|payment\.)/.test(o.name || "")).map(o => o.traceId));
  const rows = observations.filter(o => traces.has(o.traceId));
  const models = new Map(), modes = new Map(), origins = new Map(), failures = new Map(), daily = new Map();
  const generations = rows.filter(o => o.type === "GENERATION" && o.name !== "ApprovalFallbackChatModel");
  for (const row of rows) {
    const day = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date(row.startTime));
    daily.set(day, (daily.get(day) || 0) + 1);
    if (row.level === "ERROR" && (row.type === "GENERATION" || !row.parentObservationId)) {
      const kind = row.type === "GENERATION" ? "model" : "workflow_failure";
      const code = label(row.metadata?.errorCode || row.name);
      const key = `${kind}:${code}`;
      const failure = failures.get(key) || {_id: {kind, code}, count: 0}; failure.count++; failures.set(key, failure);
    }
  }
  for (const row of generations) {
    const metadata = row.metadata || {};
    const origin = ["local", "hosted"].includes(metadata.origin) ? metadata.origin : "unknown";
    const model = label(metadata.model || row.model), provider = label(metadata.provider);
    const key = `${provider}:${model}`;
    const entry = models.get(key) || {_id: {model, provider, kind: "model"}, count: 0, failed: 0, duration: 0, timed: 0};
    entry.count++; if (row.level === "ERROR") entry.failed++;
    const ms = Date.parse(row.endTime) - Date.parse(row.startTime);
    if (Number.isFinite(ms) && ms >= 0) {entry.duration += ms; entry.timed++;}
    models.set(key, entry); modes.set(origin, (modes.get(origin) || 0) + 1);
    const set = origins.get(row.traceId) || new Set(); set.add(origin); origins.set(row.traceId, set);
  }
  const hybridIds = new Set([...origins].filter(([,set]) => set.has("local") && set.has("hosted")).map(([id]) => id));
  return {models: [...models.values()].map(({duration, timed, ...row}) => ({...row, averageMs: timed ? duration/timed : null})).sort((a,b)=>b.count-a.count).slice(0,20), modes: [...modes].map(([_id,count])=>({_id,count})), failures: [...failures.values()].sort((a,b)=>b.count-a.count), daily: [...daily].map(([_id,count])=>({_id,count})).sort((a,b)=>a._id.localeCompare(b._id)), hybrid: hybridIds.size, hybridCalls: generations.filter(o=>hybridIds.has(o.traceId) && o.metadata?.origin === "hosted").length, workflows: origins.size};
}
export async function langfuseSummary(days, fetcher = fetch) {
  const empty = {models: [], modes: [], failures: [], daily: [], hybrid: null, hybridCalls: null, workflows: null};
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) return {...empty, status: {available: false, reason: "Langfuse is not configured"}};
  const environment = process.env.LANGFUSE_TRACING_ENVIRONMENT || "";
  const base = process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com";
  const cacheKey = `${base}:${environment}:${days}`;
  const previous = cache.get(cacheKey);
  if (previous && Date.now() - previous.at < 60000) return previous.value;
  const signal = AbortSignal.timeout(20000);
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const to = new Date().toISOString();
  const rows = [], seen = new Set();
  let cursor, partial = false;
  try {
    const auth = Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString("base64");
    let legacy = false;
    for (let page=0;page<(legacy ? 100 : 10);page++) {
      const url = new URL(legacy ? "/api/public/observations" : "/api/public/v2/observations", base);
      url.search = new URLSearchParams({...(legacy ? {page: String(page+1)} : {fields: "core,basic,time,metadata,model,trace_context", ...(cursor ? {cursor} : {})}), limit: legacy ? "100" : "1000", ...(environment ? {environment} : {}), fromStartTime: from, toStartTime: to}).toString();
      const response = await fetcher(url, {headers: {Authorization: `Basic ${auth}`}, signal});
      if (response.status === 404 && page === 0 && !legacy) {legacy = true; page = -1; continue;}
      if (!response.ok) throw Error(`Langfuse returned HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.data)) throw Error("Langfuse returned an invalid response");
      // Never retain or send legacy API input/output or arbitrary metadata to the UI.
      rows.push(...data.data.map(o => ({id:o.id, traceId:o.traceId, parentObservationId:o.parentObservationId, type:o.type, name:o.name, level:o.level, startTime:o.startTime, endTime:o.endTime, model:label(o.model), metadata:{origin:o.metadata?.origin, model:label(o.metadata?.model), provider:label(o.metadata?.provider), errorCode:label(o.metadata?.errorCode)}})));
      if (legacy) {
        if (data.meta?.totalPages ? page+1 >= data.meta.totalPages : data.data.length < 100) break;
        partial = page === 99;
      } else {
        cursor = data.meta?.cursor;
        if (!cursor) break;
        if (seen.has(cursor)) throw Error("Langfuse pagination did not advance");
        seen.add(cursor); partial = page === 9;
      }
    }
    const value = {...aggregateObservations(rows), status: {available: true, partial, observationsRead: rows.length, fetchedAt: new Date(), environment: environment || "all environments (not configured)", reason: partial ? "Partial sample: 10,000 observation limit reached. Counts are lower bounds." : null}};
    cache.set(cacheKey, {at: Date.now(), value});
    return value;
  } catch (error) { return {...empty, status: {available: false, reason: String(error.message || "").startsWith("Langfuse") ? error.message : "Langfuse query unavailable"}}; }
}
