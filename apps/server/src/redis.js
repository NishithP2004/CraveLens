import { createClient } from "redis";
import { config } from "./config.js";

let client;
let subscriber;

function makeClient() {
  const instance = createClient({ url: config.redisUrl });
  instance.on("error", (error) => console.error("[redis]", error.message));
  return instance;
}

export async function connectRedis() {
  if (!client) client = makeClient();
  if (!client.isOpen) await client.connect();
  return client;
}

export async function getRedis() {
  return connectRedis();
}

export async function duplicateRedis() {
  await connectRedis();
  if (!subscriber) {
    subscriber = client.duplicate();
    subscriber.on("error", (error) => console.error("[redis:subscriber]", error.message));
    await subscriber.connect();
  }
  return subscriber;
}

export async function createRedisDuplicate() {
  const root = await connectRedis();
  const duplicate = root.duplicate();
  duplicate.on("error", (error) => console.error("[redis:duplicate]", error.message));
  await duplicate.connect();
  return duplicate;
}

export async function closeRedis() {
  const operations = [];
  if (subscriber?.isOpen) operations.push(subscriber.quit());
  if (client?.isOpen) operations.push(client.quit());
  await Promise.allSettled(operations);
  client = undefined;
  subscriber = undefined;
}

export const redisKeys = {
  device: (deviceId) => `cravelens:device:${deviceId}`,
  refresh: (tokenHash) => `cravelens:refresh:${tokenHash}`,
  usedRefresh: (tokenHash) => `cravelens:refresh-used:${tokenHash}`,
  refreshFamily: (familyId) => `cravelens:refresh-family:${familyId}`,
  oauthState: (stateHash) => `cravelens:oauth-state:${stateHash}`,
  swiggyCredential: (deviceId) => `cravelens:swiggy:${deviceId}`,
  modelSettings: (deviceId) => `cravelens:model-settings:${deviceId}`,
  modelCredential: (deviceId, provider) => `cravelens:model-credential:${deviceId}:${provider}`,
  fallback: (deviceId, runId) => `cravelens:fallback:${deviceId}:${runId}`,
};
