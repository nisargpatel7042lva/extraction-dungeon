// Round-trip latency to each MagicBlock devnet endpoint (getLatestBlockhash, 10 samples).
export {};
const urls = {
  asia: "https://devnet-as.magicblock.app",
  eu: "https://devnet-eu.magicblock.app",
  us: "https://devnet-us.magicblock.app",
  router: "https://devnet-router.magicblock.app",
};
for (const [name, url] of Object.entries(urls)) {
  const times: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t = performance.now();
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash" }),
      });
      await r.json();
      times.push(performance.now() - t);
    } catch {
      times.push(NaN);
    }
  }
  const ok = times.filter((x) => !isNaN(x)).sort((a, b) => a - b);
  console.log(`${name.padEnd(7)} p50 ${ok[ok.length >> 1]?.toFixed(0)}ms  min ${ok[0]?.toFixed(0)}ms  (${ok.length}/10 ok)`);
}
