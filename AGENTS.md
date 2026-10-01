# Repository conventions

- Use the pinned Prettier configuration for supported source, tests, configuration,
  and documentation. Run `npm run format` after edits and `npm run lint` before
  handing off. Do not manually compress statements or override formatting locally.
- Keep formatting-only changes separate from functional changes. Use conventional
  commit prefixes such as `feat:`, `fix:`, `test:`, `docs:`, and `chore:`.
- Update nearby behavioral contracts and relevant tests when changing behavior.
  Keep current work and outstanding limitations in `docs/12-development-roadmap.md`;
  avoid appending duplicate session narratives to historical handoff journals.
- Preserve generated evidence and measurement artifacts; `.prettierignore` defines
  the formatting exclusions. Python formatting is outside this Prettier setup.
- Do not track or commit `docs/deep-review-2026-10-01.md` or
  `docs/engineering-judgment-notes-2026-10-01.md`. They are local review documents.
- Once `.git-blame-ignore-revs` exists, configure local history inspection with
  `git config blame.ignoreRevsFile .git-blame-ignore-revs`.
