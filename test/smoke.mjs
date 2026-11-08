import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox","--disable-dev-shm-usage","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"],
  defaultViewport: { width: 1440, height: 900 },
});
const p = await b.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(String(e.message).slice(0, 220)));
p.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 160)); });
await p.goto("http://localhost:8099/index.html", { waitUntil: "load" });
await new Promise((r) => setTimeout(r, 2500));
const info = await p.evaluate(() => {
  const R = window.__realms;
  if (!R) return { boot: false };
  const g = R.game;
  return {
    boot: true,
    cities: g.state.cities.length,
    owners: g.livingOwners().length,
    hosts: g.state.hosts.length,
    season: +g.season().toFixed(2),
    stats: g.stats(0),
    seed: g.world.seed,
    tris: R.view.renderer.info.render.triangles,
    siteCoords: g.world.citySites.slice(0, 3).map((s) => [s.tile % g.world.w, (s.tile / g.world.w) | 0]),
  };
});
await new Promise((r) => setTimeout(r, 1500));
await p.screenshot({ path: "shot_boot.png" });
const after = await p.evaluate(() => {
  const g = window.__realms.game;
  for (let i = 0; i < 900; i++) g.tick(0.1);
  return { time: Math.round(g.state.time), hosts: g.state.hosts.length, convoys: g.state.convoys.length, log: g.state.log.slice(0, 4), stats: g.stats(0) };
});
await new Promise((r) => setTimeout(r, 800));
await p.screenshot({ path: "shot_played.png" });
console.log(JSON.stringify({ info, after, errs }, null, 1));
await b.close();
