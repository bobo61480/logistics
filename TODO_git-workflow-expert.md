# Git Workflow Expert — bobo61480/logistics

**Generated**: 2026-08-06
**Repository**: https://github.com/bobo61480/logistics
**Total commits**: 95 across 2 branches
**Contributors**: arcolinuxz (53), bobo61480 (11), tokkiboi (8)
**Repo size**: 2.6 MB (.git)

---

## Context

### Repository structure
- **Stack**: Static HTML/JS logistics dashboard (app.js, index.html, styles.css) + a Next.js app (`app/` directory) deployed to GitHub Pages.
- **Google Apps Script**: `google-apps-script/Code.gs` deployed via clasp.
- **CI/CD**: Single GitHub Actions workflow (`deploy-planner.yml`) — deploys Next.js to GitHub Pages on push to `main` and pushes Apps Script changes via clasp.
- **Branching**: Informal — `main` is the production branch deployed to GitHub Pages. Feature branches are created ad-hoc with no naming convention enforced.

### Current branching model
- `main` — production, auto-deployed via GitHub Actions.
- `claude/shared-conversation-link-xxkuny` — current feature branch, 31 commits ahead of main.
- No branch protection rules detected.
- No PR template.
- No CONTRIBUTING.md.

### Commit message quality
- **2 of 95** commits follow conventional commit format.
- **9+ commits** have single-character or single-word messages: `q`, `c`, `c`, `c`, `upd`, `CC`, `add`, `up`, `all`.
- Commit message lengths range from 1 character to 173 characters.
- The main branch has better commit quality (descriptive messages) than the feature branch.

### Git hooks
- **None active** — only sample hooks exist in `.git/hooks/`.
- No Husky, lint-staged, or commitlint configuration.
- No pre-commit, commit-msg, or pre-push hooks.

### Tracked artifacts that shouldn't be
- `bob-task-*.json` — 708 KB + 136 KB of ephemeral task/agent JSON tracked in git.
- `git-error-*.txt` — git error dump file tracked in version control.

---

## Workflow Plan

- [ ] **GIT-PLAN-1.1 [Branching Strategy]**:
  - **Model**: GitHub Flow (simple feature-branch → main). The team is small (3 contributors), deploys on push to main, and has no release cadence that would benefit from Git Flow.
  - **Branches**: `main` (protected, auto-deployed), `feature/*`, `fix/*`, `chore/*` (ephemeral).
  - **Protection**: Require PR for merges to main; require at least 1 approval; require status checks to pass; disable force-push to main.
  - **Naming**: `feature/<short-desc>`, `fix/<short-desc>`, `chore/<short-desc>`. Example: `feature/inbound-planning-grid`, `fix/kpi-reference-error`.

- [ ] **GIT-PLAN-1.2 [Commit Message Convention]**:
  - **Standard**: Conventional Commits — `type(optional-scope): description`.
  - **Allowed types**: `feat`, `fix`, `chore`, `docs`, `refactor`, `style`, `perf`, `ci`, `build`, `revert`.
  - **Enforcement**: commit-msg hook via a lightweight shell script (no npm dependency required for the static-site workflow).
  - **Minimum message length**: 10 characters (prevents `c`, `q`, `upd`).

- [ ] **GIT-PLAN-1.3 [PR Workflow]**:
  - **Template**: Add `.github/pull_request_template.md` with Summary, Changes, and Test Plan sections.
  - **Reviews**: Require 1 approval before merge to main.
  - **Merge strategy**: Squash-and-merge to keep main history clean when feature branches have noisy commits.

---

## Workflow Items

### Critical — Commit hygiene

- [ ] **GIT-ITEM-1.1 [Commit message hook]**:
  - **Hook**: `commit-msg`
  - **Purpose**: Reject commits with messages shorter than 10 characters or not matching conventional commit format.
  - **Tool**: Shell script (no dependencies).
  - **Fallback**: Developer can bypass with `--no-verify` in emergencies, but this should be rare and documented.

```sh
#!/usr/bin/env bash
# .git/hooks/commit-msg — enforce conventional commit format
MSG=$(head -1 "$1")
# Allow merge commits
if echo "$MSG" | grep -qE '^Merge '; then exit 0; fi
# Minimum length
if [ ${#MSG} -lt 10 ]; then
  echo "ERROR: Commit message must be at least 10 characters."
  echo "  Got: '$MSG'"
  exit 1
fi
# Conventional commit pattern
if ! echo "$MSG" | grep -qE '^(feat|fix|chore|docs|refactor|style|perf|ci|build|revert)(\(.+\))?: .{3,}'; then
  echo "ERROR: Commit message must follow conventional format."
  echo "  Expected: type(scope): description"
  echo "  Examples: feat: add inbound planning grid"
  echo "            fix(kpi): resolve reference error in load function"
  echo "  Got: '$MSG'"
  exit 1
fi
```

- [ ] **GIT-ITEM-1.2 [Pre-commit: prevent large files]**:
  - **Hook**: `pre-commit`
  - **Purpose**: Block commits that add files larger than 500 KB or files matching ephemeral patterns (`bob-task-*.json`, `git-error-*.txt`, `*.log`).
  - **Tool**: Shell script.
  - **Fallback**: `--no-verify` bypass.

```sh
#!/usr/bin/env bash
# .git/hooks/pre-commit — block large and ephemeral files
BLOCKED_PATTERNS="bob-task-*.json git-error-*.txt *.log"
STAGED=$(git diff --cached --name-only --diff-filter=ACM)
ERRORS=0

for pattern in $BLOCKED_PATTERNS; do
  MATCHES=$(echo "$STAGED" | grep -E "$(echo "$pattern" | sed 's/\*/.*/')" || true)
  if [ -n "$MATCHES" ]; then
    echo "ERROR: Blocked file pattern '$pattern' staged:"
    echo "$MATCHES" | sed 's/^/  /'
    ERRORS=1
  fi
done

# Check file sizes (500 KB limit)
for file in $STAGED; do
  if [ -f "$file" ]; then
    SIZE=$(wc -c < "$file")
    if [ "$SIZE" -gt 512000 ]; then
      echo "ERROR: File '$file' is $(( SIZE / 1024 )) KB (limit: 500 KB)."
      ERRORS=1
    fi
  fi
done

exit $ERRORS
```

### Critical — .gitignore gaps

- [x] **GIT-ITEM-2.1 [Update .gitignore]**: Done — .gitignore already contains bob-task-*.json, git-error-*.txt, and OS artifact entries (verified 2026-09-03).
  - **Purpose**: Exclude ephemeral task files, error dumps, and OS artifacts that are currently tracked.
  - **Changes to `.gitignore`**:

```diff
--- a/.gitignore
+++ b/.gitignore
@@ -9,3 +9,12 @@ pnpm-workspace.yaml
 
 # clasp OAuth credentials (stored in home dir, never in repo)
 .clasprc.json
+
+# Ephemeral task / agent output (large, session-specific)
+bob-task-*.json
+git-error-*.txt
+
+# OS artifacts
+.DS_Store
+Thumbs.db
+desktop.ini
```

- [x] **GIT-ITEM-2.2 [Remove tracked ephemeral files]**: Done — no bob-task-*.json or git-error-*.txt tracked on main (verified via git ls-tree, 2026-09-03).
  - **Purpose**: Untrack the `bob-task-*.json` and `git-error-*.txt` files already committed.
  - **Commands**:

```sh
git rm --cached bob-task-*.json git-error-*.txt
git commit -m "chore: untrack ephemeral task and error files"
```

  - **Risk**: Low — these are not source code. The files remain on disk but stop being versioned.

### High — Branch protection

- [ ] **GIT-ITEM-3.1 [Protect main branch]**:
  - **Purpose**: Prevent direct pushes, force-pushes, and unreviewed merges to the production branch.
  - **Where**: GitHub → Settings → Branches → Add rule for `main`.
  - **Settings**:
    - Require pull request before merging: **Yes**
    - Required approvals: **1**
    - Require status checks to pass before merging: **Yes** (add `build-and-deploy` job)
    - Do not allow force pushes: **Yes**
    - Do not allow deletions: **Yes**
  - **Note**: This is a GitHub settings change, not a code change.

### High — PR template

- [x] **GIT-ITEM-3.2 [Add PR template]**: Added .github/pull_request_template.md (2026-09-03).
  - **Purpose**: Standardize PR descriptions so reviewers can quickly understand changes.
  - **File**: `.github/pull_request_template.md`

```markdown
## Summary

<!-- 1-3 bullet points: what changed and why -->

## Changes

<!-- List key files/areas modified -->

## Test plan

- [ ] Verified locally (dev server or browser)
- [ ] No console errors
- [ ] Google Sheets sync still works
```

### Medium — Workflow automation

- [ ] **GIT-ITEM-4.1 [Add CI status check for static assets]**:
  - **Purpose**: The Next.js build job already runs on push to main, but there is no check for the static HTML/JS files (app.js, index.html) which are the live dashboard. A basic syntax check would catch broken JavaScript before deploy.
  - **Where**: Add a step to the existing `build-and-deploy` job or a new lightweight job.

```yaml
- name: Lint static dashboard JS
  run: node --check app.js platform-config.js site-config.js database-client.js database-config.js
```

- [ ] **GIT-ITEM-4.2 [Squash-merge strategy]**:
  - **Purpose**: Feature branches like the current one (31 commits, many with single-letter messages) should be squash-merged to keep main's history clean.
  - **Where**: GitHub → Settings → General → Pull Requests → Allow squash merging (default commit message: PR title).
  - **Optional**: Disable "Allow merge commits" so all PRs squash automatically.

### Medium — Recovery documentation

- [ ] **GIT-ITEM-5.1 [Document emergency procedures]**:
  - **Purpose**: The team has no documented recovery process. With production deploying from main on every push, a bad merge can take down the live dashboard.
  - **Procedures to document** (in CONTRIBUTING.md or a `docs/` file):
    1. **Revert a bad deploy**: `git revert <commit> && git push origin main`
    2. **Find a lost commit**: `git reflog` → `git cherry-pick <hash>`
    3. **Recover a deleted branch**: `git reflog` → `git checkout -b <name> <hash>`
    4. **Roll back main to a known-good state**: `git revert --no-commit HEAD~N..HEAD && git commit -m "revert: roll back N commits"`

### Low — History cleanup (current feature branch)

- [ ] **GIT-ITEM-6.1 [Squash noisy commits before merge]**:
  - **Purpose**: The current feature branch has 31 commits. At least 9 have meaningless messages (`q`, `c`, `upd`, `commit`). Before merging to main, these should be squashed into logical units or the PR should use squash-merge.
  - **Recommended approach**: Use GitHub's squash-merge feature (GIT-ITEM-4.2) rather than interactive rebase, since the branch is already pushed.
  - **If manual squash is preferred**:

```sh
# Create a backup first
git branch backup/feature-branch-before-squash

# Interactive rebase onto main
git rebase -i main
# Mark noisy commits as 'fixup' or 'squash', keeping meaningful ones as 'pick'
```

  - **Risk**: Medium — requires force-push of the feature branch after rebase. Only safe if no one else is working on this branch.

---

## Quality Assurance Checklist

- [ ] All proposed hooks are cross-platform (bash — works on macOS, Linux; Windows users need Git Bash or WSL)
- [ ] Commit message hook allows merge commits through
- [ ] Pre-commit hook allows legitimate large files through with `--no-verify` escape
- [ ] Branch protection does not block the repository owner from emergency fixes (admin bypass stays available)
- [ ] Squash-merge preserves PR description as the commit body on main
- [ ] `.gitignore` additions do not break existing functionality
- [ ] CI status check (`node --check`) is non-blocking for the static site (the Next.js build is the gate)
- [ ] Recovery procedures are safe — all use `revert` rather than `reset --hard` on shared branches

---

## Commands — Quick Reference

```sh
# Install hooks (run once after clone)
cp .githooks/* .git/hooks/ && chmod +x .git/hooks/*

# Or configure git to use a hooks directory
git config core.hooksPath .githooks

# Verify hook is active
git commit --allow-empty -m "x"
# → should be rejected by commit-msg hook

# Untrack ephemeral files
git rm --cached bob-task-*.json git-error-*.txt
git commit -m "chore: untrack ephemeral task and error files"

# Squash-merge a feature branch via CLI
git checkout main
git merge --squash feature/my-branch
git commit -m "feat: description of the feature"
```

---

## Red Flags Found in This Repository

| Flag | Severity | Details |
|------|----------|---------|
| Single-character commit messages | **Critical** | 9+ commits with messages like `q`, `c`, `upd` — history is unreadable |
| No branch protection on main | **High** | Anyone can push directly to production; force-push is allowed |
| No git hooks | **High** | No automated quality gates; bad commits go through unchecked |
| Large ephemeral files tracked | **Medium** | 844 KB of `bob-task-*.json` files bloating the repo |
| No PR template | **Medium** | PRs lack standardized descriptions |
| No CONTRIBUTING.md | **Low** | No documented workflow for contributors |
| Feature branch 31 commits ahead | **Info** | Long-lived branch with noisy history; should squash-merge |
