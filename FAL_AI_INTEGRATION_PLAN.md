# Fal AI Integration Plan for Goldflow

## Objective

Add Fal as a guarded production provider for generated manhwa visuals while preserving the existing global reference bank, OpenArt assets, Gemini history, approved scripts, narration, timing, and Goldflow workflow controls.

Use direct Fal model endpoints through `genmedia` or `@fal-ai/client`. Do not depend on Fal Agent for production dispatch.

Primary production configuration:

- Provider: Fal
- Endpoint: verify the current exact GPT Image 2.5 Sunburst edit endpoint before locking
- Expected endpoint: `openai/gpt-image-2.5/sunburst/edit`
- Quality: `low`
- Output: 1920x1080, 16:9
- Format: PNG
- Normal input: one deterministic reference collage
- Exception: separate multi-reference inputs after collage failure is visually established
- Repair models: Seedream 5 Lite first, Nano Banana 2 only for difficult semantic failures

## 1. Respect the Existing Goldflow Identity

Before implementation or dispatch:

1. Read completely:
   - `AGENTS.md`
   - `docs/pipelines/manhwa.md`
   - `docs/pipelines/generated_visuals.md`
2. Inspect the current episode identity.
3. Run:

```bash
node bin/goldflow.mjs run status \
  --episode-dir <episode-dir> \
  --format markdown
```

4. Determine whether the locked provider identity permits Fal.
5. If the identity is locked to OpenArt, create the narrowest compliant Fal production attempt using the already approved script, narration, timing, visual beat plan, and package artifacts.
6. Do not modify the existing OpenArt identity.
7. Do not rewrite approvals or copy broad directories manually.
8. Reuse immutable approved artifacts only through a supported Goldflow import, recovery, or new-attempt path.
9. Preserve all Gemini and OpenArt attempts as immutable historical production evidence.

Suggested new attempt name:

```text
2026-W39-gamblers-eye-fal-v1
```

The exact run name must follow the repository's current naming and identity rules.

## 2. Fal Account and Tooling Verification

Use Fal's direct API tooling, preferably `genmedia`.

Verify without spending:

```bash
genmedia models "gpt image 2.5 sunburst" --json
genmedia schema openai/gpt-image-2.5/sunburst/edit --json
genmedia pricing openai/gpt-image-2.5/sunburst/edit --json
genmedia run openai/gpt-image-2.5/sunburst/edit --help
```

Record:

- Exact endpoint ID
- Current schema
- Supported quality values
- Image-size syntax
- Maximum reference count
- Output formats
- Queue behavior
- Current pricing
- Schema retrieval timestamp
- SHA-256 of the stored schema snapshot

Keep `FAL_KEY` in the documented private credential location. Never place it in manifests, execution events, logs, or tracked files.

Then run a bounded billing verification:

1. Record the Fal balance or usage state.
2. Submit one low-quality 1920x1080 text-to-image request.
3. Record the resulting charge.
4. Submit one low-quality 1920x1080 edit with one reference board.
5. Record the resulting charge.
6. Compare the measured charges with Fal's published estimate.
7. Store sanitized request and billing receipts.

No bulk dispatch should begin until the actual one-board request cost is known.

## 3. Preserve the Global Reference Bank

The local Goldflow reference-bank manifest remains the authoritative source. OpenArt and Fal are provider mirrors.

Do not regenerate approved canonical references merely because production moves to Fal.

Every canonical asset must retain:

```json
{
  "asset_id": "goldflow.character.joey.v1",
  "asset_class": "character",
  "canonical_name": "Joey",
  "aliases": ["protagonist", "male lead"],
  "semantic_roles": ["protagonist"],
  "story_universe": "gamblers_eye",
  "series_scope": "global",
  "version": 1,
  "approval_state": "approved",
  "local_path": "/absolute/path/to/asset.png",
  "sha256": "...",
  "width": 1920,
  "height": 1080,
  "mime_type": "image/png",
  "canonical_prompt": "...",
  "negative_constraints": ["no text", "no watermark"],
  "relationships": [],
  "providers": {
    "openart": {
      "asset_id": "...",
      "model_id": "...",
      "creation_receipt": "..."
    },
    "fal": {
      "upload_receipt": null,
      "request_id": null
    }
  },
  "supersedes": null,
  "superseded_by": null
}
```

Provider records must be namespaced. An OpenArt ID must never become the Goldflow asset ID.

### Identity Naming

Joey remains the only character whose primary global name is a proper character name.

Other characters must also be searchable by reusable semantic role:

- Adrian: `brother`, `rival brother`, `male antagonist`
- Victor: `father`, `dad`, `patriarch`
- Celeste: `fiancee`, `girlfriend`, `wife-role`, `romantic betrayer`
- Evelyn: `operations adviser`, `business partner`, `competent female lead`
- Ben: `best friend`, `mechanic`, `grounding friend`
- Nadia: `lawyer`, `independent counsel`
- June: `independent director`, `gaming administrator`
- Rook: `financier`, `lender`, `business antagonist`
- Cass: `professional gambler`, `poker professional`
- Mara: `minority shareholder`, `older investor`
- Elias: `hotel steward`, `legacy employee`
- Nora: `hotel manager`
- Luis: `construction manager`
- Derek: `poker rival`

Wardrobe and age variations remain states beneath the same identity:

```text
character.joey
  wardrobe.debt_casual
  wardrobe.salon_suit
  wardrobe.poker_tournament
  wardrobe.hotel_owner
  wardrobe.company_owner
```

### Provider Portability

Every accepted asset must have:

- A portable local PNG or JPEG
- Absolute path
- SHA-256
- Dimensions and color mode
- Prompt and negative constraints
- Creation model and provider
- Approval state
- Supersession history

Do not rely on:

- OpenArt folder names
- OpenArt characters or worlds
- Fal CDN URLs
- Browser session state
- Provider-side galleries

Remote Fal URLs are temporary transport. Download results immediately and preserve the local file and hash. Never store secrets or signed URLs in tracked artifacts.

## 4. Deterministic Reference-Collage System

Create reference boards locally without using a generative model.

### Standard Layout

Use a 16:9 canvas:

- Left 50%: primary character and current wardrobe
- Upper right 30%: environment
- Lower right 20%: second character or crucial prop

For two-character scenes:

- Left 35%: primary character
- Center 35%: secondary character
- Right 30%: environment or prop

For prop-critical scenes:

- Left 45%: primary character
- Upper right 30%: prop close-up
- Lower right 25%: environment

### Board Construction Rules

- Assemble with Sharp or ImageMagick.
- Use neutral gray gutters.
- Do not overlap panels.
- Do not add prose labels, character names, logos, or watermarks.
- Preserve useful face resolution.
- Keep props large enough to remain legible.
- Avoid multiple views of the same person unless pose continuity requires them.
- Keep source images' aspect ratios; crop according to a recorded deterministic rule.
- Never stretch a canonical asset.
- Use PNG.
- Record the compositor version and exact layout.

The prompt maps panels by position:

```text
The input is a reference board, not the requested composition.

Use the left panel only for the primary character's identity, facial
features, hair, age, body type, and wardrobe.

Use the upper-right panel only for the environment, architecture,
materials, lighting vocabulary, and spatial identity.

Use the lower-right panel only for the secondary character or crucial
prop identified in the shot instructions.

Create one coherent cinematic manhwa frame. Do not reproduce the board,
borders, gutters, reference-sheet layout, or multiple copies of a
character. Do not add labels, captions, watermarks, or unintended text.
```

### Board Manifest

Every board receives a stable ID:

```json
{
  "schema": "goldflow_reference_board_v1",
  "board_id": "refboard.ep01.beat_w000000_w000009.v1",
  "layout_id": "primary_left_environment_upper_right_support_lower_right",
  "compositor_version": "1.0.0",
  "output_path": "/absolute/path/to/board.png",
  "output_sha256": "...",
  "width": 1920,
  "height": 1080,
  "panels": [
    {
      "role": "primary_character",
      "asset_id": "goldflow.character.victor.v1",
      "asset_sha256": "...",
      "crop": {},
      "placement": {}
    },
    {
      "role": "environment",
      "asset_id": "goldflow.location.grand_private_salon.v1",
      "asset_sha256": "...",
      "crop": {},
      "placement": {}
    },
    {
      "role": "supporting_reference",
      "asset_id": "goldflow.character.adrian.v1",
      "asset_sha256": "...",
      "crop": {},
      "placement": {}
    }
  ]
}
```

Boards may be cached and reused only when their full constituent hashes, crops, layout, and compositor version match.

## 5. Collage Validation Test

Test collage mode before episode-scale dispatch.

Use the existing representative validation set:

1. Joey close-up
2. Joey with Adrian
3. Joey with Victor
4. Joey with Celeste
5. Four-person roulette-table composition
6. Torn dollar close-up
7. Grandpa's watch close-up
8. Wide Grand salon shot

Generate each through Fal GPT Image 2.5 Sunburst:

- Low quality
- 1920x1080
- One reference board
- One output initially
- Exact prompt and request receipt preserved

Review:

- Joey's identity
- Secondary-character identity
- Wardrobe fidelity
- Age and body proportions
- Hands
- Torn-dollar shape and initials
- Watch shape, clasp, and gold finish
- Roulette wheel and table details
- Character count
- Location fidelity
- Absence of collage borders
- Absence of duplicated people
- Absence of unwanted text
- Composition and emotional action

Schema success does not count as visual approval.

### Collage Acceptance

Approve collage mode when:

- Joey remains recognizable across all relevant shots.
- At least seven of eight outputs are production-usable or need only a narrow prompt correction.
- The four-person composition contains the correct number of distinct people.
- The dollar and watch retain their defining features.
- No repeated board-layout leakage appears.
- No systematic environment loss appears.

A single isolated failure does not invalidate collage mode.

## 6. Multi-Reference Fallback

If a specific collage shot fails visual review, repair only that shot.

Fallback order:

1. **Scoped Sunburst repair using the same board**
   - Clarify the failed identity, prop, or composition requirement.
   - Do not alter unrelated creative choices.
2. **Sunburst with separate references**
   - Primary character
   - Environment
   - Secondary character or crucial prop
3. **Seedream 5 Lite Edit**
   - Use when Sunburst cannot preserve multiple identities or a crucial prop.
   - Keep the same ordered reference semantics.
4. **Nano Banana 2**
   - Use only for exact semantic or compositional failures Seedream cannot resolve.

Do not:

- Automatically retry every failed image
- Run whole-stage fallback
- Silently change models
- Generate multiple speculative alternatives
- Replace accepted images
- Promote a fallback result without visual review

Each repair must record:

- Failed image ID
- Failure classification
- Original request ID
- Original model and cost
- Repair model
- Repair prompt delta
- Reference IDs and hashes
- New request ID
- New cost
- Review decision
- Supersession relationship

## 7. Fal Provider Adapter

Implement a provider adapter behind the existing Goldflow image-generation contract.

Suggested responsibilities:

```text
discoverModel()
snapshotSchema()
estimateCost()
uploadReference()
submitGeneration()
pollGeneration()
downloadOutput()
hashOutput()
recordReceipt()
classifyFailure()
```

Required request fields:

- Provider
- Endpoint ID
- Prompt
- Quality
- Width and height
- Output format
- Ordered reference-board path or reference paths
- Reference SHA-256 values
- Goldflow image ID
- Run identity hash
- Attempt number
- Expected maximum cost

Required response fields:

- Fal request ID
- Queue timestamps
- Start and completion timestamps
- Output path
- Output SHA-256
- Dimensions
- Content type
- Actual cost when available
- Status
- Error class
- Provider metadata

Never persist credentials or signed media URLs.

## 8. Dispatch and Concurrency

Use asynchronous queue submission.

Concurrency rollout:

1. Eight concurrent requests for the validation batch.
2. Sixteen concurrent requests for the first production soak.
3. Thirty-two concurrent requests only after the soak shows:
   - No unexplained request loss
   - No receipt mismatch
   - No rate-limit storm
   - Stable download completion
   - Correct image-to-request binding

Concurrency changes affect throughput only. They must not alter:

- Model
- Prompt
- Quality
- References
- Candidate count
- Review requirements

Use bounded retries only for transport failures that produced no billable output. Creative failures go through scoped repair review.

## 9. Production Candidate and Budget Policy

Preserve the approved visual plan:

- 1,288 visual beats
- 1,627 planned candidates
- Hero beats retain their approved two-candidate policy
- Other beats retain one candidate unless already approved otherwise

Do not inflate candidate counts because Fal is inexpensive.

Expected current-episode budget:

- Initial candidates: approximately $21
- Repairs: approximately $5
- Validation and incidental references: approximately $2-$4
- Expected total: $26-$30
- Warning threshold: $30
- Hard episode ceiling: $35

Monthly planning:

- Expected 12-video spend: approximately $225
- Monthly warning threshold: $225
- Normal operating budget: $250
- Hard ceiling: $300

Crossing a ceiling pauses new dispatch. Already funded in-flight requests may complete and must still be recorded.

## 10. Production Execution

After collage validation passes:

1. Resolve every shot's global assets.
2. Build or reuse its deterministic reference board.
3. Store the board manifest and hash.
4. Estimate the request cost.
5. Submit through the Fal adapter.
6. Record the request ID immediately.
7. Download the result immediately after completion.
8. Verify dimensions and decode integrity.
9. Hash the output.
10. Bind the output to the exact image ID.
11. Perform visual review.
12. Accept, reject, or create a scoped repair.
13. Never replace an accepted result silently.

Use the global bank for future episodes. Only generate new canonical assets when the story introduces a genuinely new recurring character, wardrobe state, location, object, or style requirement.

## 11. Goldflow Stage Discipline

After every completed stage:

```bash
node bin/goldflow.mjs run status \
  --episode-dir <episode-dir> \
  --format markdown
```

Execute only the next command shape reported by status.

Do not bypass the workflow guard or invoke underlying production scripts directly.

## 12. Completion Report

At the end of integration and after each production batch, report:

- Exact Fal endpoint and schema hash
- Verified low-quality one-board price
- New Fal attempt identity
- Confirmation that prior Gemini and OpenArt attempts remain immutable
- Number of global assets reused
- Number of new global assets created
- Collage validation results
- Collage acceptance or rejection rationale
- Images dispatched, completed, accepted, and rejected
- Multi-reference fallbacks
- Seedream and Nano Banana repairs
- Total Fal spend
- Average cost per accepted frame
- Estimated remaining episode cost
- Current Goldflow stage
- Exact next valid Goldflow command

The intended steady-state pipeline is:

```text
Global provider-neutral assets
        |
        v
Deterministic one-image reference board
        |
        v
Fal GPT Image 2.5 Sunburst low
        |
        v
Visual review
        |
        v
Exact-shot separate-reference fallback
        |
        v
Seedream/Nano Banana scoped repair
        |
        v
Accepted immutable production frame
```

This keeps the reference library reusable, minimizes input-image charges, preserves exact provenance, and retains separate references as a reliable escape hatch when a collage cannot carry a difficult composition.
