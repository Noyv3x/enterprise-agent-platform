# Automatic updates

Manager owns discovery, pulls, maintenance, snapshots, migration, activation and recovery. See [deployment](deployment.md) for installation and R2 staging, and [data layout](../reference/data-layout.md) for retained state.

## 发布通道

Release manifests remain schema 2 / protocol 2. Each same-repository `main` push starts `Container release`, which runs the reusable `Quality gates` workflow at the exact pushed commit in parallel with release preparation, image/Manager builds and user-systemd activation checks. PRs and manual Quality runs execute Quality checks only; they cannot start release builds or authorize publication. Every main commit runs the complete quality and smoke checks and builds Manager binaries at that commit; unchanged built images reuse the exact multi-architecture digest from the currently published main release.

Publication requires every Quality check, upstream validation, both-architecture image and Manager builds, the closed image catalog, anonymous pulls, Core Compose smoke and user-systemd activation to succeed. Builds may upload commit-tagged images before Quality finishes; these are not an authorized release or channel promotion. Images use immutable digests; Manager and Compose bytes have verified SHA-256 identities. Publish the complete immutable release, verify its public assets/images, then advance latest under the existing serialized channel/ancestry rules. Never move an existing release tag or fill a half-published generation with different bytes. Recheck that the source remains an ancestor of main and that latest is an ancestor of the source while holding the publication lock; a superseded or divergent generation cannot rewind latest.

The eight public assets remain `release.json`, `agent-platform-compose.yaml`, `install.sh`, `install.sh.sha256`, and `agent-platform-manager-linux-{amd64,arm64}` with their `.sha256` files.

For `platform`, `agent-runtime`, `camofox` and `agent-sandbox`, release preparation fingerprints the Dockerfile, consumed context paths (including lockfiles, copied generated contracts and scripts), content-affecting build arguments, anonymously resolved base-image digests, image-capacity verification policy and the workflow's `BUILD_INPUTS_SALT`. The fingerprint is stored only in the image configuration label `io.agent-platform.build-inputs`, never in `release.json`. Commit/version labels are excluded: reused images retain their original provenance and labels, while the release and Manager version identify the new commit. Missing/unreadable previous releases or missing/mismatched labels trigger builds. Increment `BUILD_INPUTS_SALT` in the release workflow to a fresh value to force all four images to rebuild with fresh layer-cache namespaces; upstream package changes not represented by a base digest or lockfile also require a salt bump. SearXNG retains its pinned upstream-image handling.

Preparation resolves the four components and independent base/architecture metadata concurrently. Shared base and registry requests are deduplicated within the run; output component order and failure behavior remain deterministic. There is no cross-release metadata cache: every release resolves mutable upstream references again.

Newly built digests receive full anonymous pulls on both architectures. Reused digests receive anonymous index and platform-manifest availability checks on both architectures, including compressed-size limits; their previously verified unpacked size remains valid for the identical digest. Core Compose smoke always runs against the final catalog. Reuse metadata is an internal CI artifact, not an additional release asset.

Manager accepts exactly `platform`, `agent-runtime`, `camofox`, `agent-sandbox` and `searxng`, not arbitrary subsets or the retired ten-image catalog. Firecrawl is not pulled, started, probed or reported in service status. Retained Firecrawl data stays untouched.

## Detection and pulls

Manager polls the configured channel; `check` may persist a candidate but never creates an update operation. An automatic update applies only the release the check accepted; a stale or changed manifest response is retried without restarting services. Candidate protocol, identities, digests and schema boundaries must validate before disruption. Network/space failures leave the current generation running.

Default manifest checks and artifact downloads use fresh HTTP connections, retaining the 30-second request timeout and environment-configured proxy support. Conditional checks still retain bounded cache validators; connection freshness does not bypass manifest validation or artifact checksum verification.

Manager prefetches Platform, Runtime and `agent-sandbox` before maintenance, avoiding a first-command sandbox image pull after release. An already-present exact RepoDigest is reused. Missing images are pulled with at most three concurrent workers after reserving their combined capacity once; each exact digest is verified. Failure cancels and joins the remaining workers before returning. Pulls and maintenance are separate phases; do not interpret download success as readiness.

## 排队与维护

Operations retain their idempotency key, request identity, generation and persistent phase. Reusing a key with different input is a conflict; an uncertain response is reconciled with the same operation, never blindly retried as a new operation.

While waiting for an operation, the CLI tolerates a restarting Manager's missing/refused/reset socket, EOF, or HTTP 503 specifically reporting `launcher startup proof pending`. It retries only its status GET, with backoff from 500 ms to 4 seconds and a ten-minute deadline; deterministic errors and unrelated HTTP failures still fail immediately. It never replays the operation POST. The command reports the actual terminal success/failure; loss of the polling connection is not evidence that the operation failed or should be submitted again.

1. Wait for the Platform's natural idle boundary: no active/queued agent work (including queued task notices and running subagents) or admissions.
2. Reserve with the existing operation ID, persist maintenance, and reconfirm the same reservation before stopping writers. Manager remains the ingress and serves maintenance.
3. Stop the old writer, verify a snapshot and run the fixed migration command. Start and probe the candidate with admissions still frozen.
4. Settle the owner-bound commit/abort reservation and restore ingress only after core and Manager readiness are confirmed.

The exact readiness fields are `reserved`, `active_agent_tasks`, `queued_agent_jobs`, `running_agent_jobs`, `admissions_in_progress` and `blocker_error`. See the [Platform contract](../reference/platform-api.md).

Manager-supervised background processes do not block an update. A running process keeps its sandbox resident, so the idle stop and obsolete-image replacement skip it until it ends. Replacing the Manager (startup stops all sandboxes) ends every running process: it is recorded `interrupted` with reason `system_restart` and never restarted.

Running personal-AI subagents are agent work: they count in `active_agent_tasks` and block the update until they finish (or are stopped by the user), so no child is cut off by a Platform replacement. If Platform nevertheless restarts or loses a child's Runtime stream, that task becomes `interrupted` and is never replayed. A process that finishes while an update is reserved is recorded by the watcher afterwards; its task notice is created once admissions reopen.

## 提交回滚与能力降级

Core readiness covers Manager, Platform, Runtime and public ingress. Camofox and SearXNG may be degraded independently; MCP is workspace configuration, not a managed release service.

Before commit, a failed candidate is stopped and the validated snapshot/previous generation restored by the same operation. After commit, preserve new business writes and settle forward; do not automatically overwrite them with old data. A failed response does not prove an operation had no effect. Manager control and maintenance remain available for diagnosis.

Platform migrations only move forward; they run once per version on `schema_migrations`. A binary rollback is not a full-data rollback; see [backup and recovery](../reference/data-layout.md#备份与恢复).

## Manager 自更新

The independent launcher verifies and supervises the selected Manager. Keep the current and one verified previous binary. Startup identity/health failure triggers the existing single rollback to the previous binary; repeated switching is not recovery. Once committed, ordinary process restart uses the selected version, not an automatic business-data rollback.

The simplified Manager is installed through the existing launcher's normal self-update protocol. Stable command/config/socket paths, binary metadata and launcher ownership remain unchanged; the immutable launcher is not replaced.

Startup sandbox cleanup force-stops the complete ownership-validated running set
in one batch, within a 15-second total deadline including transient Docker retries
and stopped-state confirmation. This leaves room inside the installed launcher's
60-second child-proof deadline; cleanup uncertainty still prevents readiness.
Before launcher proof, authenticated `/v1/status` remains available for gate
recovery, but operation reads remain unavailable: their durable `succeeded`
record can still precede Manager activation and be rolled back by startup recovery.
An older CLI that does not retry the proof-pending 503 may report a polling error
during this transition even though the update later succeeds; inspect status
without resubmitting the operation.

`update.json` schema 1 is the sole state and operations authority. Existing installations require a checkpoint without a provisional `bridge_transition`; legacy `state.json` and `operations/` are neither imported nor modified. A missing checkpoint initializes only a fresh installation with neither legacy path present. Malformed, unsupported or provisional checkpoints fail closed. Operation identities, generation CAS, idempotency bindings and forward-only gate settlement intent remain unchanged.

## 手动恢复

Use `agent-platform-manager status`, `logs`, `preflight` and the operation controls first. If Manager cannot start, stop its unit and preserve state/logs. Recover only the exact verified binary selected by `manager/manager-binaries/launcher-state.json` from its immutable release, retaining permissions and identity. Do not hand-edit selection, operation or reservation records. Restore data only from a consistent recovery point after preserving newer writes.

## Cleanup

After a successful update, retain images referenced by current and previous generations plus running sandboxes. Delete only other deployment-owned images by exact ID; never blanket-prune Docker or touch unrelated workloads. Current/previous metadata, binaries, snapshots and in-flight candidates stay protected. Unknown ownership or damaged metadata is not deletion authority.

While a running sandbox references an older generation's image, retain that generation's verified release directory as ownership evidence. Do not force-delete images used by containers. Cleanup failure is reported and remains retryable without invalidating an already committed release.

Idle sandbox stop does not delete user workspaces. Keep diagnostics bounded and free of credentials. Verification requirements live in [testing](../development/testing.md).
