import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox","--disable-dev-shm-usage","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"],
  defaultViewport: { width: 1200, height: 800 } });
const p = await b.newPage();
await p.goto("http://localhost:8099/index.html?seed=7&fresh=1", { waitUntil: "load" });
await new Promise((r) => setTimeout(r, 3000));
const info = await p.evaluate(() => {
  const v = window.__realms.view;
  const g = v.terrain.geometry;
  const pos = g.getAttribute("position").array;
  let nan = 0;
  for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i])) nan++;
  return {
    verts: pos.length / 3,
    nan,
    chunks: v.cw * v.ch,
    expect: v.cw * v.ch * 6,
    firstCorners: Array.from(v.corners.slice(0, 6)).map((n) => +n.toFixed(2)),
    heightRange: [Math.min(...v.corners).toFixed(2), Math.max(...v.corners).toFixed(2)],
  };
});
await p.evaluate(() => { window.__realms.view.terrain.material.side = 2; window.__realms.view.terrain.material.needsUpdate = true; });
await new Promise((r) => setTimeout(r, 800));
await p.screenshot({ path: "probe_double.png" });
console.log(JSON.stringify(info));
await b.close();
