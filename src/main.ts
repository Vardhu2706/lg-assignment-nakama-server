/// <reference path="../node_modules/nakama-runtime/index.d.ts" />

// ======================================================
// INIT MODULE (ENTRYPOINT)
// ======================================================

function InitModule(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  initializer: nkruntime.Initializer
) {
  logger.info("🚀 Nakama module initialized");

  initializer.registerRpc("healthcheck", healthcheck);
  initializer.registerRpc("whoami", whoAmI);
  initializer.registerRpc("create_match", createMatchRpc);
  initializer.registerRpc("get_player_stats", getPlayerStatsRpc);
  initializer.registerRpc("get_leaderboard_wins", getLeaderboardWinsRpc);

  ensureLeaderboard(nk, logger);

  initializer.registerMatch(MATCH_NAME, {
    matchInit,
    matchJoinAttempt,
    matchJoin,
    matchLeave,
    matchLoop,
    matchTerminate,
    matchSignal,
  });
}

// ======================================================
// TYPES
// ======================================================

const MAX_PLAYERS = 2;
const OP_STATE = 1;
const OP_MOVE = 2;
const OP_REQUEST_SYNC = 3;

type EndReason = "none" | "line" | "draw" | "abandonment";

type GameState = {
  playerIds: string[];
  playerNames: string[];
  board: number[];
  currentTurnIndex: number;
  phase: "lobby" | "playing" | "finished";
  result: number;
  endReason: EndReason;
  statsRecorded: boolean;
};

// ======================================================
// LOGGER UTILS
// ======================================================

function logInfo(logger: nkruntime.Logger, msg: string) {
  logger.info(`[INFO] ${msg}`);
}

function logDebug(logger: nkruntime.Logger, msg: string) {
  logger.debug(`[DEBUG] ${msg}`);
}

// ======================================================
// GAME HELPERS
// ======================================================

function emptyBoard(): number[] {
  return [0, 0, 0, 0, 0, 0, 0, 0, 0];
}

function isUuidLikeString(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s.trim()
  );
}

function userAccountDisplayName(u: nkruntime.User): string {
  const raw = u as unknown as {
    displayName?: string;
    display_name?: string;
  };
  return String(raw.displayName || raw.display_name || "").trim();
}

function resolveDisplayNameForJoin(
  nk: nkruntime.Nakama,
  userId: string,
  _presenceUsername: string
): string {
  try {
    const users = nk.usersGetId([userId]);
    if (users && users.length > 0) {
      const dn = userAccountDisplayName(users[0]);
      if (dn) {
        return dn;
      }
    }
  } catch {
  }
  return "Player";
}

function matchHostLabel(
  nk: nkruntime.Nakama,
  ctx: nkruntime.Context,
  params: { [key: string]: any }
): string {
  const raw =
    params && typeof params.creator === "string"
      ? String(params.creator).trim()
      : "";
  if (raw && raw !== "unknown") {
    return raw;
  }
  if (ctx.userId) {
    return resolveDisplayNameForJoin(nk, ctx.userId, ctx.username || "");
  }
  return "Player";
}

function cloneGameState(state: GameState): GameState {
  return {
    playerIds: state.playerIds.slice(),
    playerNames: state.playerNames.slice(),
    board: state.board.slice(),
    currentTurnIndex: state.currentTurnIndex,
    phase: state.phase,
    result: state.result,
    endReason: state.endReason,
    statsRecorded: state.statsRecorded === true,
  };
}

function publicState(s: GameState): Record<string, unknown> {
  return {
    board: s.board,
    playerIds: s.playerIds,
    playerNames: s.playerNames,
    currentTurnIndex: s.currentTurnIndex,
    phase: s.phase,
    result: s.result,
    endReason: s.endReason,
  };
}

function broadcastState(
  dispatcher: nkruntime.MatchDispatcher,
  state: GameState
): void {
  dispatcher.broadcastMessage(
    OP_STATE,
    JSON.stringify(publicState(state)),
    null,
    null,
    true
  );
}

function checkLineWinner(board: number[]): number {
  const lines: number[][] = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ];
  for (const [a, b, c] of lines) {
    const v = board[a];
    if (v !== 0 && v === board[b] && v === board[c]) {
      return v;
    }
  }
  return 0;
}

function boardFull(board: number[]): boolean {
  return board.every((c) => c !== 0);
}

function resultFromBoardIfDecided(board: number[]): number | null {
  const lineWin = checkLineWinner(board);
  if (lineWin !== 0) {
    return lineWin === 1 ? 1 : 2;
  }
  if (boardFull(board)) {
    return 3;
  }
  return null;
}

// ======================================================
// PLAYER STATS (user storage)
// ======================================================

const STATS_COLLECTION = "ttt_stats";
const STATS_KEY = "summary";
const LEADERBOARD_ID = "ttt_wins";

type StatsValue = {
  wins: number;
  losses: number;
  matchesPlayed: number;
  winStreak: number;
};

function defaultStats(): StatsValue {
  return { wins: 0, losses: 0, matchesPlayed: 0, winStreak: 0 };
}

function readUserStats(
  nk: nkruntime.Nakama,
  userId: string
): { stats: StatsValue; version: string } {
  const reads: nkruntime.StorageReadRequest[] = [
    { collection: STATS_COLLECTION, key: STATS_KEY, userId },
  ];
  const rows = nk.storageRead(reads);
  if (!rows || rows.length === 0) {
    return { stats: defaultStats(), version: "" };
  }
  const obj = rows[0];
  const v = obj.value as Record<string, unknown>;
  const stats: StatsValue = {
    wins: Number(v.wins) || 0,
    losses: Number(v.losses) || 0,
    matchesPlayed: Number(v.matchesPlayed) || 0,
    winStreak: Number(v.winStreak) || 0,
  };
  return { stats, version: obj.version };
}

function writeUserStats(
  nk: nkruntime.Nakama,
  userId: string,
  stats: StatsValue,
  version: string
): void {
  const write: nkruntime.StorageWriteRequest = {
    collection: STATS_COLLECTION,
    key: STATS_KEY,
    userId,
    value: {
      wins: stats.wins,
      losses: stats.losses,
      matchesPlayed: stats.matchesPlayed,
      winStreak: stats.winStreak,
    },
  };
  if (version) {
    write.version = version;
  }
  nk.storageWrite([write]);
}

function ensureLeaderboard(nk: nkruntime.Nakama, logger: nkruntime.Logger): void {
  try {
    nk.leaderboardCreate(
      LEADERBOARD_ID,
      true,
      "descending" as nkruntime.SortOrder,
      "set" as nkruntime.Operator,
      null,
      null,
      true
    );
    logInfo(logger, `Leaderboard ${LEADERBOARD_ID} created`);
  } catch (e) {
    logInfo(logger, `Leaderboard ensure: ${String(e)}`);
  }
}

function leaderboardDisplayName(nk: nkruntime.Nakama, userId: string): string {
  try {
    const users = nk.usersGetId([userId]);
    if (users && users.length > 0) {
      const dn = userAccountDisplayName(users[0]);
      if (dn) return dn;
    }
  } catch {
  }
  return "";
}

function syncLeaderboardWins(nk: nkruntime.Nakama, userId: string): void {
  const { stats } = readUserStats(nk, userId);
  const username = leaderboardDisplayName(nk, userId);
  nk.leaderboardRecordWrite(
    LEADERBOARD_ID,
    userId,
    username || undefined,
    stats.wins,
    0,
    undefined,
    "set" as nkruntime.OverrideOperator
  );
}

function recordFinishedMatchStats(
  nk: nkruntime.Nakama,
  logger: nkruntime.Logger,
  playerA: string,
  playerB: string,
  result: number
): void {
  if (result === 3) {
    for (const uid of [playerA, playerB]) {
      const { stats, version } = readUserStats(nk, uid);
      stats.matchesPlayed += 1;
      stats.winStreak = 0;
      writeUserStats(nk, uid, stats, version);
    }
    logDebug(logger, `Stats: draw recorded for ${playerA}, ${playerB}`);
    return;
  }
  const winnerId = result === 1 ? playerA : playerB;
  const loserId = result === 1 ? playerB : playerA;
  {
    const { stats, version } = readUserStats(nk, winnerId);
    stats.wins += 1;
    stats.matchesPlayed += 1;
    stats.winStreak += 1;
    writeUserStats(nk, winnerId, stats, version);
  }
  {
    const { stats, version } = readUserStats(nk, loserId);
    stats.losses += 1;
    stats.matchesPlayed += 1;
    stats.winStreak = 0;
    writeUserStats(nk, loserId, stats, version);
  }
  try {
    syncLeaderboardWins(nk, winnerId);
  } catch (e) {
    logInfo(logger, `Leaderboard sync failed: ${String(e)}`);
  }
  logDebug(logger, `Stats: win recorded winner=${winnerId} loser=${loserId}`);
}

function recordAbandonmentStats(
  nk: nkruntime.Nakama,
  logger: nkruntime.Logger,
  winnerId: string,
  loserId: string
): void {
  {
    const { stats, version } = readUserStats(nk, winnerId);
    stats.wins += 1;
    stats.matchesPlayed += 1;
    stats.winStreak += 1;
    writeUserStats(nk, winnerId, stats, version);
  }
  {
    const { stats, version } = readUserStats(nk, loserId);
    stats.losses += 1;
    stats.matchesPlayed += 1;
    stats.winStreak = 0;
    writeUserStats(nk, loserId, stats, version);
  }
  try {
    syncLeaderboardWins(nk, winnerId);
  } catch (e) {
    logInfo(logger, `Leaderboard sync failed: ${String(e)}`);
  }
  logDebug(logger, `Stats: abandonment winner=${winnerId} loser=${loserId}`);
}

// ======================================================
// RPCs
// ======================================================

function healthcheck(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  logInfo(logger, "Healthcheck called");
  return JSON.stringify({
    status: "ok",
    timestamp: Date.now(),
  });
}

function whoAmI(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  logInfo(logger, `whoAmI called for user: ${ctx.userId}`);
  return JSON.stringify({
    userId: ctx.userId,
    username: ctx.username,
  });
}

function createMatchRpc(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  let listing: "quick" | "custom" = "custom";
  if (payload && payload.length > 0) {
    try {
      const p = JSON.parse(payload) as { listing?: string };
      if (p.listing === "quick") {
        listing = "quick";
      }
    } catch {
    }
  }

  const hostLabel = ctx.userId
    ? resolveDisplayNameForJoin(nk, ctx.userId, ctx.username || "")
    : "Player";
  const matchId = nk.matchCreate(MATCH_NAME, {
    creator: hostLabel,
    pool: listing,
  });
  logger.info(`Match created via RPC (${listing} → ${MATCH_NAME}): ${matchId}`);
  return JSON.stringify({ matchId });
}

function getPlayerStatsRpc(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  if (!ctx.userId) {
    return JSON.stringify({ error: "unauthorized" });
  }
  const { stats } = readUserStats(nk, ctx.userId);
  return JSON.stringify(stats);
}

function getLeaderboardWinsRpc(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  const limit = 10;
  const list = nk.leaderboardRecordsList(LEADERBOARD_ID, undefined, limit);
  const records = list.records || [];
  const rows = records.map((r) => ({
    rank: r.rank,
    username: r.username || "Player",
    score: r.score,
    ownerId: r.ownerId,
  }));
  return JSON.stringify({ records: rows });
}

// ======================================================
// MATCH HANDLER
// ======================================================

const MATCH_NAME = "default_match";

function matchInit(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  params: { [key: string]: any }
): { state: GameState; tickRate: number; label: string } {
  logInfo(logger, "Match initialized");
  const baseLabel = matchHostLabel(nk, ctx, params);
  const pool: "quick" | "custom" =
    params && params.pool === "quick" ? "quick" : "custom";
  const label = pool === "quick" ? `qp|${baseLabel}` : `cu|${baseLabel}`;

  const state: GameState = {
    playerIds: [],
    playerNames: [],
    board: emptyBoard(),
    currentTurnIndex: 0,
    phase: "lobby",
    result: 0,
    endReason: "none",
    statsRecorded: false,
  };

  return {
    state,
    tickRate: 10,
    label,
  };
}

function matchJoinAttempt(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: GameState,
  presence: nkruntime.Presence
): { state: GameState; accept: boolean; rejectMessage?: string } {
  logDebug(logger, `Join attempt: ${presence.userId}`);
  if (state.playerIds.length >= MAX_PLAYERS) {
    return {
      state,
      accept: false,
      rejectMessage: "Match is full",
    };
  }
  return { state, accept: true };
}

function matchJoin(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: GameState,
  presences: nkruntime.Presence[]
): { state: GameState } {
  let ids = state.playerIds.slice();
  let names = state.playerNames.slice();
  while (names.length < ids.length) {
    names.push("Player");
  }
  while (names.length > ids.length) {
    names.pop();
  }
  for (const p of presences) {
    if (ids.length < MAX_PLAYERS && ids.indexOf(p.userId) === -1) {
      ids.push(p.userId);
      names.push(resolveDisplayNameForJoin(nk, p.userId, p.username));
    }
  }

  const next: GameState = cloneGameState(state);
  next.playerIds = ids;
  next.playerNames = names;

  if (ids.length === 2 && next.phase === "lobby") {
    next.phase = "playing";
  }

  logInfo(logger, `Players joined batch: ${presences.length}, total: ${ids.length}`);
  broadcastState(dispatcher, next);
  return { state: next };
}

function matchLeave(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: GameState,
  presences: nkruntime.Presence[]
): { state: GameState } | null {
  const leaving = new Set(presences.map((p) => p.userId));
  const pairs = state.playerIds.map((id, i) => ({
    id,
    name:
      state.playerNames[i] !== undefined && state.playerNames[i] !== ""
        ? state.playerNames[i]
        : "Player",
  }));
  const kept = pairs.filter((p) => !leaving.has(p.id));
  const ids = kept.map((p) => p.id);
  const names = kept.map((p) => p.name);

  const next: GameState = cloneGameState(state);
  next.playerIds = ids;
  next.playerNames = names;

  if (ids.length === 0) {
    next.phase = "finished";
    next.endReason = "none";
  } else if (
    state.playerIds.length === 2 &&
    ids.length === 1 &&
    state.phase === "finished"
  ) {
  } else if (
    state.phase === "playing" &&
    ids.length === 1 &&
    state.playerIds.length === 2
  ) {
    const terminal = resultFromBoardIfDecided(state.board);
    if (terminal !== null) {
      next.phase = "finished";
      next.result = terminal;
      next.endReason = terminal === 3 ? "draw" : "line";
      const a = state.playerIds[0];
      const b = state.playerIds[1];
      if (a && b && !next.statsRecorded) {
        try {
          recordFinishedMatchStats(nk, logger, a, b, terminal);
        } catch (e) {
          logInfo(logger, `Stats match record failed: ${String(e)}`);
        }
        next.statsRecorded = true;
      }
    } else {
      next.phase = "finished";
      const remaining = ids[0];
      const idx = state.playerIds.indexOf(remaining);
      next.result = idx === 0 ? 1 : 2;
      next.endReason = "abandonment";
      const loserId = Array.from(leaving).find((id) => state.playerIds.indexOf(id) >= 0);
      if (loserId && remaining && !next.statsRecorded) {
        try {
          recordAbandonmentStats(nk, logger, remaining, loserId);
          next.statsRecorded = true;
        } catch (e) {
          logInfo(logger, `Stats abandonment record failed: ${String(e)}`);
          next.statsRecorded = true;
        }
      }
    }
  }

  logInfo(logger, `Players left: ${presences.length}, remaining: ${ids.length}`);
  broadcastState(dispatcher, next);
  if (ids.length === 0) {
    return null;
  }
  return { state: next };
}

function matchLoop(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: GameState,
  messages: nkruntime.MatchMessage[]
): { state: GameState } | null {
  let next = cloneGameState(state);

  if (next.phase === "finished" && next.playerIds.length === 0) {
    return null;
  }

  for (const msg of messages) {
    if (msg.opCode === OP_REQUEST_SYNC) {
      broadcastState(dispatcher, next);
      continue;
    }

    if (msg.opCode !== OP_MOVE) {
      continue;
    }

    if (next.phase !== "playing") {
      logDebug(logger, "Move ignored: not playing");
      continue;
    }

    let payload: { index?: number };
    try {
      const text = nk.binaryToString(msg.data);
      payload = JSON.parse(text);
    } catch (e) {
      logDebug(logger, "Bad move payload");
      continue;
    }

    const index = payload.index;
    if (
      typeof index !== "number" ||
      index < 0 ||
      index > 8 ||
      Math.floor(index) !== index
    ) {
      continue;
    }

    const senderIdx = next.playerIds.indexOf(msg.sender.userId);
    if (senderIdx === -1) {
      continue;
    }

    if (senderIdx !== next.currentTurnIndex) {
      logDebug(logger, "Move ignored: wrong turn");
      continue;
    }

    if (next.board[index] !== 0) {
      continue;
    }

    const mark = senderIdx === 0 ? 1 : 2;
    const newBoard = next.board.slice();
    newBoard[index] = mark;

    let result = next.result;
    let phase: GameState["phase"] = next.phase;
    let currentTurnIndex = next.currentTurnIndex;

    let endReason: EndReason = next.endReason;
    const lineWin = checkLineWinner(newBoard);
    if (lineWin !== 0) {
      phase = "finished";
      result = lineWin === 1 ? 1 : 2;
      endReason = "line";
    } else if (boardFull(newBoard)) {
      phase = "finished";
      result = 3;
      endReason = "draw";
    } else {
      currentTurnIndex = next.currentTurnIndex === 0 ? 1 : 0;
    }

    next = {
      playerIds: next.playerIds.slice(),
      playerNames: next.playerNames.slice(),
      board: newBoard,
      currentTurnIndex,
      phase,
      result,
      endReason,
      statsRecorded: next.statsRecorded,
    };

    if (phase === "finished" && !next.statsRecorded) {
      const a = next.playerIds[0];
      const b = next.playerIds[1];
      if (a && b) {
        try {
          recordFinishedMatchStats(nk, logger, a, b, result);
        } catch (e) {
          logInfo(logger, `Stats match record failed: ${String(e)}`);
        }
        next.statsRecorded = true;
      }
    }

    broadcastState(dispatcher, next);
  }

  return { state: next };
}

function matchTerminate(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: GameState
): { state: GameState } {
  logInfo(logger, "Match terminated");
  return { state };
}

function matchSignal(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: GameState,
  data: string
): { state: GameState; data?: string } {
  logDebug(logger, "Match signal received");
  return { state };
}

// @ts-ignore
InitModule = InitModule;
