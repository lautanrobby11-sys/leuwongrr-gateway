# ADR-012: Local release authority with GitHub as a source mirror

- Status: Accepted
- Date: 2026-07-28

## Context

The repository is private under a GitHub Free personal account. GitHub does not enforce branch protection or repository rulesets for this configuration. The operator intentionally keeps GitHub as an off-host source mirror rather than a production control plane. The running gateway must remain independent of GitHub availability, credentials, Actions, or plan features.

A missing server-side merge gate must not become permission to deploy an untested working tree or to edit source on the VPS. The compensating control is a local, reproducible release ceremony whose evidence is tied to one immutable Git commit and artifact checksum.

## Decision

1. GitHub is a private source mirror and audit copy. GitHub Actions diagnostics are useful evidence but are not the authority that permits production activation.
2. The operator workstation is the release authority. It must use a clean checkout of the exact commit, both committed lockfiles, Node 22, and `npm run ci:local`. Clean means `git status --porcelain` is empty with untracked files included: packaging stages from the working tree, so an untracked file would ship inside the artifact while being absent from the commit the evidence names. `scripts/assert-clean-tree.sh` is the one canonical implementation of that check; `scripts/build-release.sh` runs it as a preflight before the build and again after packaging and checksumming, and the GitHub `clean` step invokes the same file, so workstation and mirror enforce identical semantics. The post-package run is the evidence that building and packaging mutated nothing.
3. A release candidate is valid only when local validation succeeds and `.release/<full-git-sha>.tar.gz` plus its checksum are produced by `scripts/build-release.sh` from the same clean commit.
4. Only the artifact and checksum cross into the VPS. The VPS has no GitHub credential, does not run `git pull`, and is not a development or source-editing environment.
5. Production source is never edited under `current` or any release directory. Failed work produces a new commit and therefore a new release SHA. A configuration-only preflight refusal is not failed work only when the invocation stops at the initial production-config guard before release creation/use, dependency installation, application preflight, activation, restart, health checks, traffic, or public exposure; the exact immutable artifact remains fully verified; sanitized evidence proves no consequential mutation; and the release authority explicitly approves one later canonical activation attempt. Any failure during that attempt requires a new commit and release SHA.
6. Deployment remains manual and uses the canonical deploy script. It verifies the outer checksum, inner manifest, config permissions, preflight, liveness, readiness, and automatic rollback. The configuration-only exception never permits artifact rebuilds, source or script edits, checksum/signature changes, or preflight/health bypasses.
7. Every release record captures the commit SHA, local command outcomes, artifact checksum, previous release SHA, health results, resource snapshot, and rollback target. Missing evidence means NO-GO.
8. Pull requests remain the review and discussion format while GitHub is available, but the absence of enforceable branch protection is an accepted, explicit single-operator risk. It must not be described as protected.
9. GitHub, the operator working copy, and one separate encrypted/offline source backup form the minimum source custody set. GitHub is not the only backup.

## Consequences

- No GitHub Team or GitHub Pro subscription is required for runtime or release authorization.
- A compromised operator workstation can bypass the compensating control; workstation security and backup custody are production concerns.
- A direct push to `main` is technically possible. The audit must therefore verify the exact commit and clean-tree evidence rather than trusting branch settings.
- Builds do not run on the production VPS, preserving its small resource envelope for Gateway, OmniRoute, backup, and SSH.
- Public go-live remains blocked by runtime/security gates such as snapshot-age alerting, load/stream tests, Cloudflare boundary verification, and canary observation.