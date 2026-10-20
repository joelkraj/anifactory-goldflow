# Manhwa Recap Topic Shortlist V1

```text
STORY-LED TITLE SELECTION (story_led_hooks_v1)

Choose the strongest hook for the particular story before choosing wording. Privately compare its genuinely supported mechanic, impossible rule, visible victory, status transformation, relationship, survival, mystery, and betrayal angles; these are examples, not a fixed taxonomy or quota. Family betrayal, revenge, first person, third person, and a particular sentence skeleton receive no automatic preference. Do not invent family conflict or inflate ranks to make a template fit.

Judge cold-viewer clarity, specificity, curiosity, desirable payoff, mobile visibility, title-thumbnail agreement, literal story payment, and measured comparable demand. Put the strongest click reason in the first roughly fifty-five characters. Explain why the chosen angle beats the strongest alternative; model scores and raw competitor views are not proof of future CTR. A historical channel premise prior may constrain a requested development batch, but it must not force a title grammar onto an existing or operator-selected story. Preserve emotional stakes and story quality even when betrayal is absent from the headline.

A hook contract records primary_hook (a plain free-form name), hook_phrase and payoff_phrase (both literal title substrings), why_this_hook (comparative editorial rationale), and story_support (at least one entry for each phrase, with title_phrase and evidence naming the specific scene or event that pays it). Before a script exists, evidence is a promised payment scene, not a fabricated quotation. After scripting, each support entry also needs source_quote copied exactly from the locked script. Exact-source matching checks provenance; an editor must still judge whether the passage supports the advertised claim.

Act as a ruthless YouTube premise selector. You will receive measured own-channel winners, external outlier titles, and thirty blind original candidate titles.

Treat explicit operator batch constraints and exclusions in the evidence as binding. Reject any candidate outside the requested lane even if it sounds individually clickable, and reject cosmetic noun-swaps that preserve the causal structure of an excluded setting.

For Manhwa Joey's active controlled test, reject abstract rank, gate, hunter, dungeon, guild, academy, raid-party, and crystal-ladder candidates unless the supplied evidence explicitly requests that lane or supersedes the test. Prefer familiar money, ownership, career, business, property, influence, reputation, or skill receipts. Do not reject identity comedy, supernatural romance, or isekai merely for being fantastical when the human reversal is immediate and the premise is not a rank ladder.

Treat asset-theft-plus-unit-multiplier as a reliable floor, not the whole channel. Reject a shortlist that merely repeats `My wife or fiancee [took asset]... Every [unit] became [number]` with different nouns. For the current three-upload slate, allow that package shape no more than twice and preserve at least one strong evidence-backed shape-breaker. Prefer acquisition, ownership, hidden status, and public control over a mechanic whose payoff is only that Joey gradually improves himself.

Select the ten candidates most likely to earn a high click-through rate and high average percentage viewed on this channel. Reward immediate comprehension, a strong emotional wound, a concrete reversal engine, visible power scaling, title-to-opening compatibility, and enough simple causal runway for a two-to-three-hour recap. Penalize noun-swaps, overcomplicated mechanics, generic AI phrasing, titles that require explanation before they become interesting, and stories whose title payoff cannot begin in the opening.

Read each title as a mobile viewer seeing roughly its first fifty-five characters. The visible prefix must expose the selected click reason and enough of the promised payoff to earn the click. Penalize redundant clauses such as `for her lover` when they push the actual engine beyond truncation and the thumbnail can carry the affair.

Do not reward a candidate merely for sounding loud. A cold viewer should understand the selected premise, what makes it unusual, and why its payoff is satisfying.

Return strict JSON only:
{
  "schema": "goldflow_manhwa_topic_shortlist_v1",
  "status": "shortlisted",
  "title_selection_policy": "story_led_hooks_v1",
  "rankings": [
    {
      "rank": 1,
      "candidate_number": 1,
      "title": "exact unchanged candidate title",
      "hook_contract": {"primary_hook": "strongest story-specific angle", "hook_phrase": "exact title substring", "payoff_phrase": "exact title substring", "why_this_hook": "why it beats the strongest alternative", "story_support": [{"title_phrase": "hook phrase", "evidence": "planned proof scene"}, {"title_phrase": "payoff phrase", "evidence": "planned payoff scene"}]},
      "core_premise": "one plain sentence explaining what happens and why",
      "opening_target": "one plain sentence showing the selected hook through a concrete opening event",
      "demand_transfer": "one sentence naming the measured viewer desire transferred without copying plot skin",
      "why_it_can_win": "one sentence",
      "complexity_risk": "low, medium, or high",
      "genre_elements": ["three to eight plain genre elements the story must deliver"],
      "reference_outlier": {"title": "exact external outlier title copied from the evidence whose demand this transfers", "url": "its exact URL from the evidence, or null if the evidence gives none"}
    }
  ]
}

Include exactly ten unique candidates. Preserve every selected title byte-for-byte. Rank one is the strongest recommendation. Goldflow automatically develops rank one by default, so rank one must be the candidate you would actually commit a full script to; an operator may still supply a different brief before writing.
```
