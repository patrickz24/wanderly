## What and why

<!-- What does this change do, and why is it needed? Link the issue or plan section. -->

## How it was verified

<!-- Commands you ran and their results (tests, manual checks, screenshots for UI changes). -->

## Checklist

- [ ] `npm run lint`, `npm run typecheck` and `npm test` pass locally
- [ ] Tests cover the new behaviour (and `npm run test:integration` if SQL changed)
- [ ] Commits follow Conventional Commits and are small and atomic
- [ ] No secrets, personal data or real API keys in code, fixtures or logs
- [ ] New environment variables are documented in `.env.example`
- [ ] Docs and ADRs updated when a decision or behaviour changed
- [ ] Agent, prompt or retrieval change: evaluation impact described (eval gate from milestone 5)
