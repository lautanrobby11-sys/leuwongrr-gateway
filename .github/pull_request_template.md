## Outcome

<!-- What behaviour changes, and which blueprint phase does it advance? -->

## Canonical ownership

- [ ] Canonical module changed; no parallel route, config, or duplicate implementation
- [ ] No forbidden filename suffix and no shadow environment file
- [ ] Schema change (if any) is a new forward-only migration
- [ ] Unrelated user changes preserved

## Evidence

The eleven rows below are exactly the gates `quality` treats as required. A red
required gate means no merge, no deploy, no DONE status.

| Gate | Result |
| --- | --- |
| `conventions` (`npm run check:conventions`) | |
| `secrets` (`npm run scan:secrets`) | |
| `lint` (`npm run lint`) | |
| `typecheck` (`npm run typecheck`) | |
| `tests` (`npm test`) | |
| `build` (`npm run build:all`) | |
| `console` (`dist/public/{admin,member,chat,login}.html` + `assets` present) | |
| `shell` (`bash -n scripts/*.sh`) | |
| `package` (`scripts/build-release.sh <sha>`) | |
| `checksum` (`sha256sum -c` inside `.release/`) | |
| `clean` (`git status --porcelain --untracked-files=no` empty after packaging) | |

Green GitHub Actions is **not** production authorization. Record the workstation
gate separately:

| Workstation gate | Result |
| --- | --- |
| `npm run ci:local` on the merge SHA | |

## Security review

- [ ] Input validated at the boundary
- [ ] Every query is tenant scoped
- [ ] Public surface stays within the explicit allowlist
- [ ] No secret, prompt, or response content added to logs or docs
- [ ] `/admin*` still requires Cloudflare Access **and** an application role

## Operational impact

- Resource envelope:
- Rollback target (previous release SHA):
- Backup or restore implication:

## Remaining risk

<!-- State untested areas explicitly. Do not claim production readiness without captured operator evidence. -->
