import { describe, it, expect } from 'bun:test';
import { evaluateCondition } from './condition-evaluator';
import type { NodeOutput } from './types';

function makeOutput(
  output: string,
  state: 'completed' | 'failed' | 'skipped' = 'completed'
): NodeOutput {
  if (state === 'failed') return { state, output, error: 'error' };
  return { state, output };
}

describe('evaluateCondition', () => {
  it('== operator: returns true when output matches', () => {
    const outputs = new Map([['classify', makeOutput('BUG')]]);
    expect(evaluateCondition("$classify.output == 'BUG'", outputs).result).toBe(true);
  });

  it('== operator: returns false when output does not match', () => {
    const outputs = new Map([['classify', makeOutput('FEATURE')]]);
    expect(evaluateCondition("$classify.output == 'BUG'", outputs).result).toBe(false);
  });

  it('!= operator: returns true when output differs', () => {
    const outputs = new Map([['classify', makeOutput('FEATURE')]]);
    expect(evaluateCondition("$classify.output != 'BUG'", outputs).result).toBe(true);
  });

  it('!= operator: returns false when output equals the value', () => {
    const outputs = new Map([['classify', makeOutput('BUG')]]);
    expect(evaluateCondition("$classify.output != 'BUG'", outputs).result).toBe(false);
  });

  it('dot notation: accesses JSON field for output_format nodes', () => {
    const jsonOutput = JSON.stringify({ type: 'BUG', confidence: 0.9 });
    const outputs = new Map([['classify', makeOutput(jsonOutput)]]);
    expect(evaluateCondition("$classify.output.type == 'BUG'", outputs).result).toBe(true);
    expect(evaluateCondition("$classify.output.type == 'FEATURE'", outputs).result).toBe(false);
  });

  it('dot notation: returns false on invalid JSON (fails gracefully)', () => {
    const outputs = new Map([['classify', makeOutput('not-json')]]);
    // Should not throw; JSON parse fails, resolves to '', so == 'BUG' is false
    expect(evaluateCondition("$classify.output.type == 'BUG'", outputs).result).toBe(false);
  });

  it('unknown node: treats missing node output as empty string', () => {
    const outputs = new Map<string, NodeOutput>();
    expect(evaluateCondition("$missing.output == ''", outputs).result).toBe(true);
    expect(evaluateCondition("$missing.output == 'BUG'", outputs).result).toBe(false);
  });

  it('failed node: output is empty string, conditions evaluate accordingly', () => {
    const outputs = new Map([['classify', makeOutput('', 'failed')]]);
    expect(evaluateCondition("$classify.output == ''", outputs).result).toBe(true);
    expect(evaluateCondition("$classify.output == 'BUG'", outputs).result).toBe(false);
  });

  it('invalid expression: defaults to true (fail open) with parsed: false', () => {
    const outputs = new Map<string, NodeOutput>();
    const res = evaluateCondition('not a valid condition', outputs);
    expect(res.result).toBe(true);
    expect(res.parsed).toBe(false);
  });

  it('valid expression returns parsed: true', () => {
    const outputs = new Map([['n', makeOutput('FOO')]]);
    const res = evaluateCondition("$n.output == 'FOO'", outputs);
    expect(res.parsed).toBe(true);
  });

  it('supports spaces around operator', () => {
    const outputs = new Map([['n', makeOutput('FOO')]]);
    expect(evaluateCondition("$n.output=='FOO'", outputs).result).toBe(true);
    expect(evaluateCondition("$n.output == 'FOO'", outputs).result).toBe(true);
  });

  it('empty expected value: matches empty output', () => {
    const outputs = new Map([['n', makeOutput('')]]);
    expect(evaluateCondition("$n.output == ''", outputs).result).toBe(true);
  });

  it('dot notation != operator: returns true when JSON field differs', () => {
    const jsonOutput = JSON.stringify({ type: 'FEATURE' });
    const outputs = new Map([['classify', makeOutput(jsonOutput)]]);
    expect(evaluateCondition("$classify.output.type != 'BUG'", outputs).result).toBe(true);
  });

  it('dot notation: coerces number field to string', () => {
    const outputs = new Map([['n', makeOutput(JSON.stringify({ confidence: 0.9 }))]]);
    expect(evaluateCondition("$n.output.confidence == '0.9'", outputs).result).toBe(true);
  });

  it('dot notation: coerces boolean field to string', () => {
    const outputs = new Map([['n', makeOutput(JSON.stringify({ valid: true }))]]);
    expect(evaluateCondition("$n.output.valid == 'true'", outputs).result).toBe(true);
  });

  it('dot notation: works with clean structured output (simulates output_format fix)', () => {
    // After the fix, output_format nodes store clean JSON (from SDK structured_output)
    // instead of mixed prose+JSON
    const cleanJson = JSON.stringify({ run_code_review: 'true', run_tests: 'false' });
    const outputs = new Map([['classify', makeOutput(cleanJson)]]);
    expect(evaluateCondition("$classify.output.run_code_review == 'true'", outputs).result).toBe(
      true
    );
    expect(evaluateCondition("$classify.output.run_tests == 'true'", outputs).result).toBe(false);
    expect(evaluateCondition("$classify.output.run_tests == 'false'", outputs).result).toBe(true);
  });
});
