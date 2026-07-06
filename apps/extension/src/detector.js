export function frameFeatures(imageData) {
  const bins = new Array(24).fill(0);
  let sharpness = 0;
  const d = imageData.data;
  for (let i = 0; i < d.length - 8; i += 16) {
    bins[Math.min(7, d[i] >> 5)]++;
    bins[8 + Math.min(7, d[i + 1] >> 5)]++;
    bins[16 + Math.min(7, d[i + 2] >> 5)]++;
    sharpness += Math.abs(d[i] - d[i + 4]) + Math.abs(d[i + 1] - d[i + 5]) + Math.abs(d[i + 2] - d[i + 6]);
  }
  const total = bins.reduce((a, b) => a + b, 0);
  return { histogram: bins.map((x) => x / total), sharpness };
}

export function selectKeyframe(frames) {
  const distance = (a, b) => a.histogram.reduce((sum, x, i) => sum + Math.abs(x - b.histogram[i]), 0);
  return frames.map((frame) => ({ ...frame, density: frames.filter((other) => distance(frame, other) < .11).length }))
    .sort((a, b) => b.density - a.density || b.sharpness - a.sharpness)[0];
}
