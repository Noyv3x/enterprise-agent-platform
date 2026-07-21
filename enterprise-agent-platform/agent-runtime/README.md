# ubitech agent runtime

This directory contains the platform-owned Node.js Agent runtime. Its architecture, policy, configuration, and private protocol are defined only in the repository's canonical documentation layer:

- [Agent runtime design](../../docs/design/agent-runtime.md)
- [Runtime API](../../docs/reference/runtime-api.md)
- [Configuration reference](../../docs/reference/configuration.md)
- [Executable runtime policy](../../docs/contracts/runtime-policy.json)

This README is a package entry point and does not redefine those contracts.

## Build and verify

```bash
npm ci
npm run check
npm test
npm run build
```
