# VH & Co contact Worker

Cloudflare Worker for contact enquiries from `vhco.pro` and
`stackweaver.sh`. Each site hosts its own form and posts JSON to the same
origin at `/api/contact`.

| Target | Worker | Edge route | Protected environment |
| --- | --- | --- | --- |
| `vitepress` | `vhco-contact` | `vhco.pro/api*` | `contact-vitepress` |
| `stackweaver` | `vhco-contact-stackweaver` | `https://stackweaver.sh/api/contact*` | `contact-stackweaver` |

Each Worker has its own Turnstile widget, secret bindings and SQLite Durable
Object namespace. Both deliver to the configured VH & Co inbox. Stackweaver
enquiries have a distinct subject. The visitor address is used for Reply-To.

[Architecture and code map](docs/architecture.md)

## Verify locally

Use Node 24.19.0 with the committed npm lockfile.

```sh
npm ci
npm run check
npm run lint
npm test
```

The CI action verifies the source and builds each target. Its bundle smoke
test starts two isolated Worker instances in one local workerd runtime. It supplies
synthetic Turnstile and email services and exercises routing, deduplication,
quota isolation, subjects and Reply-To against the bundled module.

## Release and activation

Review and protect the default branch and release tags. Enable immutable
GitHub releases and set the repository variable `WORKER_IMMUTABLE_RELEASES_ENABLED`
to `true`. The release publishes a bundle and manifest for each target.
Activation takes an exact tag and one target. It verifies the package lock,
Wrangler version, target config and bundle digest before uploading and
activating the module.

Create separate protected GitHub environments. Set `CLOUDFLARE_ACCOUNT_ID`
and `WORKER_NAME` as environment variables and
`CLOUDFLARE_API_TOKEN` as an environment secret. Restrict the environment to
the reviewed default branch and require an independent deployment approval.
For a sole maintainer, use `request-vitepress-activation` with `vitepress` or
`request-stackweaver-activation` with `stackweaver`, and specify the exact
release tag. GitHub Actions requests the selected deployment using its
short-lived repository token. The owner approves the resulting run in
`contact-vitepress` or `contact-stackweaver`. The request job receives no
deployment credentials.

Set `HMAC_SECRET`, `TURNSTILE_SECRET` and `SENDER_EMAIL` as Worker bindings on
the corresponding Cloudflare Worker.

Initial provisioning, route changes and Durable Object migrations need a
separate runbook and recovery plan. Activation expects an already-provisioned
Worker. Record the active and previous version from the deployment receipt.
Rollback is a separate Cloudflare operation. A rollback restores a previous
Worker version on the selected target and leaves Durable Object state in place.
[Follow the staging and rollback runbook](docs/staging.md) before enabling the form.

## Rehearse a release

After publishing an exact tag, run **Contact Worker delivery** with the
`rehearse` operation and one target. Supply the target's synthetic
`CLOUDFLARE_API_TOKEN` in its GitHub environment using the value
`synthetic-worker-rehearsal-<target>`. Use a 32-digit dummy account ID and
the Worker name from the table. The deploy action checks that it received
the selected environment's token and runs Wrangler's no-bundle dry run
with Cloudflare credentials cleared. Run this separately for each target.

The `activate` operation rejects synthetic tokens and requires the
environment's independent reviewer protection. Replace the synthetic
configuration with production credentials only after rehearsal and review.
