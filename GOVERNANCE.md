# Governance

vault-cortex is a single-maintainer project. This document describes how
decisions are made, who holds access to which resources, and what happens
if the maintainer steps away.

## Governance model

[@aliasunder](https://github.com/aliasunder) is the sole maintainer and
makes all project decisions — scope, releases, and which contributions
merge. There is no committee or voting process.

Proposals and contributions are evaluated on:

- Fit with the project's direction and non-goals ([ROADMAP.md](./ROADMAP.md))
- The conventions documented in [AGENTS.md](./AGENTS.md) and
  [CONTRIBUTING.md](./CONTRIBUTING.md)
- Tests and documentation matching the change (see
  [CONTRIBUTING.md](./CONTRIBUTING.md))

## Roles

| Role        | Who         | Responsibilities                                                                                     |
| ----------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| Maintainer  | @aliasunder | Reviews and merges PRs, triages issues and security reports, cuts releases, holds all project access |
| Contributor | Anyone      | Opens issues and pull requests per [CONTRIBUTING.md](./CONTRIBUTING.md)                              |

There are currently no additional committers. If the project grows to need
them, a committer role would carry pull request review and merge rights,
granted per the collaborator policy below.

## Access

The maintainer is the only person with access to the project's sensitive
resources:

- **GitHub repository** — admin access (settings, branch protection,
  Actions secrets)
- **Container registry** — publishing rights for
  `ghcr.io/aliasunder/vault-cortex`
- **Docker Hub** — publishing rights for the `aliasunder/vault-cortex`
  mirror (GHCR is the primary registry)
- **npm** — publishing rights for the `vault-cortex` CLI package
- **Reference deployment** — the maintainer's own AWS deployment (see
  [SECURITY.md](./SECURITY.md); not required by adopters)

## Continuity

Everything needed to continue the project is public:

- Source, CI workflows, tests, and documentation live in this repository
- The [MIT license](./LICENSE) permits anyone to fork and continue
  development
- Releases are built by GitHub Actions from tagged commits — there are no
  maintainer-local build steps

A successor or fork would need to re-create the private pieces: the
deploy workflows' secrets (deployment credentials, the Docker Hub
mirror's token, the release bot's GitHub App keys) and an npm Trusted
Publishing configuration of their own — GHCR publishing uses the
workflow's built-in token, so no registry secret exists to hand over.
None of these gate access to the code or the published images.

## Adding collaborators

Collaborators are added at the maintainer's discretion. Before anyone
receives escalated permissions (commit, merge, or release rights), the
maintainer reviews their contribution history with the project. Access
follows least privilege: the smallest permission set the role needs.
