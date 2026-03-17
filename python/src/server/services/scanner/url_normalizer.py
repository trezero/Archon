"""GitHub URL normalization utilities."""

import re


def normalize_github_url(url: str | None) -> str | None:
    """Normalize GitHub URL to canonical form: https://github.com/{owner}/{repo}

    Handles SSH (git@github.com:owner/repo.git) and HTTPS formats.
    Returns None for non-GitHub URLs or invalid input.
    """
    if not url:
        return None

    url = url.strip()

    # Handle SSH format: git@github.com:owner/repo.git
    ssh_match = re.match(r"git@github\.com:(.+?)(?:\.git)?/?$", url)
    if ssh_match:
        path = ssh_match.group(1)
        parts = path.split("/")
        if len(parts) == 2:
            owner, repo = parts
            return f"https://github.com/{owner}/{repo}".lower()
        return None

    # Handle HTTPS format
    https_match = re.match(r"https?://github\.com/(.+?)(?:\.git)?/?$", url, re.IGNORECASE)
    if https_match:
        path = https_match.group(1).rstrip("/")
        parts = path.split("/")
        if len(parts) >= 2:
            owner, repo = parts[0], parts[1]
            return f"https://github.com/{owner}/{repo}".lower()
        return None

    return None


def extract_github_owner_repo(url: str | None) -> tuple[str | None, str | None]:
    """Extract (owner, repo_name) from a GitHub URL.

    Returns (None, None) for non-GitHub URLs.
    """
    normalized = normalize_github_url(url)
    if not normalized:
        return None, None

    parts = normalized.replace("https://github.com/", "").split("/")
    if len(parts) == 2:
        return parts[0], parts[1]
    return None, None


def is_github_url(url: str | None) -> bool:
    """Check if a URL is a GitHub URL."""
    return normalize_github_url(url) is not None
