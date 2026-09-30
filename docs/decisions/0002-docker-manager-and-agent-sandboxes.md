# 0002: Host Manager and agent sandboxes

- Status: accepted; execution scope updated for Pi-native R2.

## Decision

The host Manager owns Docker, public ingress, release operations and audited sandbox execution. Platform and Runtime remain managed containers without Docker access. Tenant commands run only in sandboxes; there is no host-execution or approval escape hatch.

Personal AI and each channel have their own workspace/sandbox. Standard chat uses a lightweight network-disabled sandbox per user and per-conversation directories, not per-conversation security boundaries. Profiles and data mounts are specified in [data layout](../reference/data-layout.md).

## Consequences

Pi supplies agent sessions/tools but is not the isolation boundary. Remote operations preserve the sandbox boundary; host secrets/environment never reach tenant commands. Manager M1 must precede the reduced-image R2 release. See [security](../design/security-and-trust.md) and [deployment](../operations/deployment.md).
