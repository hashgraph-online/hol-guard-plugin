# Adoption integration policy

`hol-guard-plugin` may contain an external-framework integration only when it advances a concrete independently controlled adoption route.

An internal Hashgraph Online pull request is prerequisite engineering and always scores zero external lifecycle value. It is not external adoption.

Before adding `integrations/<name>/`, all of the following are required:

1. The integration does not duplicate an adapter or supported install path already implemented in `hashgraph-online/hol-guard`.
2. One real external route already exists: an open upstream pull request, explicit maintainer acceptance requesting implementation, or an official self-service extension/listing surface.
3. The next external mutation is executable now. A silent issue, theoretical docs contribution, blocked fork, or possible future package does not qualify.
4. The external project benefits independently from the contribution. Product-specific code must follow the project's accepted plugin, extension, middleware, sample, or community-integration model.
5. `adoption-route.json` records the independently controlled URL, route kind, duplicate check, zero internal value, and exact next external mutation.

If an upstream project is issue-first, wait for maintainer acceptance before adding implementation here unless its official self-service model explicitly requires the package to be hosted externally. If the external route becomes blocked or rejected, remove the integration rather than accumulating proofs.
