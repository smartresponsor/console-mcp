#!/usr/bin/python3
"""Canonical release artifact paths. This module never mutates deployment state."""
from pathlib import Path

WORKSPACE_ROOT = Path("/home/alex/smartresponse/mcp")
WORKTREES = WORKSPACE_ROOT / ".worktrees"
RELEASES = WORKSPACE_ROOT / ".releases"
LEGACY_ROOT = Path("/opt/console-mcp-deploy")
LEGACY_RELEASES = LEGACY_ROOT / "releases"


def release_path(sha: str) -> Path:
    if len(sha) != 40 or any(character not in "0123456789abcdef" for character in sha):
        raise ValueError("FULL_LOWERCASE_SHA_REQUIRED")
    return RELEASES / sha


def check_layout():
    if WORKTREES == RELEASES or WORKTREES.is_relative_to(RELEASES) or RELEASES.is_relative_to(WORKTREES):
        raise RuntimeError("RELEASE_AND_WORKTREE_ROOTS_OVERLAP")
    if RELEASES.is_symlink() or WORKTREES.is_symlink():
        raise RuntimeError("RELEASE_LAYOUT_SYMLINK_REFUSED")
    return {"workspaceRoot": str(WORKSPACE_ROOT), "worktrees": str(WORKTREES),
            "releases": str(RELEASES), "legacyReleases": str(LEGACY_RELEASES)}
