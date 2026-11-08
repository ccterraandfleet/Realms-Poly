/**
 * Realms, new build. Boot, camera, input, HUD.
 *
 * Kept deliberately thin: the simulation owns the rules, the poly view owns the
 * pixels, and this file only wires clicks, keys and the readout to them.
 */

import { generateWorld } from "./sim/world";
import { Game } from "./sim/game";
import { PolyView } from "./view/poly";

const SAVE_KEY = "realms.poly.v1";

const canvas = document.getElementById("map") as HTMLCanvasElement;
const params = new URLSearchParams(location.search);
const seed = Number(params.get("seed") ?? localStorage.getItem("realms.poly.seed") ?? 7) || 7;

const world = generateWorld(seed);
const resumedRaw = params.get("fresh") ? null : localStorage.getItem(SAVE_KEY);
const game = (resumedRaw ? Game.load(world, resumedRaw) : null) ?? new Game(world);
if (params.get("fresh")) localStorage.removeItem(SAVE_KEY);

const view = new PolyView(canvas, game);
(window as any).__realms = { game, view, cam: null };

const cam = { x: 0, y: 0, scale: 7 };
(window as any).__realms.cam = cam;

const selected: { host: number | null; city: number | null } = { host: null, city: null };
let hover = -1;
let speed = 1;

/* ---------------------------------------------------------------- camera */

function centreOn(tile: number, scale = cam.scale) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cx = (tile % world.w) + 0.5;
  const cz = Math.floor(tile / world.w) + 0.5;
  cam.scale = scale;
  cam.x = vw / 2 - cx * scale;
  cam.y = vh / 2 - cz * scale;
  clampCam();
}

function clampCam() {
  const mw = world.w * cam.scale;
  const mh = world.h * cam.scale;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  cam.x = mw <= vw ? (vw - mw) / 2 : Math.min(60, Math.max(vw - mw - 60, cam.x));
  cam.y = mh <= vh ? (vh - mh) / 2 : Math.min(60, Math.max(vh - mh - 60, cam.y));
}

const home = game.citiesOf(0)[0] ?? game.state.cities[0];
if (home) centreOn(home.tile, 7);

/* ---------------------------------------------------------------- input */

let dragging = false;
let dragX = 0;
let dragY = 0;
let moved = 0;

canvas.addEventListener("pointerdown", (e) => {
  dragging = true;
  moved = 0;
  dragX = e.clientX;
  dragY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", (e) => {
  hover = view.tileAtScreen(e.clientX, e.clientY);
  if (!dragging) return;
  const dx = e.clientX - dragX;
  const dy = e.clientY - dragY;
  moved += Math.abs(dx) + Math.abs(dy);
  cam.x += dx;
  cam.y += dy;
  dragX = e.clientX;
  dragY = e.clientY;
  clampCam();
});

canvas.addEventListener("pointerup", (e) => {
  dragging = false;
  if (moved > 6) return;
  const tile = view.tileAtScreen(e.clientX, e.clientY);
  if (tile < 0) return;
  if (e.button === 2) {
    orderMarch(tile);
    return;
  }
  selectTile(tile);
});

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const before = view.tileAtScreen(e.clientX, e.clientY);
    const factor = Math.pow(1.0016, -e.deltaY);
    cam.scale = Math.max(2.2, Math.min(22, cam.scale * factor));
    const after = view.tileAtScreen(e.clientX, e.clientY);
    if (before >= 0 && after >= 0 && before !== after) {
      const bx = before % world.w;
      const bz = Math.floor(before / world.w);
      const ax = after % world.w;
      const az = Math.floor(after / world.w);
      cam.x += (ax - bx) * cam.scale;
      cam.y += (az - bz) * cam.scale;
    }
    clampCam();
  },
  { passive: false },
);

window.addEventListener("resize", clampCam);

function selectTile(tile: number) {
  const host = game.state.hosts.find((h) => h.tile === tile);
  if (host) {
    selected.host = host.id;
    selected.city = null;
    return;
  }
  const city = game.cityAt(tile);
  if (city) {
    selected.city = city.id;
    selected.host = null;
    return;
  }
  selected.host = null;
  selected.city = null;
}

function orderMarch(tile: number) {
  if (selected.host === null) return;
  const nearest = game.state.cities
    .slice()
    .sort((a, b) => game.tileDistance(a.tile, tile) - game.tileDistance(b.tile, tile))[0];
  if (!nearest) return;
  const msg = game.march(selected.host, nearest.id);
  flash(msg);
}

/* ---------------------------------------------------------------- HUD */

const el = (id: string) => document.getElementById(id)!;
const statsEl = el("stats");
const logEl = el("log");
const panelEl = el("panel");
const flashEl = el("flash");

let flashTimer = 0;
function flash(text: string) {
  flashEl.textContent = text;
  flashEl.classList.add("show");
  flashTimer = 2.2;
}

function seasonName(): string {
  const s = game.season();
  if (s > 0.75) return "Winter";
  if (s > 0.5) return "Harvest";
  if (s > 0.25) return "Summer";
  return "Spring";
}

function renderHud() {
  const st = game.stats(0);
  const cities = game.state.cities.length;
  const mine = st.cities;
  statsEl.innerHTML = `
    <div class="stat"><span>Grain</span><b>${st.grain.toLocaleString()}</b></div>
    <div class="stat"><span>People</span><b>${st.pop.toLocaleString()}</b></div>
    <div class="stat"><span>Men</span><b>${st.men}</b></div>
    <div class="stat"><span>Holdings</span><b>${mine}/${cities}</b></div>
    <div class="stat"><span>Season</span><b class="${game.isWinter() ? "cold" : ""}">${seasonName()}</b></div>
    <div class="stat"><span>Supply</span><b>${Math.round(st.supply * 100)}%</b></div>
  `;

  if (selected.city !== null) {
    const c = game.cityById(selected.city);
    if (!c) return;
    const owner = c.owner >= 0 ? game.state.players[c.owner].name : "unclaimed";
    panelEl.innerHTML = `
      <h2>${c.name}</h2>
      <p class="sub">${owner}${c.owner === 0 ? " · yours" : ""}</p>
      <dl>
        <div><dt>People</dt><dd>${Math.round(c.pop)}</dd></div>
        <div><dt>Barn</dt><dd>${Math.round(c.stock).toLocaleString()} / ${c.barnCap.toLocaleString()}</dd></div>
        <div><dt>Morale</dt><dd>${Math.round(c.morale * 100)}%</dd></div>
        <div><dt>Tier</dt><dd>${c.tier}</dd></div>
      </dl>
      ${c.owner === 0 ? `<button id="muster">Muster men</button>` : ""}
    `;
    el("muster")?.addEventListener("click", () => flash(game.muster(c.id)));
  } else if (selected.host !== null) {
    const h = game.hostById(selected.host);
    if (!h) return;
    const owner = game.state.players[h.owner]?.name ?? "unknown";
    panelEl.innerHTML = `
      <h2>Host of ${h.men} men</h2>
      <p class="sub">${owner}${h.owner === 0 ? " · yours" : ""}</p>
      <dl>
        <div><dt>Supply</dt><dd>${Math.round(h.supply * 100)}%</dd></div>
        <div><dt>Morale</dt><dd>${Math.round(h.morale * 100)}%</dd></div>
        <div><dt>Orders</dt><dd>${h.besieging !== null ? "besieging" : h.path.length ? "marching" : "holding"}</dd></div>
      </dl>
      <p class="hint">Right-click a city to march on it.</p>
    `;
  } else {
    panelEl.innerHTML = `<h2>Nothing selected</h2><p class="hint">Click a keep to muster, or a host to give orders. Drag to pan, scroll to zoom.</p>`;
  }

  logEl.innerHTML = game.state.log.slice(0, 7).map((l) => `<div>${l}</div>`).join("");
}

el("speed").addEventListener("click", () => {
  speed = speed === 1 ? 2 : speed === 2 ? 0 : 1;
  el("speed").textContent = speed === 0 ? "Paused" : `${speed}x`;
});

el("homebtn").addEventListener("click", () => {
  const c = game.citiesOf(0)[0] ?? game.state.cities[0];
  if (c) centreOn(c.tile, 8);
});

el("fresh").addEventListener("click", () => {
  const next = Math.floor(Math.random() * 9000) + 100;
  localStorage.setItem("realms.poly.seed", String(next));
  localStorage.removeItem(SAVE_KEY);
  location.href = `?seed=${next}&fresh=1`;
});

/* ---------------------------------------------------------------- loop */

let last = performance.now();
let saveTimer = 0;
let hudTimer = 0;

function frame(now: number) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;

  if (speed > 0) {
    // Fixed steps keep the simulation deterministic whether the tab is smooth
    // or struggling: same rules per second of game time.
    const scaled = dt * speed;
    let left = scaled;
    while (left > 0) {
      const step = Math.min(0.1, left);
      game.tick(step);
      left -= step;
    }
  }

  view.draw(cam, hover, selected, Math.min(2, window.devicePixelRatio || 1));

  hudTimer -= dt;
  if (hudTimer <= 0) {
    hudTimer = 0.2;
    renderHud();
  }
  if (flashTimer > 0) {
    flashTimer -= dt;
    if (flashTimer <= 0) flashEl.classList.remove("show");
  }
  saveTimer -= dt;
  if (saveTimer <= 0) {
    saveTimer = 6;
    try {
      localStorage.setItem(SAVE_KEY, game.save());
    } catch {
      /* a full quota must never break play */
    }
  }
  requestAnimationFrame(frame);
}

renderHud();
requestAnimationFrame(frame);
