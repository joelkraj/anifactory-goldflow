# Exact operator release and power-system review

`script approve` normally requires a passed, current `power_system_comprehension_audit.json`. This remains the default. When an operator has already reviewed and explicitly released the exact source, an agent may record the operator's accepted editorial risk instead of manufacturing a passed audit or rewriting the approved story to satisfy its before-payoff rule.

Use the existing guarded approval command with the exact current script hash and an explicit exception:

```bash
node bin/goldflow.mjs script approve --channel <channel> --series <series> --week <run> --episode <episode> --hash <exact-script-sha256> --accept-power-system-editorial-risk true --power-system-editorial-reason "<operator release evidence and the specific accepted comprehension/editorial risk>" --summary "<actual agent review coverage and findings>"
```

The reason must contain at least 40 characters after whitespace normalization. Record the actual operator authorization and reviewed risk; a generic instruction to save time is not a substitute for an exact-source release. Do not claim complete-script review or listening unless it occurred. Existing authorization in the conversation may supply the release; this option does not demand a second user approval.

All three approval/lock artifacts bind the current source hash and preserve `power_system_editorial_exception` provenance. With no structured audit, its status is `not_performed_operator_editorial_exception`, its audit path/hash are null, and `comprehension_audit_pass_claimed` is false. An existing readable audit remains byte-identical and hash-bound with its original status and current validation findings; accepting the editorial risk never turns those findings into a passed audit. Unreadable audit files still require triage.

This option changes only the power-system editorial prerequisite for that explicit approval call. It does not change source words, accept a wrong hash, waive meta-contamination checks, release other source versions, satisfy factual-evidence requirements, skip downstream media/QA gates, or authorize publication. Later calls retain the normal audit-required default unless they explicitly record another exact-source exception. Run status after approval and follow its next valid command.
