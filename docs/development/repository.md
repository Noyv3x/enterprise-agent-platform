# Repository ownership

Read [product boundaries](../design/product.md), [architecture](../design/system-architecture.md) and the API contracts before changing an interface. The Pi-native rebuild replaces old agent mechanisms rather than wrapping them.

| Path | Owner/responsibility |
| --- | --- |
| `enterprise-agent-platform/enterprise_agent_platform/` | Python Platform: auth, SQLite, durable queue, chat, tools, OAuth and Manager integration. |
| `enterprise-agent-platform/agent-runtime/` | TypeScript Pi AgentSession host, remote tools and sessions. |
| `enterprise-agent-platform/frontend/` | React/Vite product views, API client, localization and preserved visual design. |
| `enterprise-agent-platform/camofox-runtime/` | Browser service adapter. |
| `manager/` | Go host Manager: ingress, lifecycle, executor, release and sandbox profiles. |
| `containers/` | Image/entrypoint/Compose and sandbox helper contracts. |
| `scripts/`, `.github/workflows/` | Local checks, release assembly, smoke and CI. |
| `docs/design/`, `docs/reference/`, `docs/operations/` | Product intent, precise interfaces and operator procedures. |
| `docs/contracts/` | Machine-readable shared values; generate consumers with docs_sync. |

Keep API contracts in [Platform API](../reference/platform-api.md) and [Runtime API](../reference/runtime-api.md), not duplicated across design prose. Update every producer/consumer together. User-facing history is Platform data; model context is Pi session data; sandbox lifecycle is Manager data.

Do not commit generated frontend assets, dependencies, credentials, runtime data or temporary upstream research. Preserve Beautiful UI license/notice assets. For verification use [testing](testing.md); documentation checks and generated contracts follow the [documentation workflow](documentation-workflow.md).
