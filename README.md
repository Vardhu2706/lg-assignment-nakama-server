# Lila Games — Tic-Tac-Toe (Nakama server)

TypeScript [Nakama](https://heroiclabs.com/docs/nakama/) server module for a real-time two-player tic-tac-toe game: authoritative match state, RPCs for match creation and stats, and a wins leaderboard.

## Features

- **Authoritative match** (`default_match`) — board state, turns, win/draw detection, abandonment handling
- **RPCs** — `healthcheck`, `whoami`, `create_match`, `get_player_stats`, `get_leaderboard_wins`
- **Listings** — quick vs custom matches via `create_match` payload (`listing: "quick"` or default custom); match labels use `qp|` / `cu|` prefixes for discovery
- **Persistence** — per-user stats in storage (`ttt_stats` / `summary`) and leaderboard `ttt_wins` (score = total wins)

## Requirements

- **Node.js** (for building; LTS recommended)
- **Nakama** 3.x with JavaScript runtime enabled — see [Nakama JavaScript runtime](https://heroiclabs.com/docs/nakama/server-framework/javascript-runtime/)

## Setup

```bash
npm install
```

## Build

Compiles `src/main.ts` to a single AMD bundle for Nakama:

```bash
npm run build
```

Output: `build/index.js` (configure Nakama to load this module — see your Nakama deployment docs for `runtime.path` / module layout).

## Local development

1. Build the module (`npm run build`).
2. Point your Nakama server at the built `build/` output (or copy `build/index.js` into your Nakama data modules directory as required by your install).
3. Restart Nakama and connect a client using the same project keys and RPC/match names as in `src/main.ts`.

## Project layout

| Path | Purpose |
|------|---------|
| `src/main.ts` | Module entry (`InitModule`), RPCs, match handler |
| `tsconfig.json` | TypeScript → single `build/index.js` (AMD) |
| `package.json` | `nakama-runtime` types from [heroiclabs/nakama-common](https://github.com/heroiclabs/nakama-common) |

## License

ISC (see `package.json`).
