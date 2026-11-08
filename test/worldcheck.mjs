import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox","--disable-dev-shm-usage","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"],
  defaultViewport: { width: 1200, height: 800 } });
const p = await b.newPage();
await p.goto("http://localhost:8099/index.html?fresh=1", { waitUntil: "load" });
await new Promise((r) => setTimeout(r, 2500));
console.log(JSON.stringify(await p.evaluate(() => {
  const g = window.__realms.game;
  const t = g.world.terrain;
  let land = 0, mountain = 0, forest = 0, road = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== 0) land++;
    if (t[i] === 3) mountain++;
    if (t[i] === 2) forest++;
    if (g.world.road[i]) road++;
  }
  const home = g.state.cities[0];
  return {
    landPct: +((100 * land) / t.length).toFixed(1),
    forestPct: +((100 * forest) / t.length).toFixed(1),
    mountainPct: +((100 * mountain) / t.length).toFixed(1),
    roadPct: +((100 * road) / t.length).toFixed(1),
    homeTile: home.tile, homeXY: [home.tile % g.world.w, (home.tile / g.world.w) | 0],
    camScale: +window.__realms.cam.scale.toFixed(1),
    worldWH: [g.world.w, g.world.h],
  };
}), null, 1));
await b.close();
