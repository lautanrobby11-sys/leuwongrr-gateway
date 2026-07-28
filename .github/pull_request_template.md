## Outcome

<!-- What behaviour changes, and which blueprint phase does it advance? -->

## Canonical ownership

- [ ] Canonical module changed; no parallel route, config, or duplicate implementation
- [ ] No forbidden filename suffix and no shadow environment file
- [ ] Schema change (if any) is a new forward-only migration
- [ ] Unrelated user changes preserved

## Evidence

| Gate | Result |
| --- | --- |
| `npm run check:conventions` | |
| `npm run scan:secrets` | |
| `npm run lint` | |
| `npm run typecheck` | |
| `npm test` | |
| `npm run build` | |

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
