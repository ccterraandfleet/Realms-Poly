/**
 * Realms, new build. The simulation.
 *
 * Written fresh from Mason's mechanics list rather than ported, so the shape of
 * the code follows the rules instead of the rules being squeezed into old code:
 *
 *  - economy is territory: cities produce from the ground they hold, richer
 *    ground yields more, and the middle of the continent is worth a campaign;
 *  - food is physical: cities hold a barn stock, convoys carry it, and a host
 *    with no supply loses morale and then DEFECTS rather than quietly vanishing;
 *  - armies are discrete hosts that move and fight along roads;
 *  - a siege is a countdown on the city's own stock, not an instant capture;
 *  - winter cuts yield, raids happen whenever, and conquest ends the run;
 *  - the whole thing is one persistent world: it saves itself and resumes.
 */

import {
  FOREST,
  MOUNTAIN,
  OCEAN,
  World,
  findPath,
} from "./world";

export const SEASON_SECONDS = 480; // a year is eight minutes of real time

export interface City {
  id: number;
  tile: number;
  name: string;
  owner: number; // -1 neutral
  pop: number;
  beds: number;
  stock: number; // grain in the barn
  barnCap: number;
  morale: number; // 0..1, the siege clock
  tier: number; // 1..4, gates beds, barn and host size
}

export interface Host {
  id: number;
  owner: number;
  tile: number;
  men: number;
  supply: number; // 0..1
  morale: number; // 0..1
  path: number[];
  goal: number | null; // city id
  besieging: number | null; // city id
  routed: boolean;
  rally: number; // seconds until this host will take orders again
  speedAcc?: number;
}

export interface Convoy {
  id: number;
  owner: number;
  tile: number;
  path: number[];
  rations: number;
  men: number; // escort strength
  targetHost: number;
  acc?: number;
}

export interface Player {
  id: number;
  name: string;
  ai: boolean;
  grain: number; // treasury of grain beyond barns, for mustering
  colour: number;
}

export interface GameState {
  seed: number;
  time: number;
  prestiges: number;
  winner: number | null;
  players: Player[];
  cities: City[];
  hosts: Host[];
  convoys: Convoy[];
  territory: Int16Array;
  nextHostId: number;
  nextConvoyId: number;
  log: string[];
}

export const BARN_BASE = 6000;
export const CONVOY_RATIONS = 400;
export const HOST_MAX_MEN = [0, 240, 420, 700, 1100]; // by city tier

export class Game {
  state: GameState;
  world: World;
  private ownerTimer = 0;
  private aiTimer = 0;
  private convoyTimer = 0;

  constructor(world: World, resumed?: GameState) {
    this.world = world;
    this.state = resumed ?? this.freshState();
  }

  private freshState(): GameState {
    const sites = this.world.citySites;
    const players: Player[] = [
      { id: 0, name: "You", ai: false, grain: 500, colour: 0xd84a3b },
      { id: 1, name: "Lord Harrow", ai: true, grain: 700, colour: 0x3b6fd8 },
      { id: 2, name: "Lady Vess", ai: true, grain: 700, colour: 0x35a05a },
      { id: 3, name: "The Grey", ai: true, grain: 700, colour: 0x8a5ac8 },
      { id: 4, name: "Warden Kade", ai: true, grain: 700, colour: 0xd89a35 },
    ];
    const cities: City[] = sites.map((s, i) => ({
      id: i,
      tile: s.tile,
      name: s.name,
      owner: i < players.length ? i : -1,
      pop: i < players.length ? 320 : 140,
      beds: 400,
      stock: i < players.length ? 1800 : 700,
      barnCap: BARN_BASE,
      morale: 1,
      tier: i < players.length ? 2 : 1,
    }));
    const territory = new Int16Array(this.world.w * this.world.h).fill(-2); // -2 = water
    const state: GameState = {
      seed: this.world.seed,
      time: 0,
      prestiges: 0,
      winner: null,
      players,
      cities,
      hosts: [],
      convoys: [],
      territory,
      nextHostId: 1,
      nextConvoyId: 1,
      log: [],
    };
    // Every player starts with one host at their capital, so turn one has stakes.
    for (const p of players) {
      const home = cities.find((c) => c.owner === p.id);
      if (!home) continue;
      state.hosts.push({
        id: state.nextHostId++,
        owner: p.id,
        tile: home.tile,
        men: 180,
        supply: 1,
        morale: 1,
        path: [],
        goal: null,
        besieging: null,
        routed: false,
        rally: 0,
      });
      home.pop -= 180;
    }
    return state;
  }

  /* ---------------------------------------------------------------- */
  /* helpers                                                          */
  /* ---------------------------------------------------------------- */

  cityAt(tile: number): City | undefined {
    return this.state.cities.find((c) => c.tile === tile);
  }

  cityById(id: number | null): City | undefined {
    return id === null ? undefined : this.state.cities.find((c) => c.id === id);
  }

  hostById(id: number): Host | undefined {
    return this.state.hosts.find((h) => h.id === id);
  }

  ownerOf(tile: number): number {
    const v = this.state.territory[tile];
    return v === -2 ? -2 : v;
  }

  season(): number {
    return (this.state.time % SEASON_SECONDS) / SEASON_SECONDS;
  }

  isWinter(): boolean {
    return this.season() > 0.75; // last quarter of the year
  }

  citiesOf(owner: number): City[] {
    return this.state.cities.filter((c) => c.owner === owner);
  }

  hostsOf(owner: number): Host[] {
    return this.state.hosts.filter((h) => h.owner === owner);
  }

  /** Living owners, for the win check and for the AI's threat list. */
  livingOwners(): number[] {
    const set = new Set<number>();
    for (const c of this.state.cities) if (c.owner >= 0) set.add(c.owner);
    return [...set];
  }

  fieldPower(h: Host): number {
    return h.men * (0.35 + 0.65 * h.supply) * (0.5 + 0.5 * h.morale);
  }

  log(line: string) {
    this.state.log.unshift(`${Math.floor(this.state.time)}s  ${line}`);
    if (this.state.log.length > 40) this.state.log.pop();
  }

  /* ---------------------------------------------------------------- */
  /* orders the player (and the AI) can give                          */
  /* ---------------------------------------------------------------- */

  muster(cityId: number): string {
    const c = this.cityById(cityId);
    if (!c) return "no such city";
    const cap = HOST_MAX_MEN[c.tier];
    const men = Math.min(120, Math.floor(c.pop - 40));
    if (men < 20) return "not enough people";
    const existing = this.state.hosts.find((h) => h.owner === c.owner && h.tile === c.tile);
    if (existing && existing.men + men <= cap) {
      existing.men += men;
      existing.supply = 1;
      c.pop -= men;
      return `+${men} men at ${c.name}`;
    }
    if (this.state.hosts.filter((h) => h.owner === c.owner).length > 6) return "too many hosts";
    const h: Host = {
      id: this.state.nextHostId++,
      owner: c.owner,
      tile: c.tile,
      men,
      supply: 1,
      morale: 1,
      path: [],
      goal: null,
      besieging: null,
      routed: false,
      rally: 0,
    };
    this.state.hosts.push(h);
    c.pop -= men;
    return `muster ${men} at ${c.name}`;
  }

  march(hostId: number, cityId: number): string {
    const h = this.hostById(hostId);
    const c = this.cityById(cityId);
    if (!h || !c) return "nothing to march";
    if (h.routed || h.rally > 0) return "host is rallying";
    const path = findPath(this.world.terrain, this.world.w, this.world.h, h.tile, c.tile);
    if (!path) return "no road there";
    h.path = path.slice(1);
    h.goal = c.id;
    h.besieging = null;
    return `${h.men} men march on ${c.name}`;
  }

  /* ---------------------------------------------------------------- */
  /* the tick                                                         */
  /* ---------------------------------------------------------------- */

  tick(dt: number) {
    const s = this.state;
    if (s.winner !== null) return;
    s.time += dt;
    const winter = this.isWinter();

    this.citiesTick(dt, winter);
    this.hostsTick(dt);
    this.convoysTick(dt);
    this.territoryTick(dt);
    this.aiTick(dt);
    this.victoryTick();
  }

  private citiesTick(dt: number, winter: boolean) {
    const w = this.world.w;
    for (const c of this.state.cities) {
      const x = c.tile % w;
      const y = (c.tile / w) | 0;
      // Yield grows with the richness of the ground it holds and shrinks in winter.
      let richness = 0;
      let n = 0;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const t = (y + dy) * w + (x + dx);
          if (t < 0 || t >= this.world.w * this.world.h) continue;
          if (this.world.terrain[t] === OCEAN) continue;
          richness += this.world.richness[t];
          n++;
        }
      }
      const ground = n ? richness / n : 1;
      const farmers = Math.min(c.pop, 400) / 400;
      const yield_ = 22 * ground * (0.55 + 0.75 * farmers) * (winter ? 0.4 : 1);
      c.stock = Math.min(c.barnCap, c.stock + yield_ * dt);

      // People need feeding; the barn is the buffer between them and starvation.
      const eaten = c.pop * 0.012 * dt;
      c.stock -= eaten;
      const roomFor = Math.max(0, c.stock) / 8;
      const cap = Math.min(c.beds, c.owner >= 0 ? roomFor + 40 : roomFor);
      if (c.pop < cap) c.pop = Math.min(cap, c.pop + c.pop * 0.02 * dt + 0.4 * dt);
      else if (c.pop > cap) c.pop = Math.max(cap, c.pop - c.pop * 0.03 * dt);

      if (c.stock < 0) {
        c.stock = 0;
        c.morale = Math.max(0, c.morale - 0.02 * dt);
      } else if (c.morale < 1) {
        c.morale = Math.min(1, c.morale + 0.01 * dt);
      }
    }
  }

  private hostsTick(dt: number) {
    const alive: Host[] = [];
    for (const h of this.state.hosts) {
      if (h.rally > 0) h.rally = Math.max(0, h.rally - dt);

      // ---- movement along the path
      if (h.path.length && !h.routed) {
        const next = h.path[0];
        const onRoad = this.world.road[h.tile] === 1 && this.world.road[next] === 1;
        const speed = onRoad ? 2.6 : 1.4; // roads are why war is fought on roads
        if (h.speedAcc === undefined) h.speedAcc = 0;
        h.speedAcc += dt * speed;
        if (h.speedAcc >= 1) {
          h.speedAcc -= 1;
          h.tile = h.path.shift()!;
        }
      }

      // ---- supply: a host eats from the nearest friendly barn, or starves
      const home = this.state.cities.find(
        (c) => c.owner === h.owner && this.tileDistance(c.tile, h.tile) <= 4 && c.stock > 20,
      );
      if (home) {
        const draw = h.men * 0.02 * dt;
        home.stock = Math.max(0, home.stock - draw);
        h.supply = Math.min(1, h.supply + 0.5 * dt);
      } else {
        h.supply = Math.max(0, h.supply - 0.055 * dt);
      }

      // ---- morale follows the belly, and a broken host defects
      if (h.supply > 0.4) h.morale = Math.min(1, h.morale + 0.035 * dt);
      else h.morale = Math.max(0, h.morale - 0.045 * dt);

      if (h.morale <= 0.001) {
        const enemyOwner = this.nearestEnemyOwner(h);
        if (enemyOwner >= 0) {
          h.owner = enemyOwner;
          h.men = Math.round(h.men * 0.85);
          h.morale = 0.25;
          h.supply = 0.2;
          h.path = [];
          h.goal = null;
          h.besieging = null;
          this.log(`${h.men} starving men defect to ${this.state.players[enemyOwner]?.name ?? "the enemy"}`);
        } else {
          h.routed = true;
          h.rally = 8;
        }
      }

      // ---- siege: the city's own barn is the clock
      const adj = this.state.cities.find(
        (c) => c.owner !== h.owner && h.owner >= 0 && this.tileDistance(c.tile, h.tile) <= 1,
      );
      if (adj) {
        h.besieging = adj.id;
        h.path = [];
        adj.stock = Math.max(0, adj.stock - 14 * dt);
        adj.morale = Math.max(
          0,
          adj.morale - (adj.stock > 0 ? 0.012 : 0.05) * dt,
        );
        if (adj.morale <= 0) {
          adj.owner = h.owner;
          adj.morale = 0.5;
          adj.pop = Math.round(adj.pop * 0.8);
          h.besieging = null;
          this.log(`${adj.name} falls to ${this.state.players[h.owner]?.name ?? "a lord"}`);
        }
      } else if (h.besieging !== null) {
        h.besieging = null;
      }

      // ---- war on the roads: hostile hosts in the same place fight
      for (const o of this.state.hosts) {
        if (o === h || o.owner === h.owner || o.owner < 0 || h.owner < 0) continue;
        if (this.tileDistance(h.tile, o.tile) > 0) continue;
        const mine = this.fieldPower(h);
        const theirs = this.fieldPower(o);
        const total = mine + theirs || 1;
        const hLoss = Math.round(o.men * 0.02 * (theirs / total) * dt * 20);
        const oLoss = Math.round(h.men * 0.02 * (mine / total) * dt * 20);
        h.men = Math.max(0, h.men - hLoss);
        o.men = Math.max(0, o.men - oLoss);
        if (mine < theirs) h.morale = Math.max(0, h.morale - 0.09 * dt * 6);
        else o.morale = Math.max(0, o.morale - 0.09 * dt * 6);
      }

      if (h.men <= 0) {
        this.log(`a host is destroyed on the road`);
        continue;
      }
      alive.push(h);
    }
    this.state.hosts = alive;
  }

  private convoysTick(dt: number) {
    this.convoyTimer -= dt;
    // Grain walks. A hungry host with a friendly barn behind it gets a cart.
    if (this.convoyTimer <= 0) {
      this.convoyTimer = 5;
      for (const h of this.state.hosts) {
        if (h.supply > 0.55) continue;
        const from = this.state.cities
          .filter((c) => c.owner === h.owner && c.stock > 1200)
          .sort((a, b) => this.tileDistance(a.tile, h.tile) - this.tileDistance(b.tile, h.tile))[0];
        if (!from) continue;
        if (this.state.convoys.some((c) => c.targetHost === h.id)) continue;
        const path = findPath(this.world.terrain, this.world.w, this.world.h, from.tile, h.tile);
        if (!path) continue;
        from.stock -= CONVOY_RATIONS;
        this.state.convoys.push({
          id: this.state.nextConvoyId++,
          owner: h.owner,
          tile: from.tile,
          path: path.slice(1),
          rations: CONVOY_RATIONS,
          men: 20,
          targetHost: h.id,
        });
      }
    }
    const keep: Convoy[] = [];
    for (const c of this.state.convoys) {
      // An enemy host near the road eats the cart. This is the ambush.
      const raider = this.state.hosts.find(
        (h) => h.owner !== c.owner && this.tileDistance(h.tile, c.tile) <= 1,
      );
      if (raider) {
        raider.supply = Math.min(1, raider.supply + 0.25);
        this.log(`a convoy is taken on the road`);
        continue;
      }
      if (c.path.length) {
        c.acc = (c.acc ?? 0) + dt * 2.2;
        while (c.acc >= 1 && c.path.length) {
          c.acc -= 1;
          c.tile = c.path.shift()!;
        }
      }
      const host = this.hostById(c.targetHost);
      if (!host || host.owner !== c.owner) continue;
      if (this.tileDistance(host.tile, c.tile) === 0 && !c.path.length) {
        host.supply = Math.min(1, host.supply + c.rations / (host.men * 2));
        host.morale = Math.min(1, host.morale + 0.15);
        continue;
      }
      keep.push(c);
    }
    this.state.convoys = keep;
  }

  /** Territory is derived, not painted: whoever's city is nearest holds it. */
  private territoryTick(dt: number) {
    this.ownerTimer -= dt;
    if (this.ownerTimer > 0) return;
    this.ownerTimer = 0.75;
    const { w, h, terrain } = this.world;
    const t = this.state.territory;
    for (let i = 0; i < w * h; i++) {
      if (terrain[i] === OCEAN) {
        t[i] = -2;
        continue;
      }
      let best = -1;
      let bestD = Infinity;
      for (const c of this.state.cities) {
        const d = this.tileDistance(c.tile, i);
        if (d < bestD) {
          bestD = d;
          best = c.owner;
        }
      }
      const reach = 16;
      t[i] = bestD <= reach ? best : -1;
    }
  }

  private aiTick(dt: number) {
    this.aiTimer -= dt;
    if (this.aiTimer > 0) return;
    this.aiTimer = 4;
    for (const p of this.state.players) {
      if (!p.ai) continue;
      const mine = this.citiesOf(p.id);
      if (!mine.length) continue;
      const hosts = this.hostsOf(p.id);
      // Muster when quiet, march when strong: the whole point is pressure.
      const totalMen = hosts.reduce((n, h) => n + h.men, 0);
      if (totalMen < 260 && mine.some((c) => c.pop > 160)) {
        const city = mine.sort((a, b) => b.pop - a.pop)[0];
        this.muster(city.id);
        continue;
      }
      const target = this.state.cities
        .filter((c) => c.owner !== p.id)
        .sort((a, b) => {
          const ha = hosts[0];
          if (!ha) return 0;
          return this.tileDistance(ha.tile, a.tile) - this.tileDistance(ha.tile, b.tile);
        })[0];
      if (!target) continue;
      for (const h of hosts) {
        if (h.besieging !== null || h.path.length || h.routed) continue;
        if (h.men < 120 || h.supply < 0.3) continue;
        this.march(h.id, target.id);
      }
    }
  }

  private victoryTick() {
    const living = this.livingOwners();
    if (living.length === 1 && this.state.winner === null) {
      this.state.winner = living[0];
      this.state.prestiges += 1;
      this.log(`${this.state.players[living[0]]?.name ?? "someone"} holds every city`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* distance on a tile grid, and the nearest hostile owner           */
  /* ---------------------------------------------------------------- */

  tileDistance(a: number, b: number): number {
    const w = this.world.w;
    const ax = a % w;
    const ay = (a / w) | 0;
    const bx = b % w;
    const by = (b / w) | 0;
    return Math.max(Math.abs(ax - bx), Math.abs(ay - by)) <= 1
      ? (ax === bx && ay === by ? 0 : 1)
      : Math.hypot(ax - bx, ay - by);
  }

  private nearestEnemyOwner(h: Host): number {
    let best = -1;
    let bestD = 60;
    for (const c of this.state.cities) {
      if (c.owner < 0 || c.owner === h.owner) continue;
      const d = this.tileDistance(c.tile, h.tile);
      if (d < bestD) {
        bestD = d;
        best = c.owner;
      }
    }
    return best;
  }

  /* ---------------------------------------------------------------- */
  /* persistence: one world that resumes                              */
  /* ---------------------------------------------------------------- */

  save(): string {
    return JSON.stringify(this.state);
  }

  static load(world: World, raw: string): Game | null {
    try {
      const parsed = JSON.parse(raw) as GameState & { territory: number[] };
      parsed.territory = Int16Array.from(parsed.territory);
      return new Game(world, parsed as GameState);
    } catch {
      return null;
    }
  }

  stats(owner: number) {
    const cities = this.citiesOf(owner);
    const hosts = this.hostsOf(owner);
    return {
      cities: cities.length,
      men: hosts.reduce((n, h) => n + h.men, 0),
      grain: Math.round(cities.reduce((n, c) => n + c.stock, 0)),
      pop: Math.round(cities.reduce((n, c) => n + c.pop, 0)),
      supply: hosts.length ? hosts.reduce((n, h) => n + h.supply, 0) / hosts.length : 1,
      morale: hosts.length ? hosts.reduce((n, h) => n + h.morale, 0) / hosts.length : 1,
      tier: cities.length ? Math.max(...cities.map((c) => c.tier)) : 0,
    };
  }
}
