"""Unit tests for EvalSuiteLoader."""

import json

import pytest

from src.server.services.auto_research.eval_suite_loader import EvalSuiteLoader

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

VALID_SUITE = {
    "id": "test-suite",
    "name": "Test Suite",
    "description": "A suite for unit testing",
    "target_file": "prompts/system.txt",
    "model": None,
    "mutation_guidance": "Keep it short",
    "test_cases": [
        {
            "id": "tc-1",
            "name": "Greeting test",
            "input": "Say hello",
            "signals": {
                "greets_user": {
                    "weight": 1.0,
                    "critical": False,
                    "description": "Response includes a greeting",
                }
            },
        }
    ],
}

VALID_SUITE_NO_DESCRIPTION = {
    "id": "minimal-suite",
    "name": "Minimal Suite",
    "target_file": "prompts/other.txt",
    "mutation_guidance": "Be direct",
    "test_cases": [],
}


@pytest.fixture()
def suites_dir(tmp_path):
    """Provide a temporary directory to act as the eval suites directory."""
    return tmp_path


@pytest.fixture()
def loader(suites_dir):
    return EvalSuiteLoader(suites_dir=str(suites_dir))


def write_json(directory, filename, data):
    path = directory / filename
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# load_suite tests
# ---------------------------------------------------------------------------


class TestLoadSuite:
    def test_loads_valid_suite(self, loader, suites_dir):
        write_json(suites_dir, "test-suite.json", VALID_SUITE)
        suite = loader.load_suite("test-suite")
        assert suite.id == "test-suite"
        assert suite.name == "Test Suite"
        assert len(suite.test_cases) == 1
        assert suite.test_cases[0].id == "tc-1"

    def test_loads_suite_with_default_description(self, loader, suites_dir):
        write_json(suites_dir, "minimal-suite.json", VALID_SUITE_NO_DESCRIPTION)
        suite = loader.load_suite("minimal-suite")
        assert suite.description == ""
        assert suite.test_cases == []

    def test_raises_file_not_found_for_missing_suite(self, loader):
        with pytest.raises(FileNotFoundError, match="nonexistent"):
            loader.load_suite("nonexistent")

    def test_raises_value_error_for_invalid_json(self, loader, suites_dir):
        path = suites_dir / "bad-json.json"
        path.write_text("{ this is not valid json }", encoding="utf-8")
        with pytest.raises(ValueError, match="invalid JSON"):
            loader.load_suite("bad-json")

    def test_raises_value_error_for_invalid_schema(self, loader, suites_dir):
        # Missing required fields: target_file and mutation_guidance
        incomplete = {"id": "x", "name": "y", "test_cases": []}
        write_json(suites_dir, "x.json", incomplete)
        with pytest.raises(ValueError, match="failed validation"):
            loader.load_suite("x")

    def test_suite_with_multiple_test_cases(self, loader, suites_dir):
        suite_data = {**VALID_SUITE, "test_cases": [
            {**VALID_SUITE["test_cases"][0], "id": "tc-1"},
            {**VALID_SUITE["test_cases"][0], "id": "tc-2", "name": "Second test"},
        ]}
        write_json(suites_dir, "test-suite.json", suite_data)
        suite = loader.load_suite("test-suite")
        assert len(suite.test_cases) == 2

    def test_suite_with_critical_signal(self, loader, suites_dir):
        suite_data = {
            **VALID_SUITE,
            "test_cases": [{
                "id": "tc-1",
                "name": "Critical test",
                "input": "Must respond safely",
                "signals": {
                    "safe_response": {
                        "weight": 2.0,
                        "critical": True,
                        "description": "Response is safe",
                    }
                },
            }],
        }
        write_json(suites_dir, "test-suite.json", suite_data)
        suite = loader.load_suite("test-suite")
        signal = suite.test_cases[0].signals["safe_response"]
        assert signal.critical is True
        assert signal.weight == 2.0


# ---------------------------------------------------------------------------
# list_suites tests
# ---------------------------------------------------------------------------


class TestListSuites:
    def test_empty_directory_returns_empty_list(self, loader):
        result = loader.list_suites()
        assert result == []

    def test_nonexistent_directory_returns_empty_list(self, tmp_path):
        loader = EvalSuiteLoader(suites_dir=str(tmp_path / "does-not-exist"))
        result = loader.list_suites()
        assert result == []

    def test_lists_single_valid_suite(self, loader, suites_dir):
        write_json(suites_dir, "test-suite.json", VALID_SUITE)
        summaries = loader.list_suites()
        assert len(summaries) == 1
        assert summaries[0].id == "test-suite"
        assert summaries[0].test_case_count == 1

    def test_lists_multiple_suites_sorted_by_filename(self, loader, suites_dir):
        write_json(suites_dir, "b-suite.json", {**VALID_SUITE, "id": "b-suite", "name": "B"})
        write_json(suites_dir, "a-suite.json", {**VALID_SUITE, "id": "a-suite", "name": "A"})
        summaries = loader.list_suites()
        assert len(summaries) == 2
        assert summaries[0].id == "a-suite"
        assert summaries[1].id == "b-suite"

    def test_skips_invalid_json_file(self, loader, suites_dir):
        write_json(suites_dir, "valid.json", VALID_SUITE)
        bad = suites_dir / "bad.json"
        bad.write_text("not json", encoding="utf-8")
        summaries = loader.list_suites()
        assert len(summaries) == 1
        assert summaries[0].id == "test-suite"

    def test_ignores_non_json_files(self, loader, suites_dir):
        write_json(suites_dir, "test-suite.json", VALID_SUITE)
        (suites_dir / "readme.txt").write_text("ignore me", encoding="utf-8")
        (suites_dir / "notes.md").write_text("# Notes", encoding="utf-8")
        summaries = loader.list_suites()
        assert len(summaries) == 1

    def test_summary_fields_are_correct(self, loader, suites_dir):
        write_json(suites_dir, "test-suite.json", VALID_SUITE)
        summaries = loader.list_suites()
        s = summaries[0]
        assert s.id == "test-suite"
        assert s.name == "Test Suite"
        assert s.description == "A suite for unit testing"
        assert s.target_file == "prompts/system.txt"
        assert s.test_case_count == 1

    def test_empty_suite_shows_zero_test_cases(self, loader, suites_dir):
        write_json(suites_dir, "minimal-suite.json", VALID_SUITE_NO_DESCRIPTION)
        summaries = loader.list_suites()
        assert summaries[0].test_case_count == 0


# ---------------------------------------------------------------------------
# Default directory tests
# ---------------------------------------------------------------------------


class TestDefaultDirectory:
    def test_default_loader_uses_data_eval_suites(self):
        """Loader without explicit dir should resolve to the data/eval_suites path."""
        loader = EvalSuiteLoader()
        assert loader._suites_dir.name == "eval_suites"
        assert loader._suites_dir.parent.name == "data"
