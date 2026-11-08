/**
 * Realms, new build. World generation.
 *
 * One continent rather than an archipelago: the reference frame Mason picked is a
 * continuous landmass with forest, ridges, riverside flat and a few inland seas,
 * so the land has to be the default and the water the exception.
 *
 * Everything here is a pure function of the seed. No state, no DOM, no three.js:
 * the renderer and the simulation both read the same arrays, which is why they
 * cannot disagree about where a mountain is.
 */

export const OCEAN = 0;
export const PLAINS = 1;
export const FOREST = 2;
export const MOUNTAIN = 3;
export const SAND = 4;

export type Terrain = 0 | 1 | 2 | 3 | 4;

export interface CitySite {
  id: number;
  tile: number;
  name: string;
  capital: boolean;
}

export interface World {
  seed: number;
  w: number;
  h: number;
  terrain: Uint8Array;
  /** Per-tile yield multiplier: the ground worth fighting for. */
  richness: Float32Array;
  /** 1 where a road runs. Roads are where armies and grain move. */
  road: Uint8Array;
  /** Every road vertex in tile order, for drawing and for pathing seeds. */
  citySites: CitySite[];
  /** Neighbour list of the city graph, used to keep roads meaningful. */
  cityEdges: [number, number][];
}

function hash(x: number, y: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + seed * 2246822519;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function noise(x: number, y: number, scale: number, seed: number): number {
  const gx = x / scale;
  const gy = y / scale;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const tx = gx - x0;
  const ty = gy - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash(x0, y0, seed);
  const b = hash(x0 + 1, y0, seed);
  const c = hash(x0, y0 + 1, seed);
  const d = hash(x0 + 1, y0 + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

const NAMES = [
  "Eldwold", "Wynbeck", "Fengarth", "Marrow", "Hollowmere", "Grayfen", "Rook's Rest",
  "Thornby", "Ashcombe", "Duncairn", "Brackwater", "Saltgate", "Oakhurst", "Wyrmwood",
  "Ferrow", "Bellholt", "Cragmoor", "Wilding", "Dunmar", "Sablewick",
];

export function generateWorld(seed: number, w = 260, h = 180, seaLevel = 0.24): World {
  const terrain = new Uint8Array(w * h);
  const richness = new Float32Array(w * h);
  const road = new Uint8Array(w * h);
  const cx = w / 2;
  const cy = h / 2;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = y * w + x;
      // Broad landform, then a coastline mask so the continent has ragged edges
      // instead of the smooth ellipse that made the old map look printed.
      const base = noise(x, y, 46, seed) * 0.55 + noise(x, y, 21, seed) * 0.3 + noise(x, y, 9, seed) * 0.15;
      const dx = (x - cx) / (w * 0.42);
      const dy = (y - cy) / (h * 0.42);
      const falloff = 1 - Math.min(1.35, Math.sqrt(dx * dx + dy * dy));
      const land = base * 0.55 + falloff * 0.75;
      if (land < seaLevel) {
        terrain[t] = OCEAN;
        richness[t] = 0;
        continue;
      }
      const moist = noise(x, y, 27, seed + 91);
      const elev = noise(x, y, 17, seed + 17) * 0.7 + noise(x, y, 6, seed + 41) * 0.3;
      if (elev > 0.62 && land > 0.45) terrain[t] = MOUNTAIN;
      else if (land < seaLevel + 0.05) terrain[t] = SAND;
      else if (moist > 0.52) terrain[t] = FOREST;
      else terrain[t] = PLAINS;
      // The middle of the continent is the prize: rich ground, worth a campaign.
      const centrePull = 1 - Math.min(1, Math.sqrt(
        Math.pow((x - cx) / (w * 0.3), 2) + Math.pow((y - cy) / (h * 0.3), 2),
      ));
      richness[t] =
        (0.8 + noise(x, y, 13, seed + 7) * 0.9) * (0.85 + centrePull * 1.6) *
        (terrain[t] === MOUNTAIN ? 0.45 : 1);
    }
  }

  // City sites: spread over the land, never in the sea, never stacked.
  const sites: CitySite[] = [];
  const wantSites = 18;
  const minGap = 20;
  const candidates: { t: number; score: number }[] = [];
  for (let t = 0; t < w * h; t++) {
    if (terrain[t] === OCEAN || terrain[t] === MOUNTAIN) continue;
    const x = t % w;
    const y = (t / w) | 0;
    if (x < 6 || y < 6 || x > w - 7 || y > h - 7) continue;
    candidates.push({ t, score: richness[t] + hash(x, y, seed + 5) * 0.35 });
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    if (sites.length >= wantSites) break;
    const x = c.t % w;
    const y = (c.t / w) | 0;
    let ok = true;
    for (const s of sites) {
      const sx = s.tile % w;
      const sy = (s.tile / w) | 0;
      if (Math.hypot(sx - x, sy - y) < minGap) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    sites.push({
      id: sites.length,
      tile: c.t,
      name: NAMES[sites.length % NAMES.length],
      capital: sites.length < 7,
    });
  }

  // Roads: connect each site to its two nearest neighbours, then rasterise an
  // A* land path. Hosts and grain both travel these, so a cut road is a real cut.
  const edges: [number, number][] = [];
  const seen = new Set<string>();
  const addEdge = (a: number, b: number) => {
    if (a === b) return;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push([a, b]);
  };
  for (const s of sites) {
    const sx = s.tile % w;
    const sy = (s.tile / w) | 0;
    const near = sites
      .filter((o) => o.id !== s.id)
      .map((o) => ({
        id: o.id,
        d: Math.hypot((o.tile % w) - sx, ((o.tile / w) | 0) - sy),
      }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 2);
    for (const n of near) addEdge(s.id, n.id);
  }
  for (const [a, b] of edges) {
    const path = findPath(terrain, w, h, sites[a].tile, sites[b].tile);
    if (!path) continue;
    for (const t of path) road[t] = 1;
  }

  return { seed, w, h, terrain, richness, road, citySites: sites, cityEdges: edges };
}

/** A* over land: mountains and forest cost more, water is impassable. */
export function findPath(
  terrain: Uint8Array,
  w: number,
  h: number,
  from: number,
  to: number,
  maxNodes = 24000,
): number[] | null {
  if (from === to) return [from];
  const open: number[] = [from];
  const cost = new Map<number, number>([[from, 0]]);
  const came = new Map<number, number>();
  const seen = new Set<number>();
  const tx = to % w;
  const tz = (to / w) | 0;
  const heur = (t: number) => Math.abs((t % w) - tx) + Math.abs(((t / w) | 0) - tz);
  let guard = 0;
  while (open.length && guard++ < maxNodes) {
    let bestIdx = 0;
    let bestF = Infinity;
    for (let i = 0; i < open.length; i++) {
      const f = (cost.get(open[i]) ?? Infinity) + heur(open[i]);
      if (f < bestF) {
        bestF = f;
        bestIdx = i;
      }
    }
    const cur = open.splice(bestIdx, 1)[0];
    if (cur === to) {
      const path = [cur];
      let c = cur;
      while (came.has(c)) {
        c = came.get(c)!;
        path.push(c);
      }
      return path.reverse();
    }
    seen.add(cur);
    const x = cur % w;
    const z = (cur / w) | 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
      const n = nz * w + nx;
      if (seen.has(n)) continue;
      const kind = terrain[n];
      if (kind === OCEAN) continue;
      const step = kind === MOUNTAIN ? 9 : kind === FOREST ? 2.2 : 1;
      const nc = (cost.get(cur) ?? 0) + step;
      if (nc < (cost.get(n) ?? Infinity)) {
        cost.set(n, nc);
        came.set(n, cur);
        if (!open.includes(n)) open.push(n);
      }
    }
  }
  return null;
}

export function isLand(terrain: Uint8Array, tile: number): boolean {
  return terrain[tile] !== OCEAN;
}
