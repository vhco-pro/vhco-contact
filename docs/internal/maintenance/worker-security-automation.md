# Maintenance for Worker security automation

## Definition

Outcome: Enable weekly dependency update checks and CodeQL for vhco-contact.
Preserved contract: Existing build, release and deployment workflow behavior and executable dependency pins.
Task base: 9f478ea7f4742e6e1b956a6bec050e4d8147e49e
Affected paths: .github/dependabot.yml,.github/workflows/codeql-actions.yml,.github/workflows/delivery.yml
Verification inputs: The workflows, dependency updater configuration, shared CodeQL v1.2.4 interface, and existing repository source and lockfiles.
Proposed change: Reuse the org Dependabot baseline and pinned CodeQL workflow.
Required checks: actionlint, YAML policy checks, and existing runtime checks where available. Confirm hosted scans and Dependabot runs after merge.

## Evidence

No Dependabot version config or CodeQL results were present at the base. Local actionlint and updater policy checks passed. Existing delivery workflow YAML parses to the same values as the base.

Contact type checks, lint and all 79 Worker tests passed. The existing JS/TS CodeQL job requires the repository variable WORKER_CODEQL_ENABLED=true.

## Reviews

### R-1

Target: 41ee6c02b19821fb03ea184eb7dac41ebfa08b9e
Model: unknown
Isolation: procedural

```text
NO FINDINGS
```

## State

Local checks and independent review passed. Hosted verification is pending.
