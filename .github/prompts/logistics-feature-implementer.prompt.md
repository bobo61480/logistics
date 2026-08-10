---
description: "Implement or fix a logistics feature in this Next.js app"
agent: "agent"
argument-hint: "Feature, bug, or task description"
---
Implement the requested logistics change end-to-end in this repository.

Use the current workspace context, the selected code, and nearby implementation files to understand the controlling code path before making edits. Prefer the smallest safe change that fixes the behavior at the root cause.

Requirements:
- Keep changes focused and consistent with the existing StyleKorean logistics planner codebase.
- Avoid unrelated refactors and avoid adding dependencies unless absolutely necessary.
- Preserve the app's static-export constraints and client-side data flow.
- After edits, run the most relevant validation available, prioritizing `npm run typecheck` for TypeScript changes and `npm run build` when rendering or export behavior might be affected.
- Report the files changed, what was verified, and any residual risk.

If the request is underspecified, first identify the local file or symbol that most directly controls the behavior, then make the smallest plausible edit and validate it.