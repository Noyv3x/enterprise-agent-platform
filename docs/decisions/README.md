# Design decisions

Current design is in the [documentation index](../README.md). These decisions explain enduring boundaries:

- [0001: Documentation as design source](0001-documentation-is-design-source.md).
- [0002: Host Manager and sandboxes](0002-docker-manager-and-agent-sandboxes.md), updated for Pi-native R2.
- [0004: Configurable branding and neutral identity](0004-configurable-branding-and-neutral-runtime-identity.md).

The old host-execution approval decision was removed with that feature. R2 permits tenant execution only in sandboxes; it does not replace per-call approval with implicit host access.
