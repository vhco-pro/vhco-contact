# VH & Co contact Worker

Private Cloudflare Worker for contact enquiries from `vhco.pro` and
`stackweaver.sh`. Each site hosts its own form and posts JSON to the same
origin at `/api/contact`.

| Target | Worker | Edge route | Protected environment |
| --- | --- | --- | --- |
| `vitepress` | `vhco-contact` | `vhco.pro/api*` | `contact-vitepress` |
| `stackweaver` | `vhco-contact-stackweaver` | `stackweaver.sh/api/contact*` | `contact-stackweaver` |

Each Worker has its own Turnstile widget, secret bindings and SQLite Durable
Object namespace. Both deliver to the configured VH & Co inbox. Stackweaver
enquiries have a distinct subject. The visitor address is used for Reply-To.

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
Set `HMAC_SECRET`, `TURNSTILE_SECRET` and `SENDER_EMAIL` as Worker bindings on
the corresponding Cloudflare Worker.

Initial provisioning, route changes and Durable Object migrations need a
separate runbook and recovery plan. Activation expects an already-provisioned
Worker. Record the active and previous version from the deployment receipt.
An approved rollback restores a previous Worker version on the selected
target. It leaves Durable Object state in place. Before enabling the form,
verify the edge route and a controlled inbox receipt with the expected Reply-To.

Worker source and the original contract tests came from VitePress PR #30 at
`a95b5eadc8b208bdf6acfb2852c2a26a6a230b48`.
