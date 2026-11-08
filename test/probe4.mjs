import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox","--disable-dev-shm-usage","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"],
  defaultViewport: { width: 900, height: 600 } });
const p = await b.newPage();
await p.goto("http://localhost:8099/index.html?seed=7&fresh=1", { waitUntil: "load" });
await new Promise((r) => setTimeout(r, 2500));
console.log(JSON.stringify(await p.evaluate(() => {
  const v = window.__realms.view;
  const n = v.terrain.geometry.getAttribute("normal");
  let up = 0, down = 0;
  for (let i = 0; i < n.count; i += 6) {
    const ny = n.getY(i);
    if (ny > 0) up++; else down++;
  }
  return { chunks: v.cw * v.ch, upFacing: up, downFacing: down, sampleNormals: [n.getX(0), n.getY(0), n.getZ(0)].map((x) => +x.toFixed(2)) };
})));
await b.close();
