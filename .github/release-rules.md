# Release Rules

This file defines the default release workflow for this repository.

## Scope

Use these rules when the user asks to release a version, update changelog, create a tag, or publish.

## Required Steps

1. Check current state:
- `git status --short`
- `git tag --sort=version:refname`

2. Update version metadata:
- `package.json` -> `version`
- `package-lock.json` -> top-level `version`
- `package-lock.json` -> `packages[""] .version`

3. Update changelog:
- Add a new top section for the target version
- Keep entries concise and bilingual (`中文 / English`)
- Summarize user-visible behavior changes only

4. (Optional but recommended) Add release notes file:
- File name: `RELEASE_NOTES_<version>.md`
- Keep bilingual format

5. Validate build:
- Run `npm run compile`

6. Commit release changes:
- Stage release-related files
- Commit message format: `release: <version>`

7. Create and push tag:
- `git tag <version>`
- `git push origin main`
- `git push origin <version>`

## Changelog Style

- One or two bullets per version unless a larger release needs more detail
- Format each bullet as: `中文。 / English.`
- Keep language factual and concise

## Safety Rules

- Do not delete prior changelog history
- Do not overwrite existing tags
- If target tag already exists, stop and ask user how to proceed
