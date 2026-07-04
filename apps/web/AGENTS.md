# apps/web AGENTS.md

## Scope

This app contains the KnowYourCode web product.

- Next.js App Router
- React
- TypeScript
- Vercel deployment target

## Rules

- Keep UI copy primarily Korean.
- Preserve the Project Mode and Commit Mode user flows unless explicitly changing them.
- Use `@/` imports for code under `apps/web/src`.
- Run `npm run build -w apps/web` or root `npm run build` before reporting web changes complete.
- Keep Tally feedback popup and Vercel Analytics events working.
- Do not move analysis logic to FastAPI from this app unless the task explicitly includes API migration.
