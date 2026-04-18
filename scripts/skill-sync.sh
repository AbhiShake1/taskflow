#!/usr/bin/env bash
# Push pending changes in the taskflow-skill submodule, then bump the
# submodule pointer commit in the SDK repo. One invocation = one end-to-end
# skill docs update.
#
# Usage:
#   scripts/skill-sync.sh "docs: commit message for the skill repo"
#
# What it does:
#   1. Inside .claude/skills/taskflow:
#        git add -A && git commit -m "<msg>" && git push origin main
#   2. Back in the SDK repo:
#        git add .claude/skills/taskflow
#        git commit -m "chore: bump taskflow-skill submodule to <sha>"
#        git push origin main
#
# Refuses to run if there are unrelated dirty files in the SDK repo so the
# submodule bump stays a single-file commit.

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 \"commit message for the skill repo\"" >&2
  exit 1
fi

SKILL_MSG="$1"
SDK_ROOT="$(git rev-parse --show-toplevel)"
SKILL_DIR="$SDK_ROOT/.claude/skills/taskflow"

if [ ! -d "$SKILL_DIR/.git" ] && ! git -C "$SKILL_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  echo "error: $SKILL_DIR is not a git submodule" >&2
  exit 1
fi

# Bail if the SDK repo has unrelated dirty files (anything other than the
# submodule pointer itself). Keeps the bump commit clean.
DIRTY="$(git -C "$SDK_ROOT" status --porcelain | grep -v '^ M \.claude/skills/taskflow$' | grep -v '^$' || true)"
if [ -n "$DIRTY" ]; then
  echo "error: SDK repo has unrelated dirty files:" >&2
  echo "$DIRTY" >&2
  echo "commit or stash them first, then rerun." >&2
  exit 1
fi

pushd "$SKILL_DIR" >/dev/null

if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "skill repo is clean — nothing to commit. Bumping pointer only."
else
  git add -A
  git commit -m "$SKILL_MSG"
  git push origin main
fi

SKILL_SHA="$(git rev-parse --short HEAD)"
popd >/dev/null

cd "$SDK_ROOT"

if git diff --quiet -- .claude/skills/taskflow; then
  echo "submodule pointer already matches $SKILL_SHA — nothing to bump."
  exit 0
fi

git add .claude/skills/taskflow
git commit -m "chore: bump taskflow-skill submodule to $SKILL_SHA"
git push origin main

echo "done: skill repo at $SKILL_SHA, SDK submodule pointer bumped and pushed."
