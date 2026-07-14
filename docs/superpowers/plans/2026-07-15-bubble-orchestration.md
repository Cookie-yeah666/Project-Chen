# Bubble Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a small `BubbleOrchestrator` boundary for main-process bubble requests and route proactive bubbles through it without changing visible behavior.

**Architecture:** `BubbleManager` remains responsible for actual Electron delivery, state gates, activity monitoring, and proactive spacing. `BubbleOrchestrator` is a typed facade over `BubbleManager` for main-process bubble requests. `ObserverManager` receives the orchestrator and calls `tryShowProactive()`, which delegates to `BubbleManager.tryShowProactiveBubble()` with the same reason/source behavior.

**Tech Stack:** Electron main process, TypeScript, existing `BubbleManager`, `ObserverManager`, `main.ts` initialization.

## Global Constraints

- Introduce a small `BubbleOrchestrator` as the main-process boundary for queued/prioritized bubble requests.
- Keep `BubbleManager` responsible for the actual Electron window delivery and existing status gates.
- Preserve current proactive response path behavior.
- Move only low-risk main-process bubble arbitration into the orchestrator first.
- Preserve current visible behavior for chat bubbles, proactive bubbles, activity bubbles, greetings, cooldowns, and TTS fallback.
- Do not redesign renderer bubble layout, CSS, or animation timing.
- Do not rewrite chat rendering, TTS playback, or proactive decision logic.
- Do not change IPC channel names unless a compile-time mismatch exposes an existing bug.
- Do not remove existing `BubbleManager` status gates or proactive cooldown behavior.
- Do not introduce a large event bus or external queue dependency.
- Do not attempt full cross-process orchestration of renderer-local state bubbles in this iteration.
- `npm run build` must pass.
- Run `npm test`; if it reports `Missing script: "test"`, record that exact result and do not claim tests passed.

---

## File Structure

- Create: `src/core/bubble-orchestrator.ts` — typed main-process bubble orchestration facade.
- Modify: `src/core/observer-manager.ts` — depend on `BubbleOrchestrator` instead of directly calling `BubbleManager` for proactive bubbles.
- Modify: `src/main/main.ts` — construct and inject `BubbleOrchestrator` after `BubbleManager` creation.
- Modify: `PROJECT_INDEX.md` — document the new orchestration boundary.

---

## Task 1: Add `BubbleOrchestrator` and route proactive bubbles through it

**Files:**
- Create: `src/core/bubble-orchestrator.ts`
- Modify: `src/core/observer-manager.ts`
- Modify: `src/main/main.ts`

**Interfaces:**
- Consumes: `BubbleManager.sendBubble(text): void` and `BubbleManager.tryShowProactiveBubble(text, source): boolean`.
- Produces:
  - `export type BubbleSource = 'chat' | 'proactive' | 'activity' | 'system';`
  - `export type BubblePriority = 'low' | 'normal' | 'high';`
  - `export interface BubbleRequest { text: string; source: BubbleSource; priority?: BubblePriority; ttlMs?: number; }`
  - `export class BubbleOrchestrator { show(request: BubbleRequest): boolean; tryShowProactive(text: string, source?: string): boolean; }`

- [ ] **Step 1: Create `BubbleOrchestrator`**

Create `src/core/bubble-orchestrator.ts`:

```ts
import { BubbleManager } from './bubble-manager';

export type BubbleSource = 'chat' | 'proactive' | 'activity' | 'system';
export type BubblePriority = 'low' | 'normal' | 'high';

export interface BubbleRequest {
  text: string;
  source: BubbleSource;
  priority?: BubblePriority;
  ttlMs?: number;
}

export class BubbleOrchestrator {
  private bubbleManager: BubbleManager;

  constructor(bubbleManager: BubbleManager) {
    this.bubbleManager = bubbleManager;
  }

  show(request: BubbleRequest): boolean {
    const text = request.text.trim();
    if (!text) return false;
    this.bubbleManager.sendBubble(text);
    return true;
  }

  tryShowProactive(text: string, source: string = 'proactive'): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    return this.bubbleManager.tryShowProactiveBubble(trimmed, source);
  }
}
```

- [ ] **Step 2: Update `ObserverManager` imports and fields**

In `src/core/observer-manager.ts`, add:

```ts
import { BubbleOrchestrator } from './bubble-orchestrator';
```

Replace the field:

```ts
private bubbleManager: BubbleManager;
```

with:

```ts
private bubbleOrchestrator: BubbleOrchestrator;
```

Keep the `BubbleManager` import only if another type still uses it; otherwise remove it.

- [ ] **Step 3: Update `ObserverManager` constructor parameter**

Replace the constructor parameter:

```ts
bubbleManager: BubbleManager,
```

with:

```ts
bubbleOrchestrator: BubbleOrchestrator,
```

Replace the assignment:

```ts
this.bubbleManager = bubbleManager;
```

with:

```ts
this.bubbleOrchestrator = bubbleOrchestrator;
```

- [ ] **Step 4: Route proactive display through orchestrator**

In `collectAndAnalyze()`, replace:

```ts
shown = this.bubbleManager.tryShowProactiveBubble(text, candidate.reason);
```

with:

```ts
shown = this.bubbleOrchestrator.tryShowProactive(text, candidate.reason);
```

Do not change candidate evaluation, micro behavior, delay, generated text, or delivery marking logic.

- [ ] **Step 5: Update `main.ts` construction and injection**

In `src/main/main.ts`, add import:

```ts
import { BubbleOrchestrator } from '../core/bubble-orchestrator';
```

Add module variable near `bubbleManager`:

```ts
let bubbleOrchestrator: BubbleOrchestrator;
```

After `bubbleManager = new BubbleManager(...)`, add:

```ts
bubbleOrchestrator = new BubbleOrchestrator(bubbleManager);
```

In the `new ObserverManager(...)` call, replace the `bubbleManager` argument with `bubbleOrchestrator` and keep all other arguments in the same order.

- [ ] **Step 6: Run build**

Run:

```bash
npm run build
```

Expected: `tsc` exits 0. Fix only TypeScript errors related to the new orchestrator type and constructor wiring.

- [ ] **Step 7: Verify proactive path and IPC are preserved**

Run:

```bash
git grep -n "tryShowProactive\|tryShowProactiveBubble\|show-bubble" -- src/core src/main src/renderer
```

Expected:

- `ObserverManager` calls `bubbleOrchestrator.tryShowProactive(...)`.
- `BubbleOrchestrator.tryShowProactive()` delegates to `BubbleManager.tryShowProactiveBubble(...)`.
- `BubbleManager` still sends `show-bubble` IPC.
- `preload.ts` / renderer `show-bubble` IPC contract remains unchanged.

- [ ] **Step 8: Verify renderer/TTS files are unchanged**

Run:

```bash
git diff -- src/renderer src/core/tts-manager.ts src/main/preload.ts
```

Expected: no output.

- [ ] **Step 9: Commit Task 1**

Run:

```bash
git add src/core/bubble-orchestrator.ts src/core/observer-manager.ts src/main/main.ts
git commit -m "refactor: add bubble orchestrator"
```

---

## Task 2: Update architecture notes and run final verification

**Files:**
- Modify: `PROJECT_INDEX.md`

**Interfaces:**
- Consumes: `BubbleOrchestrator` from Task 1 and existing `BubbleManager` delivery/gate behavior.
- Produces: project documentation that records the new bubble orchestration boundary.

- [ ] **Step 1: Update core module list in `PROJECT_INDEX.md`**

Add this item near the existing `bubble-manager.ts` bullet:

```md
- `bubble-orchestrator.ts`：主进程气泡编排边界，接收带来源/优先级的气泡请求，并把实际投递委托给 `BubbleManager`。
```

- [ ] **Step 2: Update proactive/bubble architecture note**

In the main-process or AI-system section, update the active proactive path wording to include the orchestrator:

```md
当前主动回应主路径：`ObserverManager → ContextCollector → ProactiveReactionSystem → MicroBehaviorManager → BubbleOrchestrator → BubbleManager.tryShowProactiveBubble`。
```

Also add this sentence near the bubble or proactive description:

```md
`BubbleOrchestrator` 只负责主进程气泡请求的轻量编排；`BubbleManager` 继续负责状态门禁、冷却和 `show-bubble` IPC 投递。
```

- [ ] **Step 3: Run build**

Run:

```bash
npm run build
```

Expected: `tsc` exits 0.

- [ ] **Step 4: Run npm test and record exact status**

Run:

```bash
npm test
```

Expected for the current project unless a test script was added:

```text
npm error Missing script: "test"
```

Record this as “test script missing” and do not report tests as passing. If a test script exists, it must pass before continuing.

- [ ] **Step 5: Run final bubble-boundary verification commands**

Run:

```bash
git grep -n "tryShowProactive\|tryShowProactiveBubble\|show-bubble" -- src/core src/main src/renderer
git diff -- src/renderer src/core/tts-manager.ts src/main/preload.ts
git diff --check
```

Expected:

- Proactive path routes through `BubbleOrchestrator.tryShowProactive` and reaches `BubbleManager.tryShowProactiveBubble`.
- Renderer `show-bubble` IPC contract is unchanged.
- Renderer, TTS manager, and preload diffs are empty.
- `git diff --check` reports no whitespace errors. CRLF warnings are acceptable on Windows.

- [ ] **Step 6: Run final status check**

Run:

```bash
git status --short
```

Expected: only `PROJECT_INDEX.md` is modified before the docs commit.

- [ ] **Step 7: Commit Task 2**

Run:

```bash
git add PROJECT_INDEX.md
git commit -m "docs: update bubble orchestration notes"
```

## Self-Review

Spec coverage:

- `BubbleOrchestrator` introduced: Task 1.
- `BubbleManager` remains actual delivery/status gate owner: Task 1 delegates to existing `BubbleManager` methods.
- Current proactive behavior preserved: Task 1 changes only the call boundary, leaving candidate/microbehavior/delay/marking logic intact.
- Low-risk first route: Task 1 routes only proactive main-process bubble display.
- Renderer layout/CSS, chat rendering, TTS playback, and IPC channel names unchanged: Task 1 and Task 2 verification commands check no renderer/TTS/preload diffs and unchanged `show-bubble` contract.
- Documentation update: Task 2.
- Build and npm test status: Task 2 final verification.

Placeholder scan: no unfinished placeholder markers remain. Every code-changing step includes exact code or exact replacement snippets.

Type consistency:

- `BubbleRequest`, `BubbleSource`, `BubblePriority`, and `BubbleOrchestrator` signatures match the design document.
- `ObserverManager` uses `BubbleOrchestrator.tryShowProactive(text, source): boolean`.
- `BubbleOrchestrator.tryShowProactive()` delegates to `BubbleManager.tryShowProactiveBubble(text, source): boolean`.
