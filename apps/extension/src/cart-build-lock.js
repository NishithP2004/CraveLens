export function createCartBuildLock() {
  const pending = new Set();

  return {
    claim(videoId, dishKey) {
      const key = `${String(videoId || "unknown")}:${String(dishKey || "food")}`;
      if (pending.has(key)) return null;
      pending.add(key);
      return key;
    },
    release(key) {
      if (key) pending.delete(key);
    },
    has(videoId, dishKey) {
      return pending.has(`${String(videoId || "unknown")}:${String(dishKey || "food")}`);
    },
  };
}
