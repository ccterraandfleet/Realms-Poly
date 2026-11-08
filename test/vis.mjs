import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox","--disable-dev-shm-usage","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"],
  defaultViewport: { width: 1200, height: 800 } });
const p = await b.newPage();
await p.goto("http://localhost:8099/index.html?seed=7&fresh=1", { waitUntil: "load" });
await new Promise((r) => setTimeout(r, 2500));
console.log(JSON.stringify(await p.evaluate(() => {
  const R = window.__realms, g = R.game, cam = R.cam, W = g.world.w, H = g.world.h;
  const halfW = innerWidth / 2 / cam.scale;
  const halfH = (innerHeight / 2 / cam.scale) * Math.cos(0.5);
  const cx = (innerWidth / 2 - cam.x) / cam.scale;
  const cz = (innerHeight / 2 - cam.y) / cam.scale;
  let ocean = 0, land = 0;
  for (let z = Math.floor(cz - halfH); z <= Math.ceil(cz + halfH); z++) {
    for (let x = Math.floor(cx - halfW); x <= Math.ceil(cx + halfW); x++) {
      if (x < 0 || z < 0 || x >= W || z >= H) { ocean++; continue; }
      if (g.world.terrain[z * W + x] === 0) ocean++; else land++;
    }
  }
  // Sample what the renderer actually put under three screen points.
  const samples = [[300, 400], [600, 400], [900, 400]].map(([sx, sy]) => {
    const t = R.view.tileAtScreen(sx, sy);
    return { sx, sy, tile: t, terrain: t >= 0 ? g.world.terrain[t] : -9 };
  });
  return {
    cam: { x: Math.round(cam.x), y: Math.round(cam.y), scale: cam.scale },
    view: { cx: Math.round(cx), cz: Math.round(cz), halfW: Math.round(halfW), halfH: Math.round(halfH) },
    oceanPctInView: Math.round(100 * ocean / (ocean + land)),
    centreTerrain: g.world.terrain[(Math.round(cz) * W + Math.round(cx))],
    samples,
  };
}), null, 1));
await b.close();
