# Pi bridge fork notes

This checkout is our main desktop UI for local Pi dogfooding for now.

- Work from `pi-ui-bridge-maintainable-phase1` or a successor branch rebuilt from `upstream/main`.
- Keep bridge changes narrow. Do not pull back the old broad `origin/pi-ui-bridge` history just to recover adapter behavior.
- Pi-owned adapter sources live in `/home/marcosb/.pi/integrations/howcode/`; edit those first when changing managed bridge files, then reinstall the patch into this checkout.
- Point Custom Pi directory, or `PI_CODING_AGENT_DIR`, at `/home/marcosb/.pi/agent` when testing local Pi settings/extensions/workflows.
- Howcode still runs against its bundled `@earendil-works/pi-*` package versions. If local Pi APIs move, update the app package versions or the bridge compatibility loader intentionally.
- `ask_user_questions` is the Pi contract. Howcode's legacy `ask_questions` path is a compatibility shim.
- Workflow progress comes from Pi UI bridge events and durable workflow artifacts. Child workflow sessions are display-only secondary sessions; parent workflow state/actions stay on the parent session.

Useful checks:

- From `/home/marcosb/.pi`: `node integrations/howcode/scripts/validate-howcode.mjs`
- From `/home/marcosb/.pi`: `pnpm -C agent run validate:ui-bridge`
- From this checkout: `bun run ai:check`
