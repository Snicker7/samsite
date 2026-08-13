# Configurable Miss Penalty & Payout Floor — Design

**Date:** 2026-07-08
**Status:** Approved, ready for implementation plan

## Problem

Today, a miss with no freeze left **resets the streak to 0**, and the payout
curve always starts at `rewardIncrement` (streak 1 pays one increment). Two
things are hard-coded that the user wants to configure per category:

1. **How harshly a miss hurts.** A miss-without-freeze is all-or-nothing: it
   wipes the streak entirely. The user wants to soften this — e.g. a miss should
   cost only half the streak, or any percentage — with 100% reproducing today's
   full reset.
2. **Where the payout curve starts.** Today streak 1 pays `rewardIncrement`
   (e.g. $0.25). The user wants a configurable minimum so streak 1 pays, say,
   $1.00, and each further streak step adds the increment from there.

## Solution overview

Add **two independent per-category settings**, both defaulting to today's
behavior so existing categories are unchanged (no migration).

### 1. Miss penalty percent — `missPenaltyPercent`

- Range: `0`–`100`. **Default: `100`.**
- Applied only on a **miss with no freeze available** (the freeze path is
  untouched — a freeze still preserves the streak).
- Reduces the streak instead of always zeroing it:

  ```js
  newStreak = Math.max(0, Math.round(streak * (1 - missPenaltyPercent / 100)))
  ```

  - `100` → `newStreak = 0` (today's full reset).
  - `50` → streak is halved (streak 10 → 5).
  - `0` → streak is unchanged by a miss.
- **Rounding decision:** `Math.round` (streak 5 at 50% → 3, keeping the larger
  half). Not `Math.floor`.
- Because the penalty only ever multiplies by a value in `[0, 1]`,
  `newStreak <= streak` always — a miss can never raise the streak.

### 2. Minimum payout / curve start — `minPayout`

- Dollars, `>= 0`. **Default: equal to `rewardIncrement`** (blank/`0` in the
  admin form is interpreted as "start at the reward increment").
- Redefines the on-time payout curve so **streak 1 pays the floor**, growing by
  the increment each step, still capped by `maxPerInstance`:

  ```js
  function payout(cat, streak) {
    if (streak <= 0) return 0;
    var start = cat.minPayout > 0 ? cat.minPayout : cat.rewardIncrement;
    return round2(Math.min(start + (streak - 1) * cat.rewardIncrement,
                           cat.maxPerInstance));
  }
  ```

  Example — floor $1.00, increment $0.25:

  | streak | payout |
  | ------ | ------ |
  | 0      | $0.00  |
  | 1      | $1.00  |
  | 2      | $1.25  |
  | 3      | $1.50  |
  | …      | … up to `maxPerInstance` |

- The floor is the *start* of the curve, not a clamp applied after building up:
  you do not have to grow a streak to reach the minimum and then exceed it.

## Backward compatibility

With defaults `missPenaltyPercent = 100` and `minPayout = rewardIncrement`:

- **Payout:** `start + (streak-1)*inc = inc + (streak-1)*inc = streak*inc` —
  identical to the current `rewardIncrement * streak` (capped at max).
- **Miss without freeze:** `round(streak * (1 - 1)) = 0` — identical to the
  current `streak = 0` reset.

Existing categories in Script Properties have neither field;
`normalizeCategory` fills the defaults, so their behavior is unchanged. **No
migration or ledger changes are required.**

## Validation rules (added to `validateCategory`)

- `missPenaltyPercent`: a number in `[0, 100]`.
- `minPayout`: `>= 0`, and `<= maxPerInstance` (a start above the cap is
  contradictory). Blank is allowed and means "use the reward increment."

## Interaction notes

- **Freeze path unchanged:** a miss with a freeze available still consumes the
  freeze and preserves the streak; the penalty only applies when no freeze is
  left.
- **Cap still applies** as the maximum on every payout; the floor is the new
  minimum/start. If `minPayout` is set at or near `maxPerInstance`, the curve is
  flat at the cap — allowed (validation only forbids `minPayout > maxPerInstance`).
- **"Potential next payout" displays** (Code.gs) already call `payout(cat,
  streak + 1)`, so they reflect the new curve automatically.

## Touch points

| File | Change |
| ---- | ------ |
| `backend/engine.js` | New `payout` curve; penalty in the miss branch of `applyEntry`; `missPenaltyPercent` + `minPayout` in `normalizeCategory` and `validateCategory`. |
| `backend/Code.gs` | Mirror the same logic (deployed copy of the engine). |
| `backend/engine.test.js` | Tests: penalty percentages, floor/curve, defaults reproduce old behavior, cap interaction, edge cases. |
| `index.html` | Two new inputs in the Categories form (miss penalty %, minimum payout $). |
| `js/app.js` | Populate the two inputs on edit (~L319–320); collect them on save (~L408–409). |

## Test plan (engine.test.js)

- `payout`: floor start (streak 1 = min), growth by increment, cap enforced,
  streak 0 = 0, default floor = increment reproduces old values.
- Miss without freeze: `100%` → 0; `50%` → half (round); `0%` → unchanged;
  rounding of odd streaks (5 @ 50% → 3).
- Miss with freeze: streak preserved regardless of penalty.
- Backward compat: category with no new fields behaves exactly as before.
- Validation: reject `missPenaltyPercent` outside 0–100; reject
  `minPayout > maxPerInstance`; accept blank `minPayout`.

## Out of scope

- No change to freeze mechanics, unused-freeze bonus, cadence, or the ledger
  schema.
- No UI beyond the two new form fields (no new dashboard displays).
