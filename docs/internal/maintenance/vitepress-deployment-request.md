# Maintenance for solo VitePress deployment approval

## Definition

Outcome: Allow the sole owner to approve a VitePress production deployment requested by GitHub Actions.

Task base: `58972757a6eecf22428f814132e4e6c03e6f64c1`.

Affected paths: `.github/workflows/delivery.yml` and `README.md`.

Preserved contract: The child run still uses the existing exact-release activation and protected VitePress environment. The requester can only dispatch a VitePress deployment from the default branch and receives no Cloudflare credentials.

Required checks: Workflow lint, exact-release and target guard checks, independent review, and a read-back of the child run's actor and pending human approval before activation.

## Evidence

The owner is the only human approver. GitHub Actions supports dispatching a workflow with its short-lived repository token. The environment keeps self-review prevention and its main-only rule.

## Reviews

## State

Hosted approval read-back remains pending.
