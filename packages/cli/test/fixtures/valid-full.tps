version: "1"
name: Full Test Agent
description: A fully-specified TPS report for testing all fields.
identity:
  default_name: FullTest
  emoji: "🧪"
  personality: Meticulous and thorough.
  communication_style: Detailed and precise.
flair:
  - testing
  - validation
  - quality
model:
  default: reasoning
tools:
  required:
    - file-ops
    - git
  optional:
    - web-search
communication:
  channels: [team-chat, direct]
  handoff_targets: [ops]
boundaries:
  can_commit: true
  can_send_external: false
  can_spend: false
memory:
  private: true
  shared_read: [project-state]
  shared_write: [project-state]
openclaw:
  model: "anthropic/claude-sonnet-4-20250514"
  thinking: "low"
  channel: "discord"
