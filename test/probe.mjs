import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox","--disable-dev-shm-usage","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"],
  defaultViewport: { width: 1200, height: 800 } });
const p = await b.newPage();
await p.goto("http://localhost:8099/index.html?seed=7&fresh=1", { waitUntil: "load" });
await new Promise((r) => setTimeout(r, 3000));
// what does the simulation say is under these points?
const probe = await p.evaluate(() => {
  const R = window.__realms;
  const pts = [[900, 200], [1000, 300], [300, 700], [600, 600]];
  return pts.map(([sx, sy]) => {
    const t = R.view.tileAtScreen(sx, sy);
    return { sx, sy, tile: t, terrain: t >= 0 ? R.game.world.terrain[t] : -9 };
  });
});
await p.screenshot({ path: "probe_before.png" });
// turn off the apron and the drape: if the blue vanishes, the terrain has holes
await p.evaluate(() => {
  const v = window.__realms.view;
  v.scene.traverse((o) => {
    if (o.isMesh && o.geometry.type === "PlaneGeometry") o.visible = false;
    if (o.isMesh && o.material && o.material.map && o.material.transparent) o.visible = false;
  });
});
await new Promise((r) => setTimeout(r, 700));
await p.screenshot({ path: "probe_noapron.png" });
console.log(JSON.stringify(probe));
await b.close();
