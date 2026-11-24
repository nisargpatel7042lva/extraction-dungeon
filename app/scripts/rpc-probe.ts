// Compares devnet base-layer RPC endpoints: latency, burst tolerance (429s), and websocket support.
export {};
const urls: Record<string, string> = {
  "solana public": "https://api.devnet.solana.com",
  "magicblock": "https://rpc.magicblock.app/devnet",
};
const body = (method: string, params: unknown[] = []) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
for (const [name, url] of Object.entries(urls)) {
  const t: number[] = [];
  let limited = 0, failed = 0;
  // A burst of 40 requests, roughly what a few busy clients produce.
  await Promise.all(
    Array.from({ length: 40 }, async () => {
      const s = performance.now();
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body("getLatestBlockhash") });
        if (r.status === 429) limited++;
        else if (!r.ok) failed++;
        else t.push(performance.now() - s);
      } catch {
        failed++;
      }
    }),
  );
  t.sort((a, b) => a - b);
  const ws = await new Promise<string>((res) => {
    const w = new WebSocket(url.replace(/^http/, "ws"));
    const to = setTimeout(() => { w.close(); res("timeout"); }, 6000);
    w.onopen = () => {
      w.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "slotSubscribe" }));
    };
    w.onmessage = (m) => { clearTimeout(to); w.close(); res(String(m.data).includes("result") ? "ok" : "msg"); };
    w.onerror = () => { clearTimeout(to); res("error"); };
  });
  console.log(`${name.padEnd(14)} ok ${t.length}/40  429s ${limited}  errors ${failed}  p50 ${t[t.length >> 1]?.toFixed(0)}ms  ws ${ws}`);
}
