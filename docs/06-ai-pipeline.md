# The AI Pipeline

## Principle: never one call

"Write chapter 12" as a single request is the reason AI prose reads like mush.
Every substantial generation is a short pipeline with inspectable intermediates
the writer can intervene on.

```
 Plan ──► Draft ──► Critique ──► Revise ──► Accept ──► Extract
   │        │          │           │          │          │
 scene    prose     violations   patched    version    proposed
 outline            + notes      prose      committed  facts/entities
```

- **Plan** (`draft` or cheap role): beat targets + scene card → a beat-by-beat
  scene outline. Fast, cheap, easy to reject. Skippable for short scenes.
- **Draft** (`draft` role): the Scene Brief plus the approved outline → prose,
  streamed into the editor so the writer reads as it lands and can stop it.
- **Critique** (`critique` role, cheap): runs the Laws Engine's verification phase
  plus beat coverage ("did this scene actually deliver the midpoint reversal?").
- **Revise** (`revise` role): targeted patches against flagged spans only, not a
  full rewrite — a full rewrite loses the parts that were working, which is the
  single most infuriating behaviour of one-shot tools.
- **Accept**: writes a `scene_version`, updates the active text, recomputes word
  counts, refreshes mentions.
- **Extract** (cheap/local): proposes codex updates into the review queue.

Each step is a separate `ai_run` row with its own brief and cost. The pipeline is
configurable per project — a writer who wants raw drafts can disable critique.

## Generation modes the writer actually reaches for

Beyond "write this scene":

| Mode | What it does |
|---|---|
| **Continue** | Extends from the cursor in the established voice — the workhorse. |
| **Expand** | Takes a marked passage and deepens it (sensory, interiority, beat). |
| **Compress** | The opposite; tighten a flabby passage to a target length. |
| **Rewrite as** | Same content, different register/POV/tense/voice. |
| **Describe** | Generate description for a codex entity, in-world and in-voice. |
| **Dialogue pass** | Rewrites only dialogue against per-character voice laws. |
| **Brainstorm** | N divergent options for "what happens next", shown side by side. |
| **Interview a character** | Chat with an entity, constrained to what they know as of scene S. Superb for discovering voice and for filling `fact_knowledge`. |
| **Critique only** | Editorial notes, no rewriting. Developmental, line, or both. |
| **Summarise** | Scene/chapter/book summaries that feed the continuity ladder. |
| **Name** | Names constrained by a `language` entity's rules. |

Each mode is a `prompt_template` the writer can fork and edit. Templates are
versioned so a change can be compared against the previous version's outputs.

## Cost and token discipline

- Live token meter on the brief before sending, broken down by section.
- Per-run cost recorded; per-project and per-day spend meters; optional hard cap.
- Summaries are cached and invalidated only when the underlying scene changes —
  the continuity ladder should cost nothing on a typical run.
- Utility roles default to a cheap model; the app suggests the split on first run.
- Prompt-prefix stability: the brief is ordered so the stable parts (laws, style,
  book-so-far) come first and the volatile parts last, so provider-side prefix
  caching actually hits.

## Local models

Same `ProviderAdapter`, pointed at an OpenAI-compatible endpoint (Ollama,
llama.cpp server, LM Studio). What changes is only what the capability model
already describes: smaller context (the budget allocator handles it), unreliable
tool-calling and JSON mode (fall back to a parse-with-repair path), and different
tokenisation (per-provider `countTokens`).

On Android, "local" also means a discovered endpoint on the LAN — a desktop
running Ollama, reachable from the phone. That is a far more realistic path to
local inference on mobile than on-device 7B weights, and it needs nothing but a
base URL, an mDNS discovery helper and a trust prompt. On-device inference via
llama.rn stays a later experiment for small models.

## Streaming, cancellation, resumption

All generation streams. Cancellation is real (`AbortSignal` through the adapter)
and partial output is kept, not discarded. If the app is backgrounded on Android
mid-generation, the partial result is persisted and the run resumes or is retried
from its stored brief — which is exactly why the brief is stored, not just the
prompt string.
