import { MongoClient } from "mongodb";
import { config } from "./config.js";

const memory = { videos: new Map(), threads: new Map() };
let videos;
let threads;

export async function connectStore() {
  if (!config.mongoUri) return { mode: "memory" };
  const client = new MongoClient(config.mongoUri);
  await client.connect();
  const db = client.db(config.mongoDatabase);
  videos = db.collection("video_cache");
  threads = db.collection("orchestration_threads");
  await Promise.all([
    videos.createIndex({ videoId: 1 }, { unique: true }),
    threads.createIndex({ threadId: 1 }, { unique: true }),
    threads.createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 }),
  ]);
  return { mode: "mongodb" };
}

export async function getVideo(videoId) {
  return videos ? videos.findOne({ videoId }, { projection: { _id: 0 } }) : memory.videos.get(videoId) || null;
}

export async function saveDetection(videoId, detection) {
  const current = await getVideo(videoId);
  const match = current?.detections.find((d) => d.itemLabel === detection.itemLabel && Math.abs(d.startTime - detection.startTime) <= 5);
  if (videos) {
    if (match) await videos.updateOne({ videoId }, { $inc: { verificationCount: 1 }, $set: { lastUpdated: new Date() } });
    else await videos.updateOne({ videoId }, { $push: { detections: detection }, $set: { lastUpdated: new Date() }, $setOnInsert: { verificationCount: 1 } }, { upsert: true });
    return;
  }
  memory.videos.set(videoId, match
    ? { ...current, verificationCount: current.verificationCount + 1, lastUpdated: new Date() }
    : { videoId, detections: [...(current?.detections || []), detection], verificationCount: current?.verificationCount || 1, lastUpdated: new Date() });
}

export async function saveThread(doc) {
  if (threads) await threads.insertOne(doc); else memory.threads.set(doc.threadId, doc);
}

export async function updateThread(threadId, status) {
  if (threads) return threads.findOneAndUpdate({ threadId }, { $set: { status } }, { returnDocument: "after" });
  const doc = memory.threads.get(threadId);
  if (!doc) return null;
  const updated = { ...doc, status };
  memory.threads.set(threadId, updated);
  return updated;
}
