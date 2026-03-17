"""Tests for GitHub URL normalization."""

import pytest

from src.server.services.scanner.url_normalizer import (
    extract_github_owner_repo,
    is_github_url,
    normalize_github_url,
)


class TestNormalizeGithubUrl:
    def test_https_basic(self):
        assert normalize_github_url("https://github.com/user/repo") == "https://github.com/user/repo"

    def test_https_with_git_suffix(self):
        assert normalize_github_url("https://github.com/user/repo.git") == "https://github.com/user/repo"

    def test_https_with_trailing_slash(self):
        assert normalize_github_url("https://github.com/user/repo/") == "https://github.com/user/repo"

    def test_https_mixed_case(self):
        assert normalize_github_url("https://github.com/User/Repo") == "https://github.com/user/repo"

    def test_ssh_basic(self):
        assert normalize_github_url("git@github.com:user/repo.git") == "https://github.com/user/repo"

    def test_ssh_without_git_suffix(self):
        assert normalize_github_url("git@github.com:user/repo") == "https://github.com/user/repo"

    def test_ssh_with_trailing_slash(self):
        assert normalize_github_url("git@github.com:user/repo/") == "https://github.com/user/repo"

    def test_non_github_https(self):
        assert normalize_github_url("https://gitlab.com/user/repo") is None

    def test_non_github_ssh(self):
        assert normalize_github_url("git@gitlab.com:user/repo.git") is None

    def test_bitbucket(self):
        assert normalize_github_url("https://bitbucket.org/user/repo") is None

    def test_none_input(self):
        assert normalize_github_url(None) is None

    def test_empty_string(self):
        assert normalize_github_url("") is None

    def test_whitespace(self):
        assert normalize_github_url("  https://github.com/user/repo  ") == "https://github.com/user/repo"

    def test_http_instead_of_https(self):
        assert normalize_github_url("http://github.com/user/repo") == "https://github.com/user/repo"

    def test_url_with_extra_path(self):
        # Should still extract owner/repo
        assert normalize_github_url("https://github.com/user/repo/tree/main") == "https://github.com/user/repo"

    def test_invalid_format(self):
        assert normalize_github_url("not-a-url") is None


class TestExtractGithubOwnerRepo:
    def test_basic_https(self):
        assert extract_github_owner_repo("https://github.com/coleam00/Archon") == ("coleam00", "archon")

    def test_basic_ssh(self):
        assert extract_github_owner_repo("git@github.com:coleam00/Archon.git") == ("coleam00", "archon")

    def test_non_github(self):
        assert extract_github_owner_repo("https://gitlab.com/user/repo") == (None, None)

    def test_none(self):
        assert extract_github_owner_repo(None) == (None, None)


class TestIsGithubUrl:
    def test_github_https(self):
        assert is_github_url("https://github.com/user/repo") is True

    def test_github_ssh(self):
        assert is_github_url("git@github.com:user/repo.git") is True

    def test_non_github(self):
        assert is_github_url("https://gitlab.com/user/repo") is False

    def test_none(self):
        assert is_github_url(None) is False
