export async function withCartProgress({ connect, disconnect, onUnavailable, prepare }) {
  try {
    try { await connect(); }
    catch (error) { disconnect(); onUnavailable?.(error); }
    return await prepare();
  } finally { disconnect(); }
}

export function cartPreparationNotice(result) {
  if (result?.detected === true && result.suggestion) return undefined;
  if (result?.paused) return { title: "Cart preparation paused", message: result.message || "Another cart is being prepared or awaiting review. Review or reject that cart before preparing another." };
  return { title: "No cart prepared", message: result?.message || "The cart service returned no prepared cart. Try scanning again; your food identification was successful." };
}
