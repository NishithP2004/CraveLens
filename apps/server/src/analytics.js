import { langfuseSummary } from "./admin-langfuse.js";
import crypto from "node:crypto";
import { config } from "./config.js";
let db;
let dropped = 0;
let writesEnabled = true;
const retentionDays = 90;
const identity = (id) => crypto.createHmac("sha256", config.deviceSessionSigningKey).update(String(id)).digest("hex");
export async function initializeAnalytics(database, {readOnly = false} = {}) {
  db = database;
  writesEnabled = !readOnly;
  if (readOnly) return;
  await Promise.all([
    db.collection("analytics_events").createIndex({at: 1}, {expireAfterSeconds: retentionDays * 86400}),
    db.collection("analytics_events").createIndex({kind: 1, at: 1}),
    db.collection("analytics_users").createIndex({lastSeen: 1}),
    db.collection("analytics_orders").createIndex({at: 1}),
  ]);
  await db.collection("analytics_settings").updateOne({_id: "coverage"}, {$setOnInsert: {startedAt: new Date()}}, {upsert: true});
}
async function safely(operation) {
  if (!db || !writesEnabled) return;
  try { await operation(); } catch { dropped++; console.warn("[analytics] write failed; business execution continues"); }
}
export async function recordDevice(deviceId, registered = false) {
  if (!config.deviceSessionSigningKey) return;
  return safely(() => db.collection("analytics_users").updateOne({_id: identity(deviceId)}, {$set: {lastSeen: new Date(), ...(registered ? {registered: true} : {})}, $setOnInsert: {firstSeen: new Date()}}, {upsert: true}));
}
export async function recordConfirmedOrder(thread) {
  if (thread?.status !== "ordered" || !thread.threadId) return;
  return safely(() => db.collection("analytics_orders").updateOne({_id: thread.threadId}, {$setOnInsert: {at: new Date(), paymentMethod: ["COD", "UPI", "SWIGGYPAY"].includes(thread.paymentMethod) ? thread.paymentMethod : "unknown", amount: Math.max(0, Number(thread.suggestion?.finalAmount) || 0)}}, {upsert: true}));
}
export async function recordEvent(event) {
  return safely(() => db.collection("analytics_events").updateOne({_id: event.id || crypto.randomUUID()}, {$setOnInsert: {...event, id: undefined, at: new Date()}}, {upsert: true}));
}
export async function adminSummary(days = 30) {
  if (!db) throw Object.assign(new Error("Analytics requires MongoDB; no persistent analytics store is connected."), {statusCode: 503});
  const since = new Date(Date.now() - days * 86400000);
  const events = db.collection("analytics_events");
  const group = (match, spec, limit = 20) => events.aggregate([{$match: {at: {$gte: since}, ...match}}, {$group: spec}, {$sort: {count: -1}}, {$limit: limit}]).toArray();
  const [langfuse, users, activeUsers, registrations, orderTotals, allOrders, failures, dishes, coverage, cartOutcomes] = await Promise.all([
    langfuseSummary(days), db.collection("analytics_users").countDocuments({}), db.collection("analytics_users").countDocuments({lastSeen: {$gte: since}}), db.collection("analytics_users").countDocuments({registered: true, firstSeen: {$gte: since}}),
    db.collection("analytics_orders").aggregate([{$match: {at: {$gte: since}}}, {$group: {_id: null, count: {$sum: 1}, amount: {$sum: "$amount"}}}]).toArray(), db.collection("analytics_orders").countDocuments({}),
    group({kind: "server_failure"}, {_id: {kind: "$kind", code: "$code"}, count: {$sum: 1}}),
    events.aggregate([{$match: {kind: "detection", at: {$gte: since}}}, {$unwind: "$dishes"}, {$group: {_id: "$dishes", count: {$sum: 1}}}, {$sort: {count: -1}}, {$limit: 50}]).toArray(),
    db.collection("analytics_settings").findOne({_id: "coverage"}), group({kind: "cart"}, {_id: "$outcome", count: {$sum: 1}}),
  ]);
  return {generatedAt: new Date(), days, coverageStartedAt: coverage?.startedAt, retentionDays, users, activeUsers, registrations, orders: orderTotals[0]?.count || 0, orderValue: orderTotals[0]?.amount || 0, allOrders, models: langfuse.models, modes: langfuse.modes, failures: [...langfuse.failures, ...failures], dishes, daily: langfuse.daily, hybrid: langfuse.hybrid, hybridCalls: langfuse.hybridCalls, workflows: langfuse.workflows, langfuse: langfuse.status, cartOutcomes, droppedWritesSinceRestart: dropped, definitions: {users: "Observed extension registrations/devices, not unique people; reinstalling creates a new registration.", hybrid: "Langfuse traces with both local and hosted LLM attempts. Hybrid calls count hosted generations in those traces; local vision plus hosted planning alone is not hybrid.", orders: "Unique cart conversations recorded as ordered after provider confirmation; pending or uncertain payments are excluded.", coverage: "Database counters begin with instrumentation. Older expired records are not backfilled. Dish counts cover structured detections submitted for cart preparation, not browser-only scans or unique meals. Langfuse counts follow project retention and the selected environment."}};
}
