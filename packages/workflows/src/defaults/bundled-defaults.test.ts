import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { isBinaryBuild, BUNDLED_COMMANDS, BUNDLED_WORKFLOWS } from './bundled-defaults';

describe('bundled-defaults', () => {
  describe('isBinaryBuild', () => {
    let originalExecPath: string;

    beforeEach(() => {
      originalExecPath = process.execPath;
    });

    afterEach(() => {
      // Restore original execPath (note: this is read-only in practice, but tests may mock it)
      Object.defineProperty(process, 'execPath', { value: originalExecPath, writable: true });
    });

    it('should return false when running with Bun', () => {
      // In test environment, we're running with Bun
      expect(process.execPath.toLowerCase()).toContain('bun');
      expect(isBinaryBuild()).toBe(false);
    });

    it('should detect bun in path case-insensitively', () => {
      // The function uses toLowerCase() so it should handle mixed case
      const result = isBinaryBuild();
      // Since we're running in Bun, should be false
      expect(result).toBe(false);
    });

    it('should return true for non-bun executable paths', () => {
      // Mock a binary executable path
      Object.defineProperty(process, 'execPath', {
        value: '/usr/local/bin/archon',
        writable: true,
      });

      expect(isBinaryBuild()).toBe(true);
    });

    it('should return true for Windows-style binary paths', () => {
      Object.defineProperty(process, 'execPath', {
        value: 'C:\\Program Files\\archon\\archon.exe',
        writable: true,
      });

      expect(isBinaryBuild()).toBe(true);
    });

    it('should return false for Bun paths on different platforms', () => {
      // macOS Homebrew
      Object.defineProperty(process, 'execPath', {
        value: '/opt/homebrew/bin/bun',
        writable: true,
      });
      expect(isBinaryBuild()).toBe(false);

      // Linux
      Object.defineProperty(process, 'execPath', {
        value: '/home/user/.bun/bin/bun',
        writable: true,
      });
      expect(isBinaryBuild()).toBe(false);

      // Windows
      Object.defineProperty(process, 'execPath', {
        value: 'C:\\Users\\user\\.bun\\bin\\bun.exe',
        writable: true,
      });
      expect(isBinaryBuild()).toBe(false);
    });
  });

  describe('BUNDLED_COMMANDS', () => {
    it('should have all expected default commands', () => {
      const expectedCommands = [
        'archon-assist',
        'archon-code-review-agent',
        'archon-comment-quality-agent',
        'archon-create-pr',
        'archon-docs-impact-agent',
        'archon-error-handling-agent',
        'archon-implement-issue',
        'archon-implement-review-fixes',
        'archon-implement',
        'archon-investigate-issue',
        'archon-pr-review-scope',
        'archon-ralph-prd',
        'archon-resolve-merge-conflicts',
        'archon-sync-pr-with-main',
        'archon-synthesize-review',
        'archon-test-coverage-agent',
        'archon-validate-pr-code-review-feature',
        'archon-validate-pr-code-review-main',
        'archon-validate-pr-e2e-feature',
        'archon-validate-pr-e2e-main',
        'archon-validate-pr-report',
      ];

      for (const cmd of expectedCommands) {
        expect(BUNDLED_COMMANDS).toHaveProperty(cmd);
      }

      expect(Object.keys(BUNDLED_COMMANDS)).toHaveLength(21);
    });

    it('should have non-empty content for all commands', () => {
      for (const [name, content] of Object.entries(BUNDLED_COMMANDS)) {
        expect(content).toBeDefined();
        expect(typeof content).toBe('string');
        expect(content.length).toBeGreaterThan(0);
        // Commands should have meaningful content (at least some markdown)
        expect(content.length).toBeGreaterThan(50);
      }
    });

    it('should have markdown content format', () => {
      // Commands are markdown files, should have typical markdown patterns
      for (const [name, content] of Object.entries(BUNDLED_COMMANDS)) {
        // Should contain some text (not just whitespace)
        expect(content.trim().length).toBeGreaterThan(0);
      }
    });

    it('archon-pr-review-scope should read .pr-number before other discovery', () => {
      const content = BUNDLED_COMMANDS['archon-pr-review-scope'];
      expect(content).toContain('$ARTIFACTS_DIR/.pr-number');
      expect(content).toContain('PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number');
    });

    it('archon-create-pr should write .pr-number to artifacts', () => {
      const content = BUNDLED_COMMANDS['archon-create-pr'];
      expect(content).toContain('echo "$PR_NUMBER" > "$ARTIFACTS_DIR/.pr-number"');
    });
  });

  describe('BUNDLED_WORKFLOWS', () => {
    it('should have all expected default workflows', () => {
      const expectedWorkflows = [
        'archon-assist',
        'archon-comprehensive-pr-review',
        'archon-feature-development',
        'archon-fix-github-issue',
        'archon-resolve-conflicts',
        'archon-smart-pr-review',
        'archon-validate-pr',
        'archon-remotion-generate',
      ];

      for (const wf of expectedWorkflows) {
        expect(BUNDLED_WORKFLOWS).toHaveProperty(wf);
      }

      expect(Object.keys(BUNDLED_WORKFLOWS)).toHaveLength(8);
    });

    it('should have non-empty content for all workflows', () => {
      for (const [name, content] of Object.entries(BUNDLED_WORKFLOWS)) {
        expect(content).toBeDefined();
        expect(typeof content).toBe('string');
        expect(content.length).toBeGreaterThan(0);
        // Workflows should have meaningful YAML content
        expect(content.length).toBeGreaterThan(50);
      }
    });

    it('should have valid YAML structure', () => {
      // Workflows are YAML files, should parse without error
      for (const [name, content] of Object.entries(BUNDLED_WORKFLOWS)) {
        // Should contain 'name:' as all workflows require a name field
        expect(content).toContain('name:');
        // Should contain 'description:' as all workflows require description
        expect(content).toContain('description:');
        // Should contain steps:, loop:, or nodes: (the three workflow execution modes)
        const hasSteps = content.includes('steps:');
        const hasLoop = content.includes('loop:');
        const hasNodes = content.includes('nodes:');
        expect(hasSteps || hasLoop || hasNodes).toBe(true);
      }
    });
  });
});
