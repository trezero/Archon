"""Auto research service package — iterative prompt optimization via eval suites."""

from .eval_suite_loader import EvalSuiteLoader
from .evaluator import evaluate_output
from .mutator import mutate_prompt

__all__ = ["EvalSuiteLoader", "evaluate_output", "mutate_prompt"]
