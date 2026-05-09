# Gobog Publisher

Obsidian plugin: turn a folder of your vault into a static blog and push it to a GitHub Pages repository, in one command.

This plugin is a thin orchestration layer. The actual scanning, markdown rendering, wikilink/embed resolution, atom/sitemap generation and static export are done by [`gobog`](https://github.com/sbraveyoung/gobog) — you must build that binary first.

```
Obsidian vault              gobog binary                GitHub repo
─────────────────  ─────►   ────────────  ────────►  ───────────────
   Blog/                   gobog -export                user.github.io
     Hello.md              <out>/                       index.html
     Tech/                                              about/
       HTTP.md                                          post/...
     about/me.md                                        atom.xml ...
```

The plugin never touches your notes — it always uses gobog's read-only vault adapter (`ParseFile`).

## Requirements

- Obsidian 1.4+ (desktop only — this plugin shells out to `gobog` and `git`).
- A built `gobog` binary somewhere on disk. Build it from the [gobog repo](https://github.com/sbraveyoung/gobog):

  ```sh
  git clone https://github.com/sbraveyoung/gobog && cd gobog && make build
  ```

- `git` available on `PATH`.
- A GitHub repository for the published site (typically `<user>.github.io`) and a Personal Access Token with `Contents: Read & Write` scoped to that repo.

## Install

For now the plugin is not in the community store. Install manually:

```sh
git clone https://github.com/<you>/gobog-obsidian.git ~/.obsidian/plugins/gobog-publisher
cd ~/.obsidian/plugins/gobog-publisher
npm install
npm run build
```

Then in Obsidian: Settings → Community plugins → enable "Gobog Publisher".

(Replace `~/.obsidian/plugins` with `<your-vault>/.obsidian/plugins/` — the plugin is per-vault.)

## Configure

Open Settings → Gobog Publisher and fill in:

| Section | Field | Notes |
| --- | --- | --- |
| gobog binary | gobog binary path | Absolute path to the `gobog` executable. |
| | Theme path | Absolute path to a theme dir (defaults to `<gobog-bin-dir>/themes/simple`). |
| Vault source | Source folder | Path inside the vault that holds publishable notes (e.g. `Blog`). The folder boundary IS the publish boundary — no `publish: true` flag needed. |
| | Output directory | Where gobog writes the static site before pushing. Defaults to `<vault>/.obsidian/plugins/gobog-publisher/build`. |
| | Include drafts | Show notes with `draft: true` in the output. |
| Site metadata | Domain / Title / Author / CNAME / etc. | Used for canonical URLs, atom feed, sitemap, and the optional `CNAME` file dropped into the export. |
| GitHub | Repository URL | `https://github.com/<user>/<repo>.git` |
| | Branch | `main` for `<user>.github.io`, often `gh-pages` for project sites. |
| | GitHub token | Fine-grained PAT with Contents: Read & Write on the target repo. Stored locally in this plugin's `data.json`. |
| | Force push | Off by default; turn on for single-commit history. |

## Use

Command palette → **Gobog: Publish blog to GitHub**.

Steps the plugin performs:

1. Resolves the source folder to an absolute path (refuses anything outside the vault).
2. Writes a temp `gobog.toml` reflecting the settings.
3. Runs `gobog -config <temp> -export <out>`.
4. Clones the target branch shallowly (or `git init`s when the branch doesn't exist), wipes the working tree, copies `<out>` over it, commits, pushes.
5. Reports success in a Notice. Logs go to DevTools (Ctrl+Shift+I → Console).

There's also **Gobog: Export to local folder (skip git push)** if you just want the rendered static site without touching the remote.

## Wikilinks, embeds, tags

The transforms happen on the gobog side, not in this plugin. As a quick reference of what reaches the published site:

- `[[Note]]` → `<a href="/post/.../note">Note</a>` (resolved against the source folder)
- `[[Note|caption]]` → custom anchor text
- `[[Note#section]]` → fragment appended (slugified)
- `![[image.png]]` → `<img src="/image/<rel-path>">` — attachments may live anywhere in the source folder
- `tags: [a, b]` (Obsidian YAML form) and `tags: a, b` both decode the same way
- `draft: true` excludes the note unless "Include drafts" is on

Wikilinks pointing outside the source folder render as plain text — the source folder is intentionally a hard publish boundary.

## What this plugin does NOT do

- Does not edit your notes (gobog's vault scanner is read-only).
- Does not bundle git — uses your system `git`.
- Does not work on mobile (Electron-only APIs).
- Does not handle Obsidian Canvas, Templater output, or Dataview queries.

## License

MIT
