// Push-optimal Sokoban solver: push-based A* over rooms, one level at a time.
//
// Why this beats the house baseline (plain A* over player moves): the baseline
// searches every step and knows no deadlock, so it wastes its budget on positions
// no push can save and its answers minimise moves, not pushes. This solver instead
// searches over pushes only (a state is the boxes plus the player's reachable
// region), prunes dead squares and frozen 2x2 blocks, and guides the search with
// an admissible push-distance assignment heuristic, so the first solution it
// finds is push-optimal. Levels here are hallway + rooms, and a box pushed out
// of a room can never come back, so each room is solved on its own from its door
// and the move strings are stitched together: a level's optimum is the sum of
// its rooms' optima. Pure work budget (an expansion cap), never the clock, so
// two runs write identical bytes.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The four directions: [dx, dy, walk letter, push letter]. */
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];
/** Most expansions one room search may spend: work, never the clock. */
const MAX_EXPANSIONS = 400_000;
/** The states the generator's own breadth-first search keeps: the fallback budget. */
const SEARCH_STATES = 250_000;
/** Most expansions the whole-level fallback may spend (rooms that do not split). */
const MAX_EXPANSIONS_WHOLE = 200_000;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * For each goal, the fewest pushes that move a lone box from any square onto
 * it (ignoring other boxes and whether the player can reach the push square):
 * a reverse BFS over box positions. A square with a distance to some goal is
 * live; the rest can never hold a box in a solvable state.
 */
function pushDistances(level: Level): { dist: Int32Array[]; live: Uint8Array } {
  const { w, wall, goals } = level;
  const size = wall.length;
  const dist: Int32Array[] = [];
  const live = new Uint8Array(size);
  for (const g of goals) {
    const d = new Int32Array(size).fill(-1);
    d[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const q = queue[qi]!;
      for (const [dx, dy] of DIRS) {
        const step = dy * w + dx;
        const p = q - step; // the box stood here before the push to q
        if (wall[p] || wall[p - step] || d[p] >= 0) continue;
        d[p] = d[q]! + 1;
        queue.push(p);
      }
    }
    dist.push(d);
    for (let s = 0; s < size; s++) if (d[s] >= 0) live[s] = 1;
  }
  return { dist, live };
}

/** The squares the player reaches from `from` with `occupied` in the way; returns the lowest such square. */
function reach(level: Level, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes with a box off its goal. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/**
 * A lower bound on the pushes still needed: the cheapest assignment of boxes
 * to goals by push-distance (exact min-cost matching for few boxes, the sum of
 * per-box minima for many). Admissible: one push moves one box one square.
 */
function heuristic(boxes: number[], dist: Int32Array[]): number {
  const n = boxes.length;
  if (n === 0) return 0;
  if (n > 6) {
    let sum = 0;
    for (const b of boxes) {
      let best = Infinity;
      for (const d of dist) if (d[b] >= 0 && d[b] < best) best = d[b];
      if (best === Infinity) return Infinity;
      sum += best;
    }
    return sum;
  }
  // Exact min-cost assignment by trying every permutation of the goals.
  const perm = dist.map((_, i) => i);
  let best = Infinity;
  const rec = (i: number, sum: number): void => {
    if (sum >= best) return;
    if (i === n) {
      best = sum;
      return;
    }
    for (let j = i; j < n; j++) {
      [perm[i], perm[j]] = [perm[j]!, perm[i]!];
      const c = dist[perm[i]!]![boxes[i]!]!;
      if (c >= 0) rec(i + 1, sum + c);
      [perm[i], perm[j]] = [perm[j]!, perm[i]!];
    }
  };
  rec(0, 0);
  return best;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (u, d, l, r first on ties). */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

const keyOf = (boxes: number[], low: number): string => `${low}:${boxes.join(',')}`;

/**
 * The push-optimal solution of `level`: {pushes, moves} (moves in LURD, a lower
 * letter a step, an upper one a push), or null when the search gives up. A*
 * over pushes: g is pushes made, h the assignment heuristic, the state key the
 * boxes plus the player's reachable region, so two states that differ only in
 * where the player stands inside one region count as one. With astar off, h is
 * 0 and the same code runs a plain breadth-first search over pushes, the
 * fallback when A* ever gives up (the generator only keeps rooms its own
 * breadth-first search solves, so the fallback covers every drawn room).
 */
function solvePushOptimal(level: Level, maxExpansions: number, astar = true): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const { dist, live } = pushDistances(level);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;
  if (solved(level.boxes)) return { pushes: 0, moves: '' };

  const statesBoxes: number[][] = [level.boxes];
  const statesPlayer: number[] = [level.player];
  const statesG: number[] = [0];
  const parent: number[] = [-1];
  const best = new Map<string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  best.set(keyOf(level.boxes, reach(level, occupied, level.player, seen, ++stamp, stack)), 0);
  for (const b of level.boxes) occupied[b] = 0;

  // Binary heap on [f, h, insertion order, state]; ties break toward the lower h, then the earlier state.
  const heap: [number, number, number, number][] = [];
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  const h0 = astar ? heuristic(level.boxes, dist) : 0;
  if (h0 === Infinity) return null;
  let order = 0;
  heapPush([h0, h0, order++, 0]);
  let expanded = 0;
  let found = -1;
  while (heap.length > 0) {
    const [, , , s] = heapPop();
    const boxes = statesBoxes[s]!;
    const g = statesG[s]!;
    for (const b of boxes) occupied[b] = 1;
    const low = reach(level, occupied, statesPlayer[s]!, seen, ++stamp, stack);
    if (best.get(keyOf(boxes, low)) !== g) {
      for (const x of boxes) occupied[x] = 0;
      continue;
    }
    if (expanded >= maxExpansions) {
      for (const x of boxes) occupied[x] = 0;
      return null;
    }
    expanded++;
    const here = stamp;
    let stop = false;
    for (let bi = 0; bi < boxes.length && !stop; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let next: number[] | null = null;
        let key = -1;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, reach(level, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null || best.has(key)) continue;
        best.set(key, g + 1);
        const h = astar ? heuristic(next, dist) : 0;
        if (h === Infinity) continue;
        const ns = statesBoxes.length;
        statesBoxes.push(next);
        statesPlayer.push(b);
        statesG.push(g + 1);
        parent.push(s);
        if (solved(next)) {
          found = ns;
          stop = true;
          break;
        }
        heapPush([g + 1 + h, h, order++, ns]);
      }
    }
    for (const x of boxes) occupied[x] = 0;
    if (stop) break;
  }
  if (found < 0) return null;
  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const nextBoxes = statesBoxes[s]!;
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a
 * box there reaches no goal) out of the floor, and each part left that holds a
 * box is a room. Null when some part holds more or fewer boxes than goals, or
 * a box starts in the hallway: then the level is no set of rooms.
 */
function roomsOf(level: Level): { squares: number[]; boxes: number[]; goals: number[]; done: boolean }[] | null {
  const { w, wall, goals, boxes, player } = level;
  const { live } = pushDistances(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { squares: number[]; boxes: number[]; goals: number[]; done: boolean }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

const endOf = (w: number, from: number, moves: string): number => {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
};

/**
 * Solve a level room by room: each room's push-optimal solution in turn, the
 * other rooms' boxes standing as walls (on their goals once their room is
 * done), the player walking on from where the last room left it. Falls back to
 * one search over the whole level when it is no set of rooms.
 */
function solveLevel(level: Level): string {
  const rooms = roomsOf(level);
  if (rooms === null) {
    const whole = solvePushOptimal(level, MAX_EXPANSIONS_WHOLE) ?? solvePushOptimal(level, SEARCH_STATES, false);
    return whole === null ? '' : whole.moves;
  }
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms)
      if (other !== room) for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushOptimal(sub, MAX_EXPANSIONS) ?? solvePushOptimal(sub, SEARCH_STATES, false);
    if (solved === null) return '';
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8')));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
