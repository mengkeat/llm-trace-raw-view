Project commands (Bun)

- Install: `bun install`
- Run dev server: `bun run dev -- path\to\log.txt`
- Run dev server (LiteLLM mode): `bun run dev -- path\to\log.txt --litellm`
- Run server (prod): `bun run start -- path\to\log.txt`
- Run server (prod, LiteLLM mode): `bun run start -- path\to\log.txt --litellm`

Notes

- Runtime: Bun.js
- No build step; `index.ts` is executed directly by Bun.
- No automated tests are configured.
- Log files are read from the CLI argument when the server starts.
