// @ts-nocheck — three has no useful ambient types here; this is proven by running.
/**
 * Realms, new build. The poly view.
 *
 * Faceted land, tilted orthographic camera, chunky trees, toy keeps: the look
 * Mason picked out of the reference frame. It reads the simulation's arrays and
 * draws them; it never changes them.
 */

import * as THREE from "three";
import { FOREST, MOUNTAIN, OCEAN, PLAINS, SAND, World } from "../sim/world";
import { City, Convoy, Game, Host } from "../sim/game";

const TILT = 0.50;
const CAM_DIST = 300;
const CHUNK = 3;

const BIOME: Record<number, number[]> = {
  [OCEAN]: [0x2f86b0, 0x2a7aa3, 0x3894bf, 0x24709a],
  [SAND]: [0xe8d29b, 0xddc58c, 0xf2e0ae],
  [PLAINS]: [0x82ba52, 0x8fc95f, 0x75ab48, 0x9bd36a],
  [FOREST]: [0x3f8f46, 0x4b9e51, 0x357d3d, 0x58ae5e],
  [MOUNTAIN]: [0x9b948c, 0xa9a29a, 0x8b847d, 0xbab2a7],
};
const ROAD_TONES = [0xb59a6e, 0xa88c62, 0xc2a97b];
const TREE_GREENS = [0x35873c, 0x3f9a45, 0x2c7434, 0x4aa84f];
const STONE = 0xcfc7b4;
const STONE_DARK = 0xa8a08e;

function hash(x: number, y: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + seed * 2246822519;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, scale: number, seed: number): number {
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

export class PolyView {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  cam: THREE.OrthographicCamera;
  sun: THREE.DirectionalLight;
  canvas: HTMLCanvasElement;
  terrain: THREE.Mesh | null = null;
  drape: THREE.Mesh | null = null;
  drapeTex: THREE.DataTexture | null = null;
  trees: any = null;
  rocks: any = null;
  men: any = null;
  banners: any = null;
  carts: any = null;
  hoverRing: THREE.Mesh;
  selectRing: THREE.Mesh;
  keeps = new Map<number, THREE.Object3D>();
  heights: Float32Array;
  corners: Float32Array;
  cw = 0;
  ch = 0;
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private ownerSig = "";
  private sizeKey = "";

  constructor(canvas: HTMLCanvasElement, private game: Game) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.14;
    this.scene.background = new THREE.Color(0x14232c);
    this.scene.fog = new THREE.Fog(0xa8bcc4, 320, 700);

    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1200);
    this.cam.position.set(0, CAM_DIST, 0);
    this.cam.lookAt(0, 0, 0);

    const key = new THREE.DirectionalLight(0xfff4dc, 2.05);
    key.position.set(-70, 130, -60);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -90;
    key.shadow.camera.right = 90;
    key.shadow.camera.top = 90;
    key.shadow.camera.bottom = -90;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 520;
    key.shadow.bias = -0.0007;
    this.sun = key;
    this.scene.add(key, key.target);
    this.scene.add(new THREE.HemisphereLight(0xd6ecff, 0x5d7048, 1.25));
    const rim = new THREE.DirectionalLight(0xa8ccf0, 0.42);
    rim.position.set(80, 70, 90);
    this.scene.add(rim);

    this.hoverRing = this.ring(0xffffff, 0.9);
    this.selectRing = this.ring(0xffd479, 0.95);
    this.scene.add(this.hoverRing, this.selectRing);

    this.heights = new Float32Array(0);
    this.corners = new Float32Array(0);
    this.build();
  }

  private ring(color: number, opacity: number) {
    const geo = new THREE.RingGeometry(0.55, 0.82, 26);
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }),
    );
    m.visible = false;
    m.renderOrder = 6;
    return m;
  }

  /* ------------------------------------------------------------------ */
  /* build                                                              */
  /* ------------------------------------------------------------------ */

  private build() {
    const world = this.game.world;
    const { w, h, terrain } = world;
    this.cw = Math.ceil(w / CHUNK);
    this.ch = Math.ceil(h / CHUNK);

    // Height per tile: biome base plus landform noise, then the coarse corner
    // grid the facets are cut from, then the per-tile surface rewritten from the
    // corners so nothing floats above the ground the player can see.
    const fine = new Float32Array(w * h);
    const base: Record<number, number> = {
      [OCEAN]: -0.5, [SAND]: 0.12, [PLAINS]: 0.34, [FOREST]: 0.62, [MOUNTAIN]: 2.3,
    };
    for (let t = 0; t < w * h; t++) {
      const x = t % w;
      const y = (t / w) | 0;
      const n = valueNoise(x, y, 26, 11) * 0.55 + valueNoise(x, y, 9, 23) * 0.3;
      fine[t] = (base[terrain[t]] ?? 0.3) + (terrain[t] === OCEAN ? n * 0.1 : (n - 0.42) * 0.85);
    }
    const soft = new Float32Array(fine.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            sum += fine[ny * w + nx];
            n++;
          }
        }
        soft[y * w + x] = sum / n;
      }
    }
    const cw = this.cw;
    const ch = this.ch;
    this.corners = new Float32Array((cw + 1) * (ch + 1));
    const at = (x: number, y: number) => {
      const cx = Math.max(0, Math.min(w - 1, x));
      const cy = Math.max(0, Math.min(h - 1, y));
      return soft[cy * w + cx];
    };
    for (let cy = 0; cy <= ch; cy++) {
      for (let cx = 0; cx <= cw; cx++) {
        const tx = cx * CHUNK;
        const ty = cy * CHUNK;
        this.corners[cy * (cw + 1) + cx] =
          (at(tx - 1, ty - 1) + at(tx, ty - 1) + at(tx - 1, ty) + at(tx, ty)) * 0.25;
      }
    }
    this.heights = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const fx = x / CHUNK;
        const fz = y / CHUNK;
        const x0 = Math.max(0, Math.min(cw - 1, Math.floor(fx)));
        const z0 = Math.max(0, Math.min(ch - 1, Math.floor(fz)));
        const tx = Math.min(1, Math.max(0, fx - x0));
        const tz = Math.min(1, Math.max(0, fz - z0));
        const i0 = z0 * (cw + 1) + x0;
        const i1 = i0 + (cw + 1);
        const a = this.corners[i0] * (1 - tx) + this.corners[i0 + 1] * tx;
        const b = this.corners[i1] * (1 - tx) + this.corners[i1 + 1] * tx;
        this.heights[y * w + x] = a * (1 - tz) + b * tz;
      }
    }

    // ---- one flat-shaded mesh, two triangles per facet, wound so normals face up
    const cells = cw * ch;
    const pos = new Float32Array(cells * 18);
    const col = new Float32Array(cells * 18);
    const nor = new Float32Array(cells * 18);
    const c = new THREE.Color();
    let p = 0;
    const corner = (cx: number, cy: number) =>
      this.corners[
        Math.max(0, Math.min(ch, cy)) * (cw + 1) + Math.max(0, Math.min(cw, cx))
      ];
    // Facets are described in CHUNK units but must be emitted in TILE units, or
    // the whole landmass lands in the top-left corner of the world (it did).
    const tri = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number) => {
      const x0 = ax * CHUNK;
      const z0 = az * CHUNK;
      const x1 = bx * CHUNK;
      const z1 = bz * CHUNK;
      const x2 = cx * CHUNK;
      const z2 = cz * CHUNK;
      const y0 = corner(ax, az);
      const y1 = corner(bx, bz);
      const y2 = corner(cx, cz);
      const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0;
      const vx = x2 - x0, vy = y2 - y0, vz = z2 - z0;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const xs = [x0, x1, x2], ys = [y0, y1, y2], zs = [z0, z1, z2];
      for (let i = 0; i < 3; i++) {
        pos[p] = xs[i]; pos[p + 1] = ys[i]; pos[p + 2] = zs[i];
        nor[p] = nx; nor[p + 1] = ny; nor[p + 2] = nz;
        col[p] = c.r; col[p + 1] = c.g; col[p + 2] = c.b;
        p += 3;
      }
    };
    for (let z = 0; z < ch; z++) {
      for (let x = 0; x < cw; x++) {
        const counts = new Map<number, number>();
        let roadCells = 0;
        for (let dz = 0; dz < CHUNK; dz++) {
          for (let dx = 0; dx < CHUNK; dx++) {
            const tx = Math.min(w - 1, x * CHUNK + dx);
            const ty = Math.min(h - 1, z * CHUNK + dz);
            const t = ty * w + tx;
            const k = terrain[t];
            counts.set(k, (counts.get(k) ?? 0) + 1);
            if (world.road[t]) roadCells++;
          }
        }
        let kind = PLAINS;
        let best = -1;
        for (const [k, n] of counts) if (n > best) { best = n; kind = k; }
        if (roadCells >= 4 && kind !== OCEAN) {
          c.setHex(ROAD_TONES[(hash(x, z, 31) * ROAD_TONES.length) | 0]);
        } else {
          const fam = BIOME[kind] ?? BIOME[PLAINS];
          c.setHex(fam[(hash(x, z, 7) * fam.length) | 0]);
        }
        c.multiplyScalar(0.96 + hash(x, z, 13) * 0.09);
        if (hash(x, z, 3) < 0.5) {
          tri(x, z, x + 1, z + 1, x + 1, z);
          tri(x, z, x, z + 1, x + 1, z + 1);
        } else {
          tri(x, z, x, z + 1, x + 1, z);
          tri(x + 1, z, x, z + 1, x + 1, z + 1);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.computeBoundingSphere();
    this.terrain = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92 }),
    );
    this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);

    // Sea around the land, so the edge of the world is water and not void.
    const apron = new THREE.Mesh(
      new THREE.PlaneGeometry(w * 4, h * 4),
      new THREE.MeshStandardMaterial({ color: 0x2b7ea6, flatShading: true, roughness: 0.94 }),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(w / 2, -0.6, h / 2);
    this.scene.add(apron);

    this.buildDrape();
    this.buildScatter();
    this.buildCrowd();
  }

  private buildDrape() {
    const { w, h } = this.game.world;
    const data = new Uint8Array(w * h * 4);
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this.drapeTex = tex;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const at = (x: number, y: number) =>
      this.heights[Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))] + 0.02;
    for (let y = 0; y <= h; y++) {
      for (let x = 0; x <= w; x++) {
        pos.push(x, at(x, y), y);
        uv.push(x / w, 1 - y / h);
      }
    }
    const stride = w + 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = y * stride + x;
        idx.push(a, a + 1, a + stride, a + 1, a + stride + 1, a + stride);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    this.drape = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0.6, depthWrite: false,
        side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2,
      }),
    );
    this.drape.renderOrder = 2;
    this.scene.add(this.drape);
  }

  private buildScatter() {
    const world = this.game.world;
    const { w, h, terrain } = world;
    const treeSpots: { x: number; z: number; y: number; s: number; r: number; c: number }[] = [];
    const rockSpots: { x: number; z: number; y: number; s: number; r: number }[] = [];
    for (let t = 0; t < w * h; t++) {
      const x = t % w;
      const z = (t / w) | 0;
      if (terrain[t] === FOREST) {
        if (hash(x, z, 31) > 0.55) continue;
        const n = 1 + ((hash(x, z, 37) * 2) | 0);
        for (let i = 0; i < n; i++) {
          treeSpots.push({
            x: x + 0.15 + hash(x, z, 41 + i) * 0.7,
            z: z + 0.15 + hash(x, z, 47 + i) * 0.7,
            y: this.heights[t],
            s: 1.15 + hash(x, z, 53 + i) * 0.95,
            r: hash(x, z, 59 + i) * 6.283,
            c: TREE_GREENS[(hash(x, z, 61 + i) * TREE_GREENS.length) | 0],
          });
        }
      } else if (terrain[t] === MOUNTAIN && hash(x, z, 71) < 0.45) {
        rockSpots.push({
          x: x + hash(x, z, 73),
          z: z + hash(x, z, 79),
          y: this.heights[t],
          s: 0.5 + hash(x, z, 83) * 0.8,
          r: hash(x, z, 89) * 6.283,
        });
      }
    }
    const cone = new THREE.ConeGeometry(0.42, 1.0, 6, 1);
    cone.translate(0, 0.5, 0);
    this.trees = new THREE.InstancedMesh(
      cone,
      new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.85 }),
      treeSpots.length,
    );
    this.trees.castShadow = true;
    this.trees.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    treeSpots.forEach((s, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.r);
      m.compose(new THREE.Vector3(s.x, s.y, s.z), q, new THREE.Vector3(s.s, s.s, s.s));
      this.trees.setMatrixAt(i, m);
      this.trees.setColorAt(i, col.setHex(s.c));
    });
    this.trees.instanceMatrix.needsUpdate = true;
    if (this.trees.instanceColor) this.trees.instanceColor.needsUpdate = true;
    this.scene.add(this.trees);

    this.rocks = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(0.42, 0),
      new THREE.MeshStandardMaterial({ color: 0x9d9a92, flatShading: true, roughness: 0.95 }),
      rockSpots.length,
    );
    this.rocks.castShadow = true;
    this.rocks.receiveShadow = true;
    rockSpots.forEach((s, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0.3, 1, 0.2).normalize(), s.r);
      m.compose(
        new THREE.Vector3(s.x, s.y + s.s * 0.28, s.z),
        q,
        new THREE.Vector3(s.s, s.s * 1.25, s.s),
      );
      this.rocks.setMatrixAt(i, m);
    });
    this.rocks.instanceMatrix.needsUpdate = true;
    this.scene.add(this.rocks);
  }

  private buildCrowd() {
    const body = new THREE.BoxGeometry(0.24, 0.5, 0.24);
    body.translate(0, 0.25, 0);
    this.men = new THREE.InstancedMesh(
      body,
      new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.7 }),
      4000,
    );
    this.men.count = 0;
    this.men.castShadow = true;
    this.men.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.men);

    const flag = new THREE.PlaneGeometry(0.36, 0.24);
    this.banners = new THREE.InstancedMesh(
      flag,
      new THREE.MeshStandardMaterial({ flatShading: true, side: THREE.DoubleSide, roughness: 0.8 }),
      600,
    );
    this.banners.count = 0;
    this.banners.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.banners);

    const cart = new THREE.BoxGeometry(0.34, 0.2, 0.24);
    cart.translate(0, 0.16, 0);
    this.carts = new THREE.InstancedMesh(
      cart,
      new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.8 }),
      400,
    );
    this.carts.count = 0;
    this.carts.castShadow = true;
    this.carts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.carts);
  }

  /* ------------------------------------------------------------------ */
  /* keeps                                                             */
  /* ------------------------------------------------------------------ */

  private makeKeep(colour: number, tier: number, neutral: boolean): THREE.Object3D {
    const g = new THREE.Group();
    const stone = new THREE.MeshStandardMaterial({ color: STONE, flatShading: true, roughness: 0.9 });
    const dark = new THREE.MeshStandardMaterial({ color: STONE_DARK, flatShading: true, roughness: 0.95 });
    const roof = new THREE.MeshStandardMaterial({
      color: neutral ? 0x6d7078 : colour,
      flatShading: true,
      roughness: 0.75,
    });
    const box = (w: number, hh: number, d: number, mat: any, x = 0, y = 0, z = 0) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), mat);
      mesh.position.set(x, y + hh / 2, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);
    };
    const cone = (r: number, hh: number, mat: any, x = 0, y = 0, z = 0, seg = 6) => {
      const mesh = new THREE.Mesh(new THREE.ConeGeometry(r, hh, seg), mat);
      mesh.position.set(x, y + hh / 2, z);
      mesh.castShadow = true;
      g.add(mesh);
    };
    box(1.5, 0.5, 1.5, stone);
    box(0.66, 1.0 + tier * 0.18, 0.66, stone, 0, 0.5, 0);
    cone(0.5, 0.6, roof, 0, 1.5 + tier * 0.18, 0, 4);
    const towers = tier >= 3 ? [[-0.62, -0.62], [0.62, -0.62], [-0.62, 0.62], [0.62, 0.62]] : [[-0.6, -0.6], [0.6, 0.6]];
    for (const [dx, dz] of towers) {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.9, 7), stone);
      t.position.set(dx, 0.45, dz);
      t.castShadow = true;
      g.add(t);
      cone(0.3, 0.32, roof, dx, 0.9, dz, 7);
    }
    if (tier >= 2) {
      box(0.5, 0.3, 0.4, dark, 0.75, 0, 0.6);
      box(0.4, 0.28, 0.34, dark, -0.8, 0, -0.5);
    }
    return g;
  }

  /* ------------------------------------------------------------------ */
  /* frame                                                             */
  /* ------------------------------------------------------------------ */

  repaint() {
    this.paintDrape();
  }

  reset() {
    this.paintDrape();
  }

  private paintDrape() {
    const tex = this.drapeTex;
    if (!tex) return;
    const world = this.game.world;
    const data = tex.image.data as Uint8Array;
    const terr = this.game.state.territory;
    const colours = this.game.state.players.map((p) => new THREE.Color(p.colour));
    const neutral = new THREE.Color(0x8d8d95);
    for (let t = 0; t < world.w * world.h; t++) {
      const owner = terr[t];
      const o = t * 4;
      if (owner === -2) { data[o + 3] = 0; continue; }
      const c = owner < 0 ? neutral : colours[owner % colours.length];
      data[o] = Math.round(c.r * 255);
      data[o + 1] = Math.round(c.g * 255);
      data[o + 2] = Math.round(c.b * 255);
      data[o + 3] = owner < 0 ? 60 : 140;
    }
    tex.needsUpdate = true;
  }

  draw(cam: { x: number; y: number; scale: number }, hover: number, selected: { host: number | null; city: number | null }, dpr: number) {
    const vw = this.canvas.clientWidth || window.innerWidth;
    const vh = this.canvas.clientHeight || window.innerHeight;
    const key = `${vw}x${vh}x${dpr}`;
    if (key !== this.sizeKey) {
      this.sizeKey = key;
      this.renderer.setPixelRatio(dpr);
      this.renderer.setSize(vw, vh, false);
    }
    const cx = (vw / 2 - cam.x) / cam.scale;
    const cz = (vh / 2 - cam.y) / cam.scale;
    const halfW = vw / 2 / cam.scale;
    const halfH = (vh / 2 / cam.scale) * Math.cos(TILT);
    this.cam.left = -halfW;
    this.cam.right = halfW;
    this.cam.top = halfH;
    this.cam.bottom = -halfH;
    this.cam.position.set(cx, Math.cos(TILT) * CAM_DIST, cz + Math.sin(TILT) * CAM_DIST);
    this.cam.up.set(0, 1, 0);
    this.cam.lookAt(cx, 0, cz);
    this.cam.updateProjectionMatrix();

    this.sun.position.set(cx - 70, 130, cz - 60);
    this.sun.target.position.set(cx, 0, cz);
    this.sun.target.updateMatrixWorld();

    const sig = `${this.game.state.cities.map((c) => c.owner).join("")}`;
    if (sig !== this.ownerSig) {
      this.ownerSig = sig;
      this.paintDrape();
    }

    this.syncKeeps();
    this.syncCrowd(hover, selected);
    this.renderer.render(this.scene, this.cam);
  }

  private syncKeeps() {
    const w = this.game.world.w;
    const live = new Set<number>();
    for (const city of this.game.state.cities) {
      live.add(city.id);
      let obj = this.keeps.get(city.id);
      const colour = this.game.state.players[city.owner]?.colour ?? 0x6d7078;
      if (!obj) {
        obj = this.makeKeep(colour, city.tier, city.owner < 0);
        this.keeps.set(city.id, obj);
        this.scene.add(obj);
      }
      obj.position.set((city.tile % w) + 0.5, this.heights[city.tile], Math.floor(city.tile / w) + 0.5);
    }
    for (const [id, obj] of this.keeps) {
      if (live.has(id)) continue;
      this.scene.remove(obj);
      this.keeps.delete(id);
    }
  }

  private syncCrowd(hover: number, selected: { host: number | null; city: number | null }) {
    const w = this.game.world.w;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3(1, 1, 1);
    const col = new THREE.Color();
    let si = 0;
    let bi = 0;
    const put = (inst: any, i: number, x: number, y: number, z: number, colour: number, scale = 1) => {
      m.compose(new THREE.Vector3(x, y, z), q, sc.set(scale, scale, scale));
      inst.setMatrixAt(i, m);
      inst.setColorAt(i, col.setHex(colour));
    };
    for (const h of this.game.state.hosts as Host[]) {
      const x = h.tile % w;
      const z = Math.floor(h.tile / w);
      const y = this.heights[h.tile];
      const colour = this.game.state.players[h.owner]?.colour ?? 0x999999;
      const blocks = Math.max(1, Math.min(6, Math.round(h.men / 40)));
      for (let i = 0; i < blocks && si < 4000; i++) {
        const ox = ((i % 3) - 1) * 0.26;
        const oz = (Math.floor(i / 3) - 0.5) * 0.26;
        put(this.men, si++, x + 0.5 + ox, y, z + 0.5 + oz, colour);
      }
      if (bi < 600) put(this.banners, bi++, x + 0.5, y + 1.0, z + 0.5, colour);
    }
    this.men.count = si;
    this.banners.count = bi;
    this.men.instanceMatrix.needsUpdate = true;
    this.banners.instanceMatrix.needsUpdate = true;
    if (this.men.instanceColor) this.men.instanceColor.needsUpdate = true;
    if (this.banners.instanceColor) this.banners.instanceColor.needsUpdate = true;

    let ci = 0;
    for (const c of this.game.state.convoys as Convoy[]) {
      if (ci >= 400) break;
      const x = c.tile % w;
      const z = Math.floor(c.tile / w);
      const colour = this.game.state.players[c.owner]?.colour ?? 0x999999;
      put(this.carts, ci++, x + 0.5, this.heights[c.tile] + 0.05, z + 0.5, colour, 1.2);
    }
    this.carts.count = ci;
    this.carts.instanceMatrix.needsUpdate = true;
    if (this.carts.instanceColor) this.carts.instanceColor.needsUpdate = true;

    if (hover >= 0) {
      const x = hover % w;
      const z = Math.floor(hover / w);
      this.hoverRing.visible = true;
      this.hoverRing.position.set(x + 0.5, this.heights[hover] + 0.07, z + 0.5);
    } else {
      this.hoverRing.visible = false;
    }
    const selTile =
      selected.host !== null
        ? this.game.hostById(selected.host)?.tile ?? null
        : selected.city !== null
          ? this.game.cityById(selected.city)?.tile ?? null
          : null;
    if (selTile !== null) {
      this.selectRing.visible = true;
      this.selectRing.position.set(
        (selTile % w) + 0.5,
        this.heights[selTile] + 0.09,
        Math.floor(selTile / w) + 0.5,
      );
      this.selectRing.scale.setScalar(1.3);
    } else {
      this.selectRing.visible = false;
    }
  }

  /** Screen point to tile through the real tilted camera. */
  tileAtScreen(px: number, py: number): number {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((px - rect.left) / rect.width) * 2 - 1,
      -(((py - rect.top) / rect.height) * 2 - 1),
    );
    this.ray.setFromCamera(ndc, this.cam);
    const hits = this.terrain ? this.ray.intersectObject(this.terrain, false) : [];
    let point: THREE.Vector3 | null = hits.length ? hits[0].point : null;
    if (!point) {
      const p = new THREE.Vector3();
      if (this.ray.ray.intersectPlane(this.plane, p)) point = p;
    }
    if (!point) return -1;
    const x = Math.floor(point.x);
    const y = Math.floor(point.z);
    const world = this.game.world;
    if (x < 0 || y < 0 || x >= world.w || y >= world.h) return -1;
    return y * world.w + x;
  }
}
