# code-refs

**Click a file:line or a symbol in Claude's answer and see the code beside the chat.**

A Claude Code mod that turns `file:line` references and code symbols in Claude's answers into links. Pressing one opens the code in a side pane, with the cited lines highlighted. The pane also lists what changed in your repository and what Claude touched in your last message, with the diff of each file. It never writes to your files.

## Requirements

- Claude Code
- `git` on your PATH (the mod reads the repository through it)

## Install

```
/plugin install code-refs --marketplace sirlens/code-refs
```

## Use

Turn it on with `/code-refs on` (`off` turns it off; with no argument it toggles). While it is on:

- Press a `path/file.ext:12`, `file.ext:12-20` or `HEAD:file.ext:12` reference in an answer to open it in the pane. With several files of that name you pick one from a list.
- Press a symbol in backticks (`` `calculate()` ``) to open its definition. With several definitions they are listed, the ones nearest to the answer's context first.
- Symbols marked `?` could not be matched to a definition. When a symbol is shown in the pane, **Pedir al agente** starts a background subagent that locates it; its answer shows in the pane (with a button to open the definition) and never reaches the main chat. When it returns a link, the `?` in the message becomes that link.
- Tabs: **Code** (the opened file), **Changes** (`git status`; click a file for its diff against `HEAD`) and **Last** (files modified and read in your last message). Scroll with the wheel or the keys; the cross closes the pane.

With the mod off, answers are shown as Claude wrote them.

## What it runs

- **git, read-only**, through `process.run`, in the repository of the session: `rev-parse --show-toplevel`, `ls-files`, `grep` (symbol search, skipping docs, specs and translations), `status`, `diff HEAD`, `show HEAD:<file>` and `hash-object`. It never changes the repository.
- **Files:** reads the file you open in the pane. Nothing is written.
- **Model calls:** `model.fork`, only when an answer mentions a symbol without a link and the repository has several definitions of it. The fork inherits the current conversation, runs on your model and counts as a side request; its prompt lists the symbol names and the candidate `path:line` entries, and only an answer that is a number from that list is accepted.
- **Your messages:** while the mod is on, the first message of a conversation carries a short hidden rule asking Claude to write symbols as `code:` links. It is sent again after `/clear` or a compaction.
- **Subagents:** **Pedir al agente** spawns a background `fork` subagent (it inherits the conversation and its tools, and is told not to edit files). Its report is consumed by the mod and shown in the pane, so the main chat gets no notice and no new turn.
- **Stored:** only the on/off setting. Everything else (opened file, lists of touched files) lives in the session and is lost when it ends.
- **Network:** none.

## License

MIT
