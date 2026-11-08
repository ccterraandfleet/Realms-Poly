import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox","--disable-dev-shm-usage","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"],
  defaultViewport: { width: 1200, height: 800 } });
const p = await b.newPage();
await p.goto("http://localhost:8099/index.html?seed=7&fresh=1", { waitUntil: "load" });
await new Promise((r) => setTimeout(r, 3000));
const counts = await p.evaluate(() => {
  const v = window.__realms.view;
  // hide only the sea plane
  v.scene.traverse((o) => { if (o.isMesh && o.geometry.type === "PlaneGeometry") o.visible = false; });
  // count chunk colours straight off the geometry
  const col = v.terrain.geometry.getAttribute("color");
  const ocean = [47 / 255, 134 / 255, 176 / 255];
  let bluish = 0, chunks = v.cw * v.ch;
  for (let i = 0; i < col.count; i += 6) {
    const r = col.getX(i) * 255, g = col.getY(i) * 255, b2 = col.getZ(i) * 255;
    if (b2 > g + 20 && b2 > r + 40) bluish++;
  }
  return { chunks, oceanBlueChunks: bluish, pct: Math.round((100 * bluish) / chunks), firstColour: [col.getX(0), col.getY(0), col.getZ(0)].map((n) => +n.toFixed(3)) };
});
await new Promise((r) => setTimeout(r, 700));
await p.screenshot({ path: "probe_noapron2.png" });
console.log(JSON.stringify(counts));
await b.close();
