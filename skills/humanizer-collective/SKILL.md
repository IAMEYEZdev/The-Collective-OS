---
name: humanizer-collective
description: |
  Collective override layer for the blader/humanizer skill. Loads whenever
  humanizer runs on any Collective output. Keeps humanizer's AI-pattern
  library and subordinates its style arbitration to DIR-001 Humanization Law.
  Use alongside humanizer for any external-facing text: LinkedIn posts, client
  deliverables, DMs, outreach, audit reports, case studies.
metadata:
  version: "1.0.0"
  authority: "DIR-001 Humanization Law"
  upstream: "blader/humanizer"
---

# Humanizer, Collective Override

`blader/humanizer` is installed and its pattern library is authoritative for
detecting AI writing tells. This layer governs the places where upstream
humanizer and Collective doctrine disagree.

**Order of precedence, highest first:**

1. DIR-001 Humanization Law and the brand-voice rules in `CLAUDE.md`
2. This override layer
3. Upstream `humanizer` SKILL.md

Where upstream and doctrine conflict, doctrine wins. Silently.

---

## Override 1: em dashes are never permitted

Upstream humanizer §14 and its Voice Calibration section allow em dashes back
in when a supplied writing sample contains them:

> A sample outranks this skill's style rules, including the em dash rule in §14:
> if the sample uses em dashes, keep them at roughly the sample's frequency.

**That clause does not apply to Collective output.** The rule here is absolute.
No em dashes, in any output, from any of the six agents, regardless of what a
writing sample does. A sample containing em dashes is a sample to be corrected,
not matched.

Replace with a comma, a colon, parentheses, or a full stop. Rewrite the sentence
if none of those work.

## Override 2: banned phrasings are a block, not a preference

Upstream treats AI vocabulary as patterns to reduce. Here they are a gate.
Any of the following in external output blocks the send:

- "Certainly", "Great question", "I'd be happy to", "As an AI"
- "delve", "tapestry", "testament to", "stands as", "serves as"
- "it's not just X, it's Y" and other negative parallelisms
- "in today's fast-paced world" and equivalent scene-setting openers
- Rule-of-three list padding where two items carry the meaning

Fix and re-check. Do not ship with a note about the exception.

## Override 3: voice calibration source

Upstream calibrates to a user-supplied writing sample. For Collective output
the calibration source is fixed:

| Output type | Voice source |
|---|---|
| Anything to Jason | Melanie's rules in `CLAUDE.md`: no narration, no sycophancy, no hedging |
| LinkedIn, external content | Jason's established voice via Melissa's prior shipped posts |
| Client deliverables | Delivery track register: plain, specific, no puffery |
| Internal agent-to-agent | Upstream humanizer defaults are fine |

## Override 4: never invent facts, extended

Upstream already forbids inventing facts. Extended here: humanizing must not
soften a number, widen a hedge, or drop a caveat to improve flow. If a sentence
reads badly because the underlying claim is weak, the claim gets fixed or cut.
It does not get smoothed.

This matters most on audit reports and pipeline commentary, where a rounded
number is a revenue leakage risk under DIR-006.

---

## What upstream is still authoritative for

Everything else. Its pattern library is good and it is not being second-guessed:

- Inflated symbolism and significance puffery
- Promotional language
- Superficial `-ing` analyses
- Vague attributions ("experts say", "studies show")
- Passive voice overuse
- Filler phrases
- Section 3 onward of the upstream content patterns

## Verification

Before any external send, confirm:

1. Zero em dashes
2. Zero banned phrasings from Override 2
3. Every number and claim traceable to source
4. Reads like Jason or Melanie wrote it, not like a model cleaned it up

Failing 1 or 2 is a constitutional breach under DIR-001, not a style note.
