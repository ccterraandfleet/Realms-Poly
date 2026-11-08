import { generateWorld, OCEAN, FOREST, MOUNTAIN } from "../src/sim/world";
for (const sea of [0.42, 0.38, 0.34, 0.30, 0.26, 0.22]) {
  let land = 0, forest = 0, mountain = 0, total = 0;
  for (const seed of [7, 21, 1337, 4242]) {
    const w = generateWorld(seed, 260, 180, sea);
    for (let i = 0; i < w.terrain.length; i++) {
      total++;
      if (w.terrain[i] !== OCEAN) land++;
      if (w.terrain[i] === FOREST) forest++;
      if (w.terrain[i] === MOUNTAIN) mountain++;
    }
  }
  console.log(`sea ${sea.toFixed(2)}  land ${(100 * land / total).toFixed(1)}%  forest ${(100 * forest / total).toFixed(1)}%  mountain ${(100 * mountain / total).toFixed(1)}%`);
}
