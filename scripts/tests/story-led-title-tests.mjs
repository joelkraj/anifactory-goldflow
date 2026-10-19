import assert from 'node:assert/strict';
import { STORY_LED_TITLE_POLICY, validateStoryLedTitle } from '../lib/story-led-title.mjs';
import { validateYoutubePackagingSpec } from '../lib/youtube-publish-contract.mjs';
import { evaluateWinnerIdeation } from '../lib/winner-source-contract.mjs';
import { validateManufacturingTopicShortlist } from '../lib/source-manufacturer-contract.mjs';
import { validSpec } from './youtube-publish-contract-tests.mjs';
import { validFormula, validIdeation } from './winner-source-contract-tests.mjs';

const source = 'He combined spare skills into a new technique. The arena champion yielded to him.';
const hook = {
  primary_hook: 'an unexpected use of utility skills',
  hook_phrase: 'Fuses Spare Skills', payoff_phrase: 'Defeat the Arena Champion',
  why_this_hook: 'The unusual combination is clearer than the family context and pays off in an actual victory.',
  story_support: [
    { title_phrase: 'Fuses Spare Skills', evidence: 'The combination creates a technique.', source_quote: 'He combined spare skills into a new technique.' },
    { title_phrase: 'Defeat the Arena Champion', evidence: 'The opponent yields.', source_quote: 'The arena champion yielded to him.' },
  ],
};
const title = 'He Fuses Spare Skills to Defeat the Arena Champion | Manhwa Recap';
assert.deepEqual(validateStoryLedTitle(title, hook, { sourceText: source, requireSourceQuotes: true }), []);
const spec = validSpec(new Date('2026-10-18T00:00:00Z'));
spec.title_selection_policy = STORY_LED_TITLE_POLICY;
spec.title_candidates = ['He', 'The Porter', 'The Underdog'].map(prefix => ({
  title: `${prefix} Fuses Spare Skills to Defeat the Arena Champion | Manhwa Recap`,
  hook_contract: structuredClone(hook), explains_full_video: true,
  research_evidence_ids: [spec.research_evidence[0].id], selection_reason: 'Strongest truthful hook for this story.',
}));
spec.selected_title = spec.title_candidates[0].title;
for (const thumbnail of spec.thumbnail_candidates) {
  thumbnail.hook_signal = 'Discarded manuals combine into one technique.';
  thumbnail.payoff_signal = 'The champion’s broken seal shows the result.';
  delete thumbnail.betrayal_signal; delete thumbnail.revenge_signal;
}
spec.description_contract.opening_explains_hook_and_payoff = true;
delete spec.description_contract.opening_explains_betrayal_and_revenge;
spec.pinned_comment.viewer_dilemma = 'Keep refining weak skills or buy one strong skill?';
delete spec.pinned_comment.betrayal_choice;
const options = { scriptText: source, now: new Date('2026-10-18T00:00:00Z') };
assert.deepEqual(validateYoutubePackagingSpec(spec, options).blockers, []);
assert.ok(validateYoutubePackagingSpec(spec, { ...options, scriptText: undefined }).blockers.some(x => x.includes('locked_script_missing')));
const fakePayoff = structuredClone(spec);
fakePayoff.title_candidates[0].hook_contract.story_support[1].source_quote = 'He became an immortal god.';
assert.ok(validateYoutubePackagingSpec(fakePayoff, options).blockers.some(x => x.includes('source_quote_not_in_script')));
const ungrounded = structuredClone(spec);
ungrounded.title_candidates[0].hook_contract.payoff_phrase = 'Unrelated promise';
assert.ok(validateYoutubePackagingSpec(ungrounded, options).blockers.some(x => x.includes('payoff_phrase_not_in_title')));
const unknown = structuredClone(spec); unknown.title_selection_policy = 'unknown';
assert.ok(validateYoutubePackagingSpec(unknown, options).blockers.includes('title_selection_policy_invalid'));
// Existing approved packaging still uses its old contract, including its old failure modes.
const legacy = validSpec(new Date('2026-10-18T00:00:00Z'));
assert.deepEqual(validateYoutubePackagingSpec(legacy, options).blockers, []);
legacy.title_candidates[0].betrayal_phrase = '';
assert.ok(validateYoutubePackagingSpec(legacy, options).blockers.includes('title_candidate_0_betrayal_clause_not_in_title'));

const formula = validFormula(); formula.title_selection_policy = STORY_LED_TITLE_POLICY;
const ideation = validIdeation();
for (const [i, candidate] of ideation.candidates.entries()) {
  candidate.title = `Hero ${i + 1} Fuses Spare Skills to Defeat the Arena Champion | Manhwa Recap`;
  candidate.title_contract = structuredClone(hook);
  candidate.thumbnail.hook_signal = 'A manual transforms.';
  candidate.thumbnail.payoff_signal = 'The champion yields.';
  delete candidate.thumbnail.betrayal_signal; delete candidate.thumbnail.reversal_signal;
}
assert.equal(evaluateWinnerIdeation(ideation, formula).document.candidates[0].computed.eligible, true);
const missingDecision = structuredClone(ideation); delete missingDecision.candidates[0].title_contract.why_this_hook;
assert.ok(evaluateWinnerIdeation(missingDecision, formula).document.candidates[0].computed.blockers.includes('title_hook_why_this_hook_missing'));

const pool = { title_selection_policy: STORY_LED_TITLE_POLICY, candidates: Array.from({length: 30}, (_, i) => ({number:i+1,title:`Hero ${i+1} Fuses Spare Skills to Defeat the Arena Champion | Manhwa Recap`})) };
const shortlist = { schema:'goldflow_manhwa_topic_shortlist_v1', status:'shortlisted', title_selection_policy: STORY_LED_TITLE_POLICY,
  rankings: pool.candidates.slice(0,10).map((c,i) => ({ rank:i+1,candidate_number:c.number,title:c.title,hook_contract:structuredClone(hook),core_premise:'A utility technique wins a contest.',opening_target:'The first combination is demonstrated.',demand_transfer:'A specific mechanic creates a visible victory.',why_it_can_win:'The payoff is immediately understandable.',complexity_risk:'low' })) };
assert.deepEqual(validateManufacturingTopicShortlist(shortlist,{topicPool:pool}).blockers,[]);
delete shortlist.rankings[0].hook_contract;
assert.equal(validateManufacturingTopicShortlist(shortlist,{topicPool:pool}).done,false);
const survival = { primary_hook:'survival',hook_phrase:'Survives the Frozen City',payoff_phrase:'Rescues Every Trapped Neighbor',why_this_hook:'The rescue stakes outperform the irrelevant relationship angle.',story_support:[{title_phrase:'Survives the Frozen City',evidence:'Finds shelter before the storm.'},{title_phrase:'Rescues Every Trapped Neighbor',evidence:'Completes the final evacuation.'}] };
assert.deepEqual(validateStoryLedTitle('He Survives the Frozen City and Rescues Every Trapped Neighbor | Manhwa Recap',survival),[]);
console.log('story-led title tests passed');
