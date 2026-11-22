# Sokoban solver — 16 boxes, 4 rooms, 0 wasted pushes

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Jo3st4r/sokoban-solver-01-bot/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Jo3st4r/sokoban-solver-01-bot/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver in one TypeScript file (`main.ts`, Node 22, no
dependencies). It answers every instance of a set in one run, writing
`/output/<id>/solution.txt` for each.

## How it works

Levels here are a 1-wide hallway with 1–4 rooms off it, and a box pushed out
of a room can never be pushed back — so every box stays in its room and a
level's push-optimal count is the sum of its rooms' optima. The solver splits
each level into rooms (dead squares of the player's row are cut out of the
floor), then solves each room on its own from its door and stitches the move
strings together.

Each room is solved with A* over **pushes**, not steps: a state is the boxes
plus the player's reachable region, so states that differ only in where the
player stands inside one region count as one. The search prunes dead squares
(a box that can never reach a goal, found by pulling back from the goals) and
frozen 2×2 blocks, and is guided by an admissible heuristic — the cheapest
assignment of boxes to goals by push-distance (exact min-cost matching for
≤ 6 boxes). The first solution found is therefore push-optimal. If A* ever
gives up on a room, the same code falls back to a plain breadth-first search
over pushes.

## Results

- Practice set: **1,000,000** — every instance solved in exactly P* pushes
  (13, 16, 29, 47, 60). The house baseline (plain-astar 1.0.0) scores
  200,000 on the same set.
- Three freshly drawn sets (other drand rounds, same generator): **1,000,000**
  each — 20 of 20 instances push-optimal.
- Whole-set runtime ≈ 0.2–0.3 s (limit 60 s); two runs write byte-identical
  outputs. The budget is a work cap (an expansion count), never the clock.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License

MIT — see [LICENSE](LICENSE).
