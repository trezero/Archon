"""Loads and validates eval suite definitions from JSON files on disk."""

import json
from pathlib import Path

from pydantic import ValidationError

from ...models.auto_research import EvalSuiteDefinition, EvalSuiteSummary

# Default directory relative to this file's location in the package tree
_DEFAULT_SUITES_DIR = Path(__file__).parent.parent.parent / "data" / "eval_suites"


class EvalSuiteLoader:
    """Loads eval suite definitions from a directory of JSON files.

    Each JSON file represents one eval suite. The file stem is used as the suite ID,
    which must match the `id` field inside the JSON.
    """

    def __init__(self, suites_dir: str | None = None) -> None:
        self._suites_dir = Path(suites_dir) if suites_dir is not None else _DEFAULT_SUITES_DIR

    def load_suite(self, suite_id: str) -> EvalSuiteDefinition:
        """Load and validate an eval suite by its ID.

        Args:
            suite_id: The suite identifier (matches JSON filename without extension).

        Returns:
            Validated EvalSuiteDefinition.

        Raises:
            FileNotFoundError: If no JSON file exists for the given suite_id.
            ValueError: If the file contains invalid JSON or fails Pydantic validation.
        """
        suite_file = self._suites_dir / f"{suite_id}.json"

        if not suite_file.exists():
            raise FileNotFoundError(
                f"Eval suite '{suite_id}' not found. "
                f"Expected file at: {suite_file}"
            )

        try:
            raw = suite_file.read_text(encoding="utf-8")
        except OSError as e:
            raise ValueError(f"Failed to read eval suite file '{suite_file}': {e}") from e

        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ValueError(
                f"Eval suite file '{suite_file}' contains invalid JSON: {e}"
            ) from e

        try:
            suite = EvalSuiteDefinition.model_validate(data)
        except ValidationError as e:
            raise ValueError(
                f"Eval suite file '{suite_file}' failed validation:\n{e}"
            ) from e

        return suite

    def list_suites(self) -> list[EvalSuiteSummary]:
        """Scan the suites directory and return a summary for each valid JSON file.

        Files that fail to load are skipped with a logged warning rather than raising,
        so a single malformed file does not prevent listing all other suites.

        Returns:
            List of EvalSuiteSummary sorted by suite id.
        """
        if not self._suites_dir.exists():
            return []

        summaries: list[EvalSuiteSummary] = []

        for entry in sorted(self._suites_dir.iterdir()):
            if entry.suffix != ".json" or not entry.is_file():
                continue

            suite_id = entry.stem
            try:
                suite = self.load_suite(suite_id)
            except (FileNotFoundError, ValueError) as e:
                # Log but continue — don't let one bad file break the list
                import logging
                logging.getLogger(__name__).warning(
                    "Skipping eval suite file '%s': %s", entry.name, e
                )
                continue

            summaries.append(
                EvalSuiteSummary(
                    id=suite.id,
                    name=suite.name,
                    description=suite.description,
                    target_file=suite.target_file,
                    test_case_count=len(suite.test_cases),
                )
            )

        return summaries
