---
name: git-commit
description: Write a Conventional Commits message and create the commit. Use whenever the user asks to commit ("commit して", "コミットして", "commit this", "make a commit"), asks for a commit message to be drafted or rewritten, or when a unit of work is finished and needs committing. Also use when another workflow reaches its commit step. Produces messages whose body records why the change was made — the reasoning that the diff cannot show — and that stay readable years later without any plan document, ticket, or session context.
---

# Git Commit

A commit message is read by someone who already has the diff. They ran
`git log -S` on a line that puzzles them, or `git blame` on a function that
looks wrong. What they lack is not *what* changed — that is on screen — but
*why anyone thought it should*. The body exists to supply exactly that, and
nothing else.

Two failure modes destroy the message's value, and both are easy to fall into
when you have just finished the work and the context is still fresh in your
head:

1. **Restating the diff.** "Added `validateRule` to `config.ts`, updated the
   tests." The reader can see this. It costs them time and returns nothing.
2. **Leaning on context that will not survive.** "Implements Phase 2 of
   `docs/plans/foo.md`", "per the review feedback", "fixes the issue we
   discussed". Plans get deleted or superseded; conversations vanish. A commit
   that outsources its reasoning to them becomes unreadable the moment the
   referent is gone — which, for a plan file, is usually the next refactor.

## Workflow

### 1. Read the actual diff

Run `git status` and read the full diff — `git diff --cached` when something
is staged, `git diff HEAD` otherwise. Do not write from memory of what you
intended to change. What you actually changed is often slightly different, and
the gap is where wrong commit messages come from.

If nothing is staged, stage what belongs to this commit and say what you
staged. If the working tree holds unrelated changes (an unrelated dirty file, a
scratch config), leave them out rather than sweeping them in.

### 2. Reconstruct the why — and ask if you cannot

Before writing, answer for yourself:

- What was wrong or missing before? What observation or failure prompted this?
- Why *this* approach? What did you consider and reject, and on what grounds?
- What did you deliberately *not* do, and why? (Scope you left alone, a
  tempting generalisation you declined.)
- Did you verify something that leaves no trace in the code? Measurements,
  experiments, a claim you checked and found false.

These are the only things worth writing. If you were not the author of the
change, or the reasoning genuinely is not recoverable from the diff and the
conversation, **ask the user instead of inventing a plausible rationale.** An
invented why is worse than no why: it reads authoritative and misleads the next
reader. A subject line alone is an acceptable commit.

### 3. Pick type and scope from the repository's own vocabulary

Format: `type(scope): subject`. Scope is optional; use it when the repository
already has a name for the area.

```bash
git log --format='%s' -200 | grep -oP '(?<=\()[^)]+(?=\))' | sort | uniq -c | sort -rn
```

Reuse an existing scope when one fits. Inventing a synonym for a scope that
already exists fragments the log for everyone grepping it later.

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`,
`chore`. Pick by the change's effect on the user of the code, not by which
files moved: a change that only touches tests is `test`, but a change that
rewrites an internal helper so behaviour is preserved is `refactor` even if it
touches a dozen files.

### 4. Write it

**Subject** — imperative mood, lowercase start, no trailing period, ideally
under 72 characters. Say what the commit *achieves*, not which files it edits.
The strongest subjects read as the property that now holds:

- `fix(config): keep untyped review rules constructible`
- `fix(ui): say what a network approval scope actually covers`
- `test(mask-filter): report skips instead of silent passes when the binary is unbuilt`

**Body** — wrap at 72 columns. Lead with the reason, not the change. Open on
the problem, the wrong assumption, or the observation that forced this commit;
the change itself then follows as its consequence. Compare:

> `EncodedField` was carried over from the previous design without checking
> what the mask layer already does. `_build_mask_patterns` already expands each
> secret into base64 substrings across all three byte alignments, so a secret
> buried in a base64 blob is masked without decoding the blob at all.

against the same commit written as a summary of the diff ("Remove
`EncodedField`, `Rewrite`, and `onFailure` from the schema"). Only the first
tells the reader why the removal was safe.

When a commit makes several distinct decisions, a lead paragraph plus bullets
works well — but each bullet must carry its own reason, otherwise it has
collapsed back into a changelog:

- Good: `Drop the matchers registry, which had no use site.`
- Good: `Add exclude to selectors. Enumerating five content-block positions
  was only necessary because /**/content/* also reaches
  tools[].input_schema.properties.content; naming the region not to inspect
  inverts that.`
- Bad: `Add exclude to selectors.` — the diff already said so.

**Length follows content.** A typo fix, a dependency bump, or a mechanical
rename needs a subject and nothing more; padding it with a manufactured
rationale is its own kind of noise. A design change that closes off a class of
bugs may deserve several paragraphs. Write what you actually know and stop.

**Keep the message self-contained.** Everything the reader needs is in the
message and the diff. Concretely:

- Do not cite plan or handoff documents, phase numbers, task IDs, or session
  vocabulary. If a plan gave you the reason, restate the reason.
- Do not reference other commits by position — no "as decided in the previous
  commit", no "the next commit removes this". Describe the current state
  declaratively. `git log` order is not stable under rebase, and a reader
  landing here from `git blame` has no idea what "previous" meant.
- A spec or ADR *committed to this repository* may be named as a pointer, but
  the sentence must still stand up if the file is gone.

**Language.** English, matching the existing history. Japanese is fine only as
a quotation — a config key, a document heading, a string the change touches
that is written in Japanese.

### 5. Check before committing

Read your draft back and ask:

- Delete every sentence a reader could have derived from the diff. Is anything
  left? If not, cut the body entirely rather than shipping filler.
- Hand this to someone who has the repository at this commit and nothing else —
  no plan file, no chat log. Does every sentence still resolve?
- Does the subject state an outcome, or just name edited files?

### 6. Commit

```bash
git commit -m "$(cat <<'EOF'
type(scope): subject

Body.
EOF
)"
```

Follow whatever trailer convention the harness instructs (this repository's
history carries a `Co-Authored-By` trailer). Do not add `Generated with` banners
or emoji beyond that.

If a hook rejects the commit, read its output and fix the cause. Do not reach
for `--no-verify`; if the hook seems wrong, stop and tell the user.

After committing, report the resulting subject line and hash, and say plainly
if anything in the working tree was intentionally left uncommitted.

## Worked example

Change: a selector guard used a character-class regex on both sides, so
`/messages/*/content:*` was accepted; the parser then treated the segment as a
literal and the guard matched nothing.

**Weak** — accurate, and useless:

```
fix(config): update selector validation regex

Changed the regex in validateSelector to be stricter. Updated two test
cases that were asserting the old behaviour.
```

**Strong** — the diff already showed the regex; this shows the stakes:

```
fix(config): reject partially wildcarded selector segments

The check was a character class on both sides, so `/messages/*/content:*`
passed. `_parse_selector` then treats the segment as a literal, the guard
matches zero nodes, and a fail-closed control fails open.

Both sides now reject any segment containing `*` that is not exactly `*` or
`**`. Two selectors the tests asserted were accepted as literals move to the
reject side for this reason; expression-shaped text without `*` is unchanged.
```
