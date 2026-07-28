#!/usr/bin/env bash
# One-time (idempotent) GitHub setup for Matmatch: labels, milestones, project board.
# Prerequisite: `gh` installed and authenticated (`gh auth login`).
# Safe to re-run — skips anything that already exists.
#
# See docs/engineering/GIT_AND_GITHUB.md for the rationale behind this taxonomy.

set -euo pipefail

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
echo "Setting up GitHub project management for: $REPO"

create_label() {
  local name="$1" color="$2" description="$3"
  if gh label list --repo "$REPO" --json name -q '.[].name' | grep -qxF "$name"; then
    echo "  label exists: $name"
  else
    gh label create "$name" --repo "$REPO" --color "$color" --description "$description"
    echo "  created label: $name"
  fi
}

echo "Creating labels..."
create_label "type: feature"    "1D76DB" "New functionality"
create_label "type: bug"        "D73A4A" "Something is broken"
create_label "type: chore"      "CFD3D7" "Process/tooling work"
create_label "type: docs"       "0075CA" "Documentation only"
create_label "type: tech-debt"  "B60205" "Cleanup / refactor / debt"

create_label "area: frontend"   "5319E7" "React/PWA client"
create_label "area: backend"    "5319E7" "Node/TS API"
create_label "area: ai"         "5319E7" "AI Orchestrator / prompts"
create_label "area: data"       "5319E7" "Ingredient/template/data catalog"
create_label "area: infra"      "5319E7" "CI, hosting, tooling"

create_label "priority: p0"     "B60205" "Blocking current phase"
create_label "priority: p1"     "D93F0B" "Important, not blocking"
create_label "priority: p2"     "FBCA04" "Nice to have"

create_label "phase: 0"         "0E8A16" "Phase 0 — Foundations"
create_label "phase: 1"         "0E8A16" "Phase 1 — MVP Core Loop"
create_label "phase: 2"         "0E8A16" "Phase 2 — Validate & Iterate"
create_label "phase: 3"         "0E8A16" "Phase 3 — Premium & Scale"

echo "Creating milestones..."
create_milestone() {
  local title="$1" description="$2"
  if gh api "repos/$REPO/milestones" -q '.[].title' | grep -qxF "$title"; then
    echo "  milestone exists: $title"
  else
    gh api "repos/$REPO/milestones" -f title="$title" -f description="$description" >/dev/null
    echo "  created milestone: $title"
  fi
}

create_milestone "Phase 0 — Foundations" "Ingredient catalog, recipe templates, allergy taxonomy, substitutions"
create_milestone "Phase 1 — MVP Core Loop" "Household onboarding, Tonight suggestion, guided flow, shopping list"
create_milestone "Phase 2 — Validate & Iterate" "Real-user cohort, retention metrics"
create_milestone "Phase 3 — Premium & Scale" "Premium features, only after Phase 2 validates the core loop"

echo ""
echo "Labels and milestones done."
echo "Project board (Backlog/Ready/In Progress/Review/Testing/Done) must be created once manually:"
echo "  gh project create --owner @me --title \"Matmatch\""
echo "  then add the six status fields/columns via the web UI (Projects v2 field creation via API is verbose enough that a one-time manual pass is more reliable than scripting it)."
