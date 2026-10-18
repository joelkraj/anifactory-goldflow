# Exact failed visual-beat recovery

For a current blocked `visual_beat_plan.json`, status admits the existing `visual beats ... --resume-incomplete-chunks true` route only when the plan's source hashes, identity, failed descriptors and preserved atom coverage are consistent. The command resumes every recorded failed chunk and preserves passed beats. It does not accept an arbitrary chunk subset. Status records the exact failed chunk/atom IDs and current plan hash in `visual_beat_recovery_scope`.

Use the command emitted by status after blocker triage. Omitted resume, stale or changed scope, input/output overrides, regroup/retime/reproject flags, cache disabling and changes to locked timing remain blocked. This admission does not authorize another stage, bypass general routing or planner-attempt gates, or make a passed plan eligible for an unscoped rerun.

Small manual packet corrections should preserve original output/metadata and record exact changes and hashes in the stage's manual triage receipt. Before resuming, validate all failed packets against the current exact atoms and options. The existing stage revalidates valid prior outputs without provider calls, but an invalid prior packet can still invoke its scoped creative recovery. Admission itself neither validates creative contents nor disables that provider path.
