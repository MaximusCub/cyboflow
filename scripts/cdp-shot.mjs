// Throwaway smoke helper: capture a renderer screenshot over CDP.
// Usage: node scripts/cdp-shot.mjs <port> <outfile.png>
const [port, out] = process.argv.slice(2);
const targets = await (await fetch(`http://localhost:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, {once:true}); ws.addEventListener('error', rej, {once:true}); });
const data = await new Promise((resolve, reject) => {
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data.toString()); if (m.id === 1) m.error ? reject(new Error(e.data)) : resolve(m.result.data); });
  ws.send(JSON.stringify({id:1, method:'Page.captureScreenshot', params:{format:'png'}}));
});
const { writeFileSync } = await import('node:fs');
writeFileSync(out, Buffer.from(data, 'base64'));
console.log('saved', out);
ws.close();
