# csession

Move a Claude Code session from one machine to another — or hand one to a peer
so they can pick up the work.

A session is a JSONL transcript that lives only on the machine that made it.
Copying the file is not enough: it is full of that machine's absolute paths, it
assumes a specific git commit, and it contains every secret ever printed into
it. `csession` packages a session into one file that survives the trip.

```
csession export [id] -o work.ccsession    # redacts secrets, records git state
csession inspect work.ccsession           # look before you send
csession import work.ccsession            # rewrites paths, refuses to guess
```

Status: **phase 1 implemented.** `list`, `export`, `inspect` and `import` work.
Deferred: `csession send <host>`, a2a drop-board publishing, and a slash-command wrapper.

```bash
npm install && npm test    # build and run the suite
node dist/cli.js --help
```

Design: [docs/superpowers/specs/2026-08-31-csession-design.md](docs/superpowers/specs/2026-08-31-csession-design.md)
