# Manhwa Recap Story Blueprint V1

Use this prompt through `goldflow source blueprint` after one package is approved. The blueprint decides story truth and causal structure before the long narration is written. It is not narration and must not contain polished prose for the final script.

```text
You are the story architect for one approved Manhwa Joey package.

Build a complete causal blueprint for the eventual long-form spoken recap. Protect the exact title and thumbnail promise. Do not rewrite the approved package, add a second power source, or invent spectacle that does not grow from the approved premise.

The blueprint has one job: make the eventual narration coherent, fast, satisfying, and difficult to derail across a long runtime.

STORY TRUTH

- Choose one stable narration POV and one stable tense. Third-person present is the market default. First-person or past tense is allowed only when it materially strengthens this package, and it must remain stable from the first line to the last.
- Canonicalize every recurring character once. Give each one a clear role, desire, relationship to Joey, and story function.
- State the advantage rules exactly. Separate what the advantage supplies from what Joey must decide, learn, build, buy, persuade, or physically execute.
- Preserve the approved title facts, thumbnail proof, first proof, causal scale path, antagonist loss, climax, final boundary, and ending.
- Use only the recurring locations, props, and UI motifs needed to make the story understandable and visually varied.

OPENING

Choose the opening mode that fits the package:

1. visible_proof_or_payoff
2. wound_or_identity_contradiction
3. direct_premise_or_mechanic

Map five opening windows: zero to thirty seconds, thirty to sixty, sixty to ninety, ninety seconds to three minutes, and three to five minutes. Each window must advance the live story. Give it a concrete event, consequence or state change, and the question that pulls the viewer forward.

Do not preview a later scene and then replay the same scene in full. If the story rewinds, visible proof must come first and the rewind must add new information rather than duplicate the hook.

CAUSAL MOVEMENTS

Build eight to ten movements that cover the complete target word range. Each movement must have a unique function and a different live objective, obstacle, tactic, result, or relationship change.

Every movement follows this logic:

START STATE -> OBJECTIVE -> OBSTACLE -> JOEY'S CHOICE -> CONCRETE EXECUTION -> RESPONSE -> RESULT -> STATE CHANGE -> NEXT QUESTION

The result of one movement must cause or constrain the next movement. Do not create a list of interchangeable episodes. Do not repeat the opening humiliation under new names. Do not let procedure, paperwork, meetings, or system windows become the entertainment.

Joey should win by making intelligent choices with established leverage. The antagonist should adapt using facts they could actually know. Allies must have specific practical value rather than existing only to praise Joey.

The climax must actively perform the title reversal. The ending must show the promised concrete loss, Joey's final boundary, and one concise changed equilibrium. End once the emotional and physical payoff is complete.

OUTPUT

Return exactly one JSON object and nothing else. Do not use Markdown fences.

Use this shape:

{
  "schema": "goldflow_winner_story_blueprint_v1",
  "status": "draft",
  "channel": "CHANNEL",
  "development_slug": "DEVELOPMENT_SLUG",
  "selected_candidate_id": "SELECTED_CANDIDATE_ID",
  "selected_title": "SELECTED_TITLE",
  "narration_contract": {
    "pov": "third_person or first_person",
    "tense": "present or past",
    "voice": "one concise description of the spoken recap delivery",
    "dialogue_policy": "what remains direct dialogue and what is compressed into recap narration",
    "choice_reason": "why this stable POV and tense fit this package"
  },
  "opening_contract": {
    "mode": "visible_proof_or_payoff, wound_or_identity_contradiction, or direct_premise_or_mechanic",
    "rewind_policy": "linear, or one concise explanation of why a non-repeating rewind is useful",
    "checkpoints": [
      {
        "id": "0_30_seconds",
        "target_word_end": 94,
        "visible_event": "what the viewer sees happening",
        "consequence_or_state_change": "what becomes newly true",
        "viewer_question": "the live question pulling into the next window"
      },
      {
        "id": "30_60_seconds",
        "target_word_end": 188,
        "visible_event": "event",
        "consequence_or_state_change": "change",
        "viewer_question": "question"
      },
      {
        "id": "60_90_seconds",
        "target_word_end": 281,
        "visible_event": "event",
        "consequence_or_state_change": "change",
        "viewer_question": "question"
      },
      {
        "id": "90_180_seconds",
        "target_word_end": 563,
        "visible_event": "event",
        "consequence_or_state_change": "change",
        "viewer_question": "question"
      },
      {
        "id": "180_300_seconds",
        "target_word_end": 938,
        "visible_event": "event",
        "consequence_or_state_change": "change",
        "viewer_question": "question"
      }
    ]
  },
  "canon": {
    "protagonist": {
      "name": "Joey Manhwa",
      "initial_condition": "plain starting condition",
      "core_desire": "what Joey actively wants",
      "final_condition": "the promised changed state"
    },
    "recurring_characters": [
      {
        "id": "stable_snake_case_id",
        "name": "name",
        "role": "story role",
        "relationship_to_joey": "relationship",
        "desire": "what this person wants",
        "practical_story_function": "how this person changes choices or outcomes"
      }
    ],
    "advantage_rules": ["one exact rule per row"],
    "execution_bridges": ["capabilities, people, resources, training, authority, or infrastructure needed to act"],
    "recurring_locations": [
      {"id": "stable_id", "name": "location", "story_function": "why it recurs"}
    ],
    "critical_props_or_ui": [
      {"id": "stable_id", "name": "prop or UI motif", "story_function": "what it proves or enables"}
    ],
    "immutable_facts": ["facts the eventual script may not contradict"]
  },
  "movements": [
    {
      "id": "movement_01",
      "target_words": 1200,
      "start_state": "what is true at the start",
      "objective": "the immediate goal",
      "obstacle": "specific resistance",
      "joey_choice": "the decision only Joey makes",
      "concrete_execution": "what Joey and established allies physically or practically do",
      "opposition_response": "how the obstacle or antagonist reacts",
      "result": "the concrete outcome",
      "state_changes": ["at least two durable changes"],
      "cause_into_next": "how this result creates the next movement",
      "unique_function": "why this movement cannot be removed or swapped",
      "location_or_arena": "the dominant environment or social arena",
      "package_payoff_role": "opening proof, rule proof, expansion, adaptation, setback, climax setup, climax, or resolution"
    }
  ],
  "climax_contract": {
    "setup_paid_off": ["earlier facts, allies, resources, and choices used here"],
    "joey_decisive_action": "the active title-native action",
    "antagonist_response": "the competent final response",
    "visible_result": "what the viewer can see has changed",
    "antagonist_concrete_loss": "the approved symmetrical loss"
  },
  "ending_contract": {
    "final_boundary": "Joey's final choice or refusal",
    "changed_equilibrium": "one concise final state",
    "stop_point": "the exact emotional beat after which the story ends"
  },
  "continuity_watchlist": ["facts most likely to drift in a long draft"],
  "repetition_watchlist": ["scenes, lessons, conflicts, or phrases the writer must not repeat"],
  "section_plan": [
    {
      "id": "section_01",
      "movement_ids": ["movement_01", "movement_02"],
      "entry_state": "state entering this writing section",
      "exit_state": "state that must be true when it ends"
    }
  ]
}
```

The supplied target WPM determines the example word endpoints. Use the actual approved package's WPM and word range, not the literal example numbers when they differ.

