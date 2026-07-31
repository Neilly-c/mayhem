# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ユーザーへの応答

日本語で出力する。

## Commands

- `npm run dev` — start the Vite dev server with HMR
- `npm run build` — type-check via `tsc -b` (project references across `tsconfig.app.json` / `tsconfig.node.json`) then production-build with Vite
- `npm run lint` — run ESLint over the whole repo
- `npm run preview` — serve the production build locally
- `npm run test` — run the Vitest suite once (`vitest run`); tests live alongside each module under `__tests__/`
- `npm run train` — run the PPO self-play training CLI (`src/train/trainPPO.ts` via `tsx`); see flags in that file's header comment
- `npm run typecheck:train` — type-check `src/train/` on its own Node-flavored `tsconfig.train.json` (excluded from the main `tsc -b`/`vite build`)
- `npm run typecheck:bridge` — type-check `src/bridge/` on its own Node-flavored `tsconfig.bridge.json` (also excluded from the main build)
- `python training-py/train_ppo.py [flags]` — run the Node↔Python PPO training CLI (see that file's header comment); requires a `training-py/.venv` with `pip install -r training-py/requirements.txt` first (install `torch` from the CUDA index yourself first if you want GPU — see the comment at the top of `requirements.txt`)

## Architecture

A battle-royale-style hex-grid simulation ("mayhem") with a headless deterministic sim core, a Gym/PettingZoo-style RL environment wrapping it, scripted/decision-tree bots, and a canvas-based React UI for observing/replaying episodes. No router or state-management library — plain React + TSX for the UI shell.

- `src/main.tsx` — entry point, mounts `<App />` into `#root` inside `React.StrictMode`
- `src/App.tsx` — top-level component: wires `useSimulationLoop` to `SimulationCanvas`, `ControlPanel`, and `DebugPanel`
- `src/App.css` / `src/index.css` — styles, using CSS custom properties (`--text`, `--bg`, `--accent`, etc.) defined in `:root` in `index.css`, with dark mode via `@media (prefers-color-scheme: dark)` overriding the same variables

### `src/sim/` — headless deterministic simulation core

Owns no DOM/React state; `GameState` is plain, JSON-serializable data. Entry point is the `Simulation` class (`sim.ts`), created via `Simulation.create(seed, overrides)`.

- `hexgrid.ts` — axial/cube coordinate math, the 6 neighbor `DIRECTIONS`
- `mapgen.ts` / `noise.ts` — procedural map generation (elevation, passable/wall nodes)
- `entities.ts` — team and unit creation. ユーザー要望: チーム同士の初期配置が接近し過ぎないよう、`teamId`昇順で先頭2チーム(`centerTeamCount = min(2, teamCount)`)はマップ中央付近、残りは外周付近へスポーンする — どちらも中心からの方位を自分のグループ内で均等分割したセクタごとに、中央組は「セクタ内で中心に最も近いノード」、外周組は「セクタ内で中心から最も遠いノード」を選ぶ(`teamCount<=2`なら全チームが中央組扱いになり、外周組の周方向分割は行われない)
- `movement.ts`, `combat.ts`, `pathfinding.ts` — per-tick movement and combat intent/resolution. `computeCombatIntents` returns an array (not a single nullable intent): the main hit plus, if `chainDamageRadius`/`chainDamageCoef` are nonzero, a flat `chainDamageCoef`-multiplied chain-damage hit on every other enemy within `chainDamageRadius` of the target (a clustering penalty) — all entries share the same `attackerId`/shape, so reward/kill attribution in `env/rewards.ts` needs no special-casing for chain hits.
- `territory.ts` — node ownership/capture resolution
- `ring.ts` — the shrinking "safe zone" ring (stage schedule, warn→shrink phases, next-center selection, slip damage for units outside the ring). `ringRadiusSchedule` (the per-stage safe radii) is always taken as-is from `SimConfig`, never randomized. The randomness lives entirely in next-center selection (`pickNextCenter`/`pickRandomNodeWithinRadius`, seeded from `state.seed`): each new center is drawn from passable nodes within `oldRadius - newRadius` of the previous center, which guarantees the new safe circle stays fully inside the old one at every point during the shrink interpolation (not just at the endpoints) — see the proof in `pickNextCenter`'s doc comment.
- `regen.ts` — HP/resource regeneration
- `rules.ts` — win/game-over conditions
- `spatial.ts` — world-position helpers for nodes/units
- `rng.ts` — seeded, deterministic RNG (`deriveRng`, `randInt`, etc.) — all randomness in `sim/` must go through this for reproducible episodes
- `config.ts` / `types.ts` — `SimConfig` defaults and shared sim types
- `Simulation.step()` runs a two-phase update per tick (movement → combat → territory → ring → death resolution), applied in `(teamId, unitId)` order over a snapshot of `alive` units taken at tick start, so results don't depend on iteration order

### `src/env/` — RL environment

Gym/PettingZoo (Parallel)-style wrapper around `sim/`, one agent per surviving unit. `Env` holds no shared mutable state beyond one `Simulation` instance, so multiple instances can be run in parallel to vectorize.

- `env.ts` — `Env` class: `reset`/`step` over the wrapped `Simulation`
- `observation.ts` — builds each agent's `Observation` (local hex patch, `patchHops` radius)
- `visibility.ts` — visible-enemy computation
- `actions.ts` — `ActionInput` decoding and action masking. `decodeAction`'s move=0 decodes to `{ type: 'moveTo', node: selfNode }` (hold position), not `{ type: 'idle' }` — `sim/movement.ts`'s idle is a random-explore fallback for uncommanded units, not a "stay put" primitive, so an RL agent selecting the naive "idle" index could never actually hold a node long enough to satisfy `territory.ts`'s `captureTicks` for taking an enemy-owned node. `moveTo` targeting the unit's own current node is the same "hold" idiom `raiderBot.ts` already uses while engaging.
- `rewards.ts` / `rewardConfig.ts` — per-tick and terminal (winner bonus) reward shaping
- `types.ts` — `Observation`, `ActionInput`, `StepResult`, etc.

### `src/agents/` — bot policies

Non-RL decision sources that can be routed per team via `createTeamRoutedDecisionSource` (`teamAssignment.ts`, `BotKind`: `'expander' | 'guardian' | 'raider'`). ユーザー要望: 陣営の目的がマップ占領率(§`sim/rules.ts`の`teamTerritoryRate`/`getTerritoryRanking`)になったことに合わせて刷新した3つの簡易ヒューリスティックbot(旧`scriptedBot`/`decisionTreeBot`/`survivalBot`は全廃)。`assignment`に無いチームは`defaultBotKindForTeam`(`BOT_KINDS`を`teamId % 3`で巡回)を既定bot とする — UIの per-team ドロップダウンの初期表示もこれに合わせる。

- `expanderBot.ts` — 拡張型: 戦闘を避け、`findNearestUnclaimedNode`(中立優先BFS)でひたすら未所有ノードを塗り続ける。反撃のみ行い追撃はしない。
- `guardianBot.ts` — 防衛型(`GuardianBotConfig`): リング退避 → 低HP時は自陣へ帰還して回復 → 敵の攻撃範囲に入られた自陣ノードがあればそこへ急行して防衛 → それ以外は拡張。奪った領地を守ることを最優先する。
- `raiderBot.ts` — 攻撃型: リング退避 → 射程内の敵とは静止して交戦 → 視認中(射程外)の敵がいれば追撃 → いなければ拡張。低HPで退く判断を持たない攻めっ気重視の性格。
- `movementHelpers.ts` — 3botが共有する移動判断ユーティリティ(`pickBestDirection`, `findNearestSafeNode`, `findNearestUnclaimedNode`, `findNearestOwnNode`)
- `types.ts` — `UnitDecision`, `DecisionSource`

### `src/train/` — PPO self-play training pipeline (Node-only, excluded from the browser build)

Pure TypeScript + `@tensorflow/tfjs` (the pure-JS/CPU-backend package, **not** `@tensorflow/tfjs-node`: this repo's dev machine has no C++ toolchain, so `tfjs-node`'s native bindings can't be built — see the "no `file://` IOHandler" comment in `network.ts` for the consequence). Runs headless via `tsx` (`npm run train`), reusing `sim`/`env` unmodified. A single shared-weights actor-critic policy controls every team (§11.1 self-play via weight sharing); no opponent league/checkpoint-pool in this version (`rolloutBuffer.ts`'s `RolloutState` is structured so one could be added later without a rewrite). Training runs at a fixed `teamCount:6, unitsPerTeam:3` (`curriculum.ts`) — this is a training-pipeline-local default, not a change to `sim/config.ts`'s `defaultConfig()`.

- `types.ts` — shared types (`TrainConfig`, `PPOConfig`, `NetworkConfig`, `RolloutBatch`, `CheckpointMeta`, `EvalReport`)
- `gae.ts` — pure-math Generalized Advantage Estimation, one segment per unit "life" (dies at most once, at the end)
- `network.ts` — `ActorCriticModel`: shared MLP trunk → move-logits/attack-logits/value heads. Owns a hand-rolled Node `IOHandler` for save/load (see above)
- `actionSampling.ts` — masked-categorical sampling/evaluation/argmax for the move and attack heads, via an additive `(mask-1)*1e9` logit bias (float-safe — avoids the `0 * -Infinity = NaN` trap of a raw `-Infinity` bias)
- `shapes.ts` — `inferObsDim`: derives the observation vector length by actually building a throwaway `Env` rather than duplicating `observation.ts`'s size formula
- `rolloutBuffer.ts` — drives multiple `Env` instances in lockstep (batched forward passes, not real threads), auto-resets an env on game-over *or* `maxTicks` truncation, bootstraps still-open segments via an extra critic-only forward pass
- `ppo.ts` — the clipped-surrogate PPO update; nesting `tf.tidy` inside `tf.variableGrads`'s loss closure is safe (verified empirically — the engine protects tensors the gradient tape depends on), which is what keeps this file's manual tensor disposal manageable
- `policyDecisionSource.ts` — bridges a trained model into the same `DecisionSource` shape as `src/agents`' bots, for evaluation and (potentially, not yet wired) browser-side play
- `evaluate.ts` — plays the policy against each baseline bot directly via `Simulation` (not `Env` — reward shaping is irrelevant to win rate) and reports win rate / average rank
- `checkpoint.ts` / `logger.ts` / `curriculum.ts` — save/load (model + a `meta.json` sidecar TF's own `model.json` doesn't carry, now including a `score: number | null` field — mean win rate across baseline-bot matchups, `null` if unevaluated), stdout+JSONL logging, and the `mapRadius`-only curriculum (`teamCount`/`unitsPerTeam`/`maxVisibleEnemies`/`patchHops` must stay fixed for a run — they determine the network's input/output shape)
- `checkpointPruning.ts` — ユーザー要望: `checkpointDir`直下のチェックポイントを無制限に増やさない。`trainPPO.ts`はチェックポイント保存の直後に毎回`pruneCheckpoints`を呼び、最新1件(常に保護)+`meta.json`の`score`降順で上位`--keepTopNCheckpoints`件(既定3)だけを残して残りのディレクトリを削除する。間引きにスコアが要るため、`trainPPO.ts`はチェックポイント保存の周期(`--checkpointEvery`)がeval周期(`--evalEvery`)とずれていても、保存のたびに必ずevalを実行してから`score`を確定させる。間引き直後、`replayWriter.ts`の`pruneReplays`を生き残ったチェックポイントの反復回数集合で呼び、`public/replays`側にも対になる間引きをかける — ブラウザの学習リプレイ一覧(`TrainingReplayPanel.tsx`)には常に現存するチェックポイント世代のリプレイだけが並ぶ。
- `trainPPO.ts` — CLI entrypoint wiring the above into the main collect→update→eval→checkpoint→prune loop

### `src/bridge/` — Node↔Python PPO training bridge (Node-only, excluded from the browser build)

The TS `Simulation`/`Env` stay the single source of truth for game ticks — nothing here reimplements sim logic. `training-py/`'s PyTorch trainer drives these Node subprocesses over stdio to get GPU-accelerated learning while every actual tick still runs through the real TS engine, so replays it records are byte-identical in shape to ones `src/train/`'s pure-TS pipeline produces (same `src/app/replay.ts` `LoggedDecision[]` format, playable in the same browser UI).

- `protocol.ts` — NDJSON-over-stdio wire protocol (`init`/`reset`/`step`/`resolveSimConfig`/`shutdown` message types) + a line-buffered `NdjsonDecoder`
- `envWorker.ts` — the actual subprocess entrypoint (`tsx src/bridge/envWorker.ts`), holds a shard of `Env` instances and answers protocol requests; stdout is reserved *exclusively* for protocol frames (logs go to stderr). No forward/backward pass ever runs here — it's a pure simulation server; the neural net lives entirely in Python
- `evalAndReplay.ts` — CLI Python shells out to for periodic eval/replay, wrapping `src/train/`'s unchanged `loadCheckpoint`/`evaluateAgainstBots`/`recordReplay`/`recordSelfPlayReplay`/`saveReplay` so that logic is never duplicated in Python. `replay --opponent selfPlay` (also `--replayOpponent selfPlay` on `trainPPO.ts`/`--replay-opponent selfPlay` on `train_ppo.py`) records **all** teams following the checkpoint's policy against each other — the same configuration actual training rollouts use — instead of `recordReplay`'s team-0-vs-baseline-bot matchup; ユーザー要望: baseline botとの対戦だけでは自己対戦中の実際の挙動(例えば「特定チームが有利に見える」といった観察)を切り分けて検証できないため。
- `verifyExport.ts` — CLI with two subcommands (`template`, `verify`) used only by `training-py`'s checkpoint-export correctness test: generates the canonical TF.js checkpoint template (topology/weightsManifest) that Python's weight export slots into, and loads+forwards an exported checkpoint for cross-language numeric verification
- `src/env/env.ts`'s exported `buildActionMasksForEnv(env)` (a standalone function, not an `Env` method) is the shared workaround both `src/train/rolloutBuffer.ts` and `envWorker.ts` use for the fact that `Env.reset()` only returns observations, not action masks — `Env`'s public API itself is deliberately untouched

### `training-py/` — Python/PyTorch side of the bridge (top-level, not under `src/`; own venv, `requirements.txt`)

A structural 1:1 port of `src/train/{gae,network,actionSampling,ppo,rolloutBuffer}.ts` into `mayhem_rl/{gae,network,action_sampling,ppo,rollout_buffer}.py`, with `Env` calls replaced by `mayhem_rl/bridge/worker_pool.py`'s `WorkerPool` (spawns and shards env-stepping across multiple `envWorker.ts` subprocesses for real multi-core parallelism, since Node is single-threaded per process) and PyTorch replacing TF.js (autograd manages tensor memory automatically — the manual-disposal discipline `src/train/ppo.ts` needs does not carry over). `mayhem_rl/checkpoint.py`'s `export_tfjs` converts a trained PyTorch model into the exact on-disk format `src/train/network.ts`'s `ActorCriticModel.load` reads (weight-transposing by name against a TS-generated template — see `ensure_tfjs_template`), so a Python-trained policy flows through `evaluate.ts`/`replayRecording.ts`/`policyDecisionSource.ts` completely unchanged. `train_ppo.py` is the CLI entrypoint (`python training-py/train_ppo.py [flags]`, run from the repo root — its subprocess calls resolve paths relative to `_REPO_ROOT`); eval and replay recording are tied to the same cadence as checkpointing (`--checkpoint-every`), not independent cadences, since both need a fresh cross-process TF.js export. No opponent league in this version, matching `src/train/`'s scope. `mayhem_rl/checkpoint_pruning.py` is a 1:1 port of `src/train/checkpointPruning.ts`: after each checkpoint save, `train_ppo.py` evaluates it (`mean_win_rate`), patches the score into `meta.json` via `set_checkpoint_score` (the TF.js export the eval subprocess needs only exists after `save_checkpoint`, so the score can't be known at save time the way `trainPPO.ts` can arrange it), then calls `prune_checkpoints` to keep only the latest checkpoint plus the top `--keep-top-n-checkpoints` (default 3) by score, deleting the rest — `_tfjs_template/` is excluded by the `py-iter-\d+` directory-name pattern, not by any special-casing. Immediately after, it re-lists the surviving checkpoints' iterations and calls `eval_and_replay.prune_replays` (which shells out to `evalAndReplay.ts pruneReplays`, mirroring the TS pipeline's `pruneReplays` call — the manifest-pruning logic itself is never duplicated in Python) to delete any `public/replays` entries whose iteration no longer has a surviving checkpoint.

### `src/render/` — canvas rendering

Pure functions that read a `GameState` snapshot and draw one frame; no simulation logic lives here.

- `draw.ts` — `drawFrame`: draws nodes, the ring danger overlay + boundaries, attack lines, units (with HP bars and facing indicators), and optional debug overlays (vision/attack range, observation patch)
- `camera.ts` — `Camera` and `worldToScreen` for world↔screen coordinate conversion
- `colors.ts` — palette (team colors, elevation colors, ring colors, etc.)
- The ring "danger zone" overlay in `drawRingDanger` is built on an offscreen canvas before being composited onto the main canvas with `drawImage` — `globalCompositeOperation = 'destination-out'` affects the *entire* canvas it's applied to, so it must never be applied directly to the main canvas once other elements (nodes, units) have already been drawn there, or it will erase them too.

### `src/app/` — React ↔ sim glue

- `useSimulationLoop.ts` — owns the `Simulation`/`Env` instance, the play/pause/step/replay loop, config form state, and bot assignment per team
- `SimulationCanvas.tsx` — hosts the `<canvas>`, drives `drawFrame` off the animation loop, handles unit selection clicks
- `ControlPanel.tsx` — playback controls, seed/config form, per-team bot assignment, debug overlay toggles
- `DebugPanel.tsx` — inspects selected unit / raw state
- `replay.ts` — episode recording/replay support

## TypeScript / lint

TypeScript is split via project references: `tsconfig.json` is the root pointing at `tsconfig.app.json` (app source, `src/`) and `tsconfig.node.json` (Vite config itself). `moduleResolution: bundler` and `verbatimModuleSyntax` are set, so imports must use explicit type-only syntax where required and extensions/resolution follow bundler rules rather than Node's.

ESLint config (`eslint.config.js`) is flat-config style, composing `@eslint/js`, `typescript-eslint`, `eslint-plugin-react-hooks`, and `eslint-plugin-react-refresh` (Vite-aware). Type-aware lint rules are not enabled.

## Conventions

- Comments in `sim/`, `render/`, etc. sometimes cite a `§N` section number — these refer to an external design doc, not a file in this repo; treat them as stable identifiers for a design decision rather than something to resolve.
- Some comments are written in Japanese, prefixed `ユーザー要望:` ("user request:") — these record a specific behavioral requirement from the user, often with the reasoning/proof for a non-obvious implementation choice (e.g. the ring's next-center drift bound in `ring.ts`). Preserve this intent when touching the surrounding code.
