# Homebrew formula for Archon CLI
# To install: brew install dynamous-community/tap/archon
#
# This formula downloads pre-built binaries from GitHub releases.
# For development, see: https://github.com/dynamous-community/remote-coding-agent

class Archon < Formula
  desc "Remote agentic coding platform - control AI assistants from anywhere"
  homepage "https://github.com/dynamous-community/remote-coding-agent"
  version "0.2.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/dynamous-community/remote-coding-agent/releases/download/v#{version}/archon-darwin-arm64"
      sha256 "PLACEHOLDER_SHA256_DARWIN_ARM64"
    end
    on_intel do
      url "https://github.com/dynamous-community/remote-coding-agent/releases/download/v#{version}/archon-darwin-x64"
      sha256 "PLACEHOLDER_SHA256_DARWIN_X64"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dynamous-community/remote-coding-agent/releases/download/v#{version}/archon-linux-arm64"
      sha256 "PLACEHOLDER_SHA256_LINUX_ARM64"
    end
    on_intel do
      url "https://github.com/dynamous-community/remote-coding-agent/releases/download/v#{version}/archon-linux-x64"
      sha256 "PLACEHOLDER_SHA256_LINUX_X64"
    end
  end

  def install
    binary_name = case
    when OS.mac? && Hardware::CPU.arm?
      "archon-darwin-arm64"
    when OS.mac? && Hardware::CPU.intel?
      "archon-darwin-x64"
    when OS.linux? && Hardware::CPU.arm?
      "archon-linux-arm64"
    when OS.linux? && Hardware::CPU.intel?
      "archon-linux-x64"
    end

    bin.install binary_name => "archon"
  end

  test do
    # Basic version check - archon version should exit with 0 on success
    assert_match version.to_s, shell_output("#{bin}/archon version")
  end
end
