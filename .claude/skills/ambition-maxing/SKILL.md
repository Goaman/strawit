---
name: ambition-maxing
description: >-
  Turn a task or goal into a progressively bolder plan by running it through a
  chain of sub-agents — one drafts an initial plan, then each subsequent
  sub-agent rewrites it to be more ambitious, for N passes. Use this whenever
  the user wants to "ambition max", "make this more ambitious", "go bigger",
  "10x this", "think bigger", "crank up the ambition", "max out" a plan or idea,
  or asks for an aggressive/stretch version of a plan. Also trigger when the
  user gives a goal and asks to escalate, amplify, or push it as far as it can
  go over several rounds, even if they don't say the word "ambition".
---

# Ambition Maxing

## What this does

Most plans are quietly throttled by unexamined assumptions: the default scope,
the safe timeline, the obvious audience, the budget someone half-remembers. A
single planner tends to anchor on the first reasonable version and stop. This
skill breaks that anchor by passing the plan through a **relay of fresh
sub-agents**, each one charged with making the plan meaningfully bolder than the
version it received.

Because each amplifier starts cold — it sees only the plan, not the cautious
reasoning that produced it — it has no attachment to the previous constraints
and is free to push. Repeated over N passes, the plan ratchets upward in scope,
impact, and boldness.

## When to use it

Trigger this when the user wants to deliberately escalate the ambition of a plan
or goal: "ambition max this", "make it as ambitious as possible", "10x this
plan", "go way bigger", "give me the moonshot version", or any request to push a
goal through several rounds of escalation.

## The core loop

You are the **orchestrator**. You do not write or amplify the plan yourself —
your job is to run the relay and carry each version from one sub-agent to the
next. Doing it yourself defeats the purpose: the value comes from each pass
being a *fresh* mind with no anchor to the previous reasoning.

### Step 1 — Pin down the task and the number of passes

Identify two things from the user's request:

- **The task / goal** to be planned.
- **N**, the number of amplification passes. If the user names a number ("max it
  out over 5 rounds", "3 passes"), use it. If they don't, default to **3** and
  tell them that's what you're doing (and that they can ask for more or fewer).

If the task itself is vague, ask one quick clarifying question before starting —
a relay built on a fuzzy goal just amplifies the fuzziness.

### Step 2 — Pass 1: draft the initial plan

Spawn a sub-agent (via the Task/Agent tool) to produce a concrete, grounded
first plan. Keep this one sober — it's the floor the rest of the relay builds on.

Prompt it roughly like this:

> Create a concrete, actionable plan for the following goal: **<task>**.
> Structure it with clear objectives, key steps/milestones, rough scope, and
> intended impact. Be realistic and specific. Return the full plan as
> structured markdown — no preamble, no commentary, just the plan.

Capture its output as `plan_v1`.

### Step 3 — Passes 2…N: amplify, one fresh sub-agent per pass

For each remaining pass, spawn a **new** sub-agent and hand it the current plan.
Each must return a *complete rewritten plan*, not notes or a critique — the
output of pass k is the input to pass k+1, so it has to stand on its own.

Prompt each amplifier like this:

> Here is a plan:
>
> <current plan>
>
> Your job is to make this plan **significantly more ambitious** than it
> currently is, then return the full rewritten plan. "More ambitious" means,
> concretely:
> - **Bigger scope** — widen what's in bounds; serve more people, more places,
>   more use cases.
> - **Higher impact** — aim for a 10x outcome, not a 10% improvement. What would
>   make this matter an order of magnitude more?
> - **Challenged assumptions** — find the limits the current plan quietly
>   accepts (budget, timeline, headcount, "we can't because…") and push past or
>   reframe them.
> - **Bolder goals** — add stretch objectives that would be a genuine triumph if
>   hit.
> - **Raised standards** — higher quality bar, broader reach, faster pace.
>
> Keep it a *coherent, real plan* — escalate the ambition, but it must still
> hang together as something a determined team could actually pursue. Don't just
> bolt on grandiose phrases; deepen and expand the substance. Return the full
> rewritten plan as structured markdown, no preamble.

Capture each result as `plan_v2`, `plan_v3`, … `plan_vN`. Feed the latest
version into the next pass. Run passes sequentially — each one depends on the
output of the one before, so they can't be parallelized.

It's worth telling each amplifier which pass it is and how many remain (e.g.
"this is amplification pass 3 of 5"), so it can calibrate how hard to push.

### Step 4 — Present the result

Show the user the **final plan** (`plan_vN`) in full — that's the headline.

Then, below it, give a short **ambition trajectory**: a few bullets tracing how
the plan escalated across passes (e.g. "v1: a local workshop → v3: a regional
program → v5: an international movement"). This lets the user see the climb and
pick an earlier rung if the final version overshot what they want.

Offer to run more passes, dial it back to an earlier version, or ground the
final plan back into something immediately executable.

## Keeping the relay healthy

- **Guard against empty escalation.** The failure mode is amplifiers that just
  sprinkle on superlatives ("world-class", "revolutionary") without adding real
  substance. The prompt asks for deepened *substance*; if you notice a pass that
  only inflated the language, say so when you present, or re-run that pass.
- **Ambition, not detachment.** Each pass should still be a plan a real team
  could chase, not pure fantasy. The point is to find the bold-but-reachable
  ceiling, not to leave reality behind. If the user *wants* unhinged moonshots,
  that's fine — just follow their lead.
- **Fresh agent every pass.** Always spawn a new sub-agent rather than reusing
  one in conversation. The lack of memory is the feature — it's what removes the
  anchor.
- **Big N.** For large N (say >6), expect later passes to add less; mention
  diminishing returns when you present, and it's fine to note if a pass barely
  moved the needle.
