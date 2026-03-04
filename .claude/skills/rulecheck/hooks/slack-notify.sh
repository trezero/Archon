#!/bin/bash
# Stop hook: notify Slack with a formatted summary of the rulecheck run.
# Reads the agent's summary file and formats a Slack message payload.
#
# Input: JSON on stdin with stop event context (includes last_assistant_message)
# Output: exit 0 always (notification failure should not block the agent)
#
# Requires: SLACK_WEBHOOK_URL environment variable (optional — graceful skip if unset)

INPUT=$(cat)

# No webhook URL — skip gracefully
if [ -z "${SLACK_WEBHOOK_URL:-}" ]; then
  echo "SLACK_WEBHOOK_URL not set, skipping notification" >&2
  exit 0
fi

# Try to read the summary file written by the agent
SUMMARY_FILE=".claude/archon/rulecheck-last-run.json"
if [ -f "$SUMMARY_FILE" ]; then
  FIXED_COUNT=$(jq -r '.fixed_count // 0' "$SUMMARY_FILE" 2>/dev/null)
  PR_URL=$(jq -r '.pr_url // "none"' "$SUMMARY_FILE" 2>/dev/null)
  OPPORTUNITIES=$(jq -r '.opportunities_remaining // 0' "$SUMMARY_FILE" 2>/dev/null)
  FOCUS=$(jq -r '.focus_area // "general"' "$SUMMARY_FILE" 2>/dev/null)
  FILES_CHANGED=$(jq -r '.files_changed // [] | join(", ")' "$SUMMARY_FILE" 2>/dev/null)
else
  FIXED_COUNT="?"
  PR_URL="none"
  OPPORTUNITIES="?"
  FOCUS="general"
  FILES_CHANGED="unknown"
fi

# Build Slack message
if [ "$PR_URL" != "none" ] && [ "$PR_URL" != "null" ] && [ -n "$PR_URL" ]; then
  PR_LINE="*PR*: <${PR_URL}|View Pull Request>"
else
  PR_LINE="*PR*: No PR created"
fi

PAYLOAD=$(jq -n \
  --arg fixed "$FIXED_COUNT" \
  --arg pr "$PR_LINE" \
  --arg opps "$OPPORTUNITIES" \
  --arg focus "$FOCUS" \
  --arg files "$FILES_CHANGED" \
  '{
    "blocks": [
      {
        "type": "header",
        "text": { "type": "plain_text", "text": "Rulecheck Agent Run Complete" }
      },
      {
        "type": "section",
        "fields": [
          { "type": "mrkdwn", "text": ("*Focus*: " + $focus) },
          { "type": "mrkdwn", "text": ("*Fixed*: " + $fixed + " violations") },
          { "type": "mrkdwn", "text": $pr },
          { "type": "mrkdwn", "text": ("*Remaining*: " + $opps + " opportunities") }
        ]
      },
      {
        "type": "section",
        "text": { "type": "mrkdwn", "text": ("*Files changed*: " + $files) }
      }
    ]
  }')

# Send to Slack — don't let curl failure block the agent
curl -s -X POST "$SLACK_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" > /dev/null 2>&1 || true

exit 0
