# CrimeDungeon editorial preparation packet

This prospective, research-only check makes the package, source selections, beat progression and editorial review visible before preparing a new candidate. It does not modify or register a production workflow. Earlier proof identities, code bindings, media and approval states stay unchanged.

Read the [house style and recurring process](../designs/crimedungeon_style_bible_v1.md), [editorial standard](../designs/crimedungeon_editorial_standard_v1.md), [segment style](../designs/crimedungeon_segment_style_v1.md) and the applicable proof workflow. The packet is a paper edit, not a render manifest or an authority to run media commands. Actual execution still requires the selected workflow's identity, scope, source, voice and stage gates.

## Command and result

```sh
node scripts/crime-editorial-review.mjs --packet /absolute/research/editorial-packet.json --format markdown
node scripts/crime-editorial-review.mjs --packet /absolute/research/editorial-packet.json --format json
```

The CLI only reads the supplied JSON file and writes its report to stdout. It does not fetch URLs, create episode folders, generate media, call providers, write receipts, update approvals or publish. `--packet` must be absolute. Format defaults to `markdown`; only `json` and `markdown` are supported. Unknown or duplicate arguments fail.

The report separates:

- `structurally_valid`: required fields, value types, timing and cross-references pass.
- `ready_for_candidate`: structure passes **and the packet records** all five review checks as `pass`, a completed `paper_edit` or `direct_playback` review method, `decision: "ready_for_candidate"` and a reviewed content hash matching the current packet.
- `approval_granted`: always `false`.
- `content_sha256`: SHA-256 of canonical JSON for the root content excluding only `review`. Object keys are sorted recursively; array order is retained. This lets a recorded review bind the content it actually considered.
- `errors`: structural failures, with field locations.
- `review_blockers`: missing, failed or unfinished review declarations.
- `reference_method_counts`: preserves each declared method without upgrading automated analysis to firsthand viewing.
- `limitations`: the checks do not establish factual truth, reuse rights, semantic payoff, actual reviewer behavior or creative quality.

Exit `0` means the packet reports candidate readiness; exit `1` means invalid input or review remains incomplete/negative. A structurally valid draft with `unreviewed` checks exits `1` with `structurally_valid: true`. That is the intended draft state, not a reason to fabricate a pass.

`ready_for_candidate` is a preparation signal based on declarations, not an independently established editorial decision. The validator cannot know whether a reviewer actually watched, whether a source supports a claim, or whether a linked payoff answers its question. Someone must perform those checks and describe the basis honestly. Final script, factual, listening, whole-cut and release decisions remain separate.

## Exact packet schema

Every field below is required. Unknown fields are rejected to catch misspellings and accidental approval flags. Nonblank string means a string containing at least one non-whitespace character. IDs are exact, case-sensitive strings; source and beat IDs must be unique across both arrays. Arrays must be nonempty except `payoff_for`.

| Object | Fields and rules |
| --- | --- |
| Root | `schema: "crimedungeon_editorial_packet_v1"`, `package`, `sources`, `beats`, `opening`, `references`, `review` |
| `package` | Nonblank strings `title`, `premise`, `viewer_question`, `promised_answer`, `thumbnail_moment`. The latter describes the actual selected moment or explicitly states the missing frame to find. |
| Each `sources[]` row | `id`, `url`, `in_sec`, `out_sec`, `context_before`, `context_after`, `claim_supported`, `picture_origin`, `audio_origin`, `use_basis`. All except times are nonblank strings. URL must be HTTP(S) without embedded username/password. Times must be finite, with `0 <= in_sec < out_sec`. Record source-player seconds, not an event's clock time. |
| Each `beats[]` row | `id`, `start_sec`, `end_sec`, `question`, `source_ids`, `mode`, `picture_action`, `audio_action`, `what_changes`, `payoff_for`, `next_question`. Times are finite with `0 <= start_sec < end_sec`; arrays contain unique nonblank IDs. Other fields are nonblank strings with `mode` restricted below. |
| `opening` | Finite nonnegative `question_by_sec`, nonblank `first_payoff_beat_id` and `package_connection`. The payoff ID names the earliest beat with a nonempty `payoff_for`. The question is introduced no later than that beat's end. |
| Each `references[]` row | `url`, `in_sec`, `out_sec`, `observed`, `method`, `application`. URL and time rules match sources. Other fields are nonblank strings with `method` restricted below. |
| `review` | Nonblank `reviewer`, `notes`; `method`; five checks `package_alignment`, `source_context`, `payoffs`, `media_motivation`, `factual_limits`; `decision`; `reviewed_content_sha256` as `null` or a lowercase 64-character hexadecimal SHA-256. Allowed values below. |

This narrow version describes timed audiovisual selections. A document used in a beat can be cited in the relevant source's `claim_supported` or context text; do not invent video timecodes for a standalone document. Extending the schema for page/paragraph selections requires an explicit later change. No public URL is fetched or approved by this check; never include signed media URLs, tokens or session data.

### Beat modes and timing

Allowed modes are `source_scene`, `social_claim`, `original_audio`, `narration_bridge`, `document`, `map_timeline`, `reconstruction`, `transition`, `conclusion`.

The first beat must be `source_scene`, `social_claim` or `original_audio`. Every beat names at least one existing source ID. A transition or narrator bridge can reference the evidence it connects or explains. These labels describe the paper edit; they do not authorize a recreation or expand any frozen workflow's supported media.

Start at zero, allowing up to 0.1 seconds of rounding. Beat starts and ends increase in array order; adjoining boundaries differ by at most 0.1 seconds. The check does not enforce a total runtime, footage share, cut frequency, narrator quota or arbitrary rehook interval. The applicable proof/production workflow separately governs runtime.

`payoff_for` contains IDs of earlier beats or the current beat. Future and unknown IDs fail. Use an empty array when no answer is delivered yet. At least the beat named in `opening.first_payoff_beat_id` must link a payoff. `question` and `what_changes` must describe the narrative work; the checker verifies that they are present, not that the prose succeeds. For a closing beat, `next_question` can explicitly say the local question is closed and identify any remaining uncertainty; do not invent a cliffhanger to fill the field.

### Reference observation methods

- `direct_playback`: the stated bounded passage was actually watched and listened to. `observed` should describe only what that review supports.
- `frame_inspection`: inspected still frames; this does not establish motion timing, sound or full-sequence pacing.
- `transcript_review`: examined the passage's words; this does not establish the picture or mix.
- `automated_analysis`: tool-generated scene/audio analysis, retained as a lead rather than firsthand viewing.

References can mix these methods. No method is converted into another, and an automated result is not evidence that a person watched. Non-playback methods remain valid research entries; their presence alone does not prove a style comparison is ready. The reviewer must address that limitation in the packet rather than treating a valid JSON file as a completed review.

### Review values

Each of the five checks uses `pass`, `fail` or `unreviewed`. Review method is `paper_edit`, `direct_playback` or `unreviewed`. Decision is `revise` or `ready_for_candidate`. Use `unreviewed` and `revise` while the work remains pending; identify the reviewer as `unassigned` if none has reviewed it yet and explain the open work in `notes`.

Set `reviewed_content_sha256: null` in a draft. The checker reports the current `content_sha256` without changing the packet. Only after the reviewer has actually completed the stated review of that exact content should they copy the reported hash into `review.reviewed_content_sha256` and record their decisions. A null or mismatched hash blocks readiness even if every review field says `pass`. Changing a title, source context, beat or reference makes the earlier review stale; perform the appropriate review again rather than automatically replacing the hash. Reordering object keys does not invalidate the hash, while changing array order does. Review notes and decisions are excluded from this content hash so the reviewer can record the result without a circular dependency.

A paper edit review can assess structure and source-context work before a cut exists. It cannot stand in for listening to generated speech or watching a completed mix. `direct_playback` records an actual review method, not a stronger authorization. A failed check still blocks preparation readiness even if the decision string says `ready_for_candidate`.

## Verification

```sh
node scripts/tests/crime-editorial-review-tests.mjs
```

Provider-free synthetic fixtures exercise malformed/blank fields, timing and cross-reference errors, reference-method separation, incomplete/failed review blocking, null/stale review bindings and CLI refusal without writes. A fixture with passing declarations proves the checker accepts the intended structure; it does not prove a real case's facts or establish an editorial approval.
