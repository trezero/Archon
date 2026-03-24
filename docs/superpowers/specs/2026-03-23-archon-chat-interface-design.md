# Archon Chat Interface — Design Spec

**Date**: 2026-03-23
**Status**: Draft
**Author**: AI-assisted design via brainstorming session

## Overview

An interactive AI chat interface within the Archon application that serves as a strategic advisor and project management assistant. The chat understands the user's identity, goals, and current work context to help brainstorm new project ideas, discover synergies between projects, and prioritize work based on multiple contextual signals.

## Goals

1. Provide a conversational interface to interact with all Archon data (projects, tasks, knowledge, sessions)
2. Help users brainstorm new project ideas and discover how existing projects could work together
3. Prioritize work recommendations based on user identity, goals, activity patterns, and current context
4. Support both quick interactions (sidebar) and deep conversations (full page)
5. Allow the AI to take actions on the user's behalf with explicit approval

## Non-Goals

- Real-time collaboration (multi-user chat)
- Voice input/output
- External integrations beyond existing Archon data
- Task deadline/due date tracking (not in current schema)

## Architecture

### System Overview

The chat system spans three layers following Approach 2 (Agent Service Integration):

```
Frontend (archon-ui-main)
    ↕ REST (persistence) + SSE (streaming)
Main Server (port 8181)
    ↕ HTTP (AI requests)
Agent Service (port 8052)
    ↕ PydanticAI
AI Provider (Claude, OpenAI, etc.)
```

### Layer Responsibilities

**Frontend** (`archon-ui-main/src/features/chat/`):
- New vertical slice: components, hooks, services, types
- Sidebar panel component (accessible from any page via floating button)
- Full `/chat` page for deep conversations
- Conversation list, message stream, tool-use display
- SSE client for streaming responses

**Main Server** (port 8181) — Data & persistence layer:
- New chat API routes for CRUD: conversations, messages, user profile
- Database tables for persistent, searchable chat history
- No AI logic — storage and retrieval only
- Proxies chat requests to agent service

**Agent Service** (port 8052) — AI & streaming layer:
- New ChatAgent (PydanticAI) with tools that call back to main server
- SSE streaming endpoint for real-time token and tool-use events
- Orchestrates existing agents (RAG, Document, Synthesizer) as sub-tools
- Model routing: dispatches to user's configured provider

### Data Flow

1. User sends message → Frontend POSTs to Main Server (saves user message)
2. Main Server forwards to Agent Service with conversation context
3. Agent Service runs ChatAgent, which may call tools (back to Main Server for data)
4. Agent Service streams SSE events back to Frontend (text deltas, tool use, etc.)
5. On stream completion, Frontend POSTs final assistant message to Main Server for persistence

## Database Schema

### New Tables (Migration 025)

#### chat_conversations

| Column | Type | Description |
|---|---|---|
| id | uuid, PK | Conversation identifier |
| title | text | Auto-generated or user-editable title |
| project_id | uuid, nullable, FK → archon_projects | Null = global chat |
| conversation_type | text | "global" or "project" |
| model_config | jsonb | Model provider, temperature, etc. |
| action_mode | boolean, default false | Advisor vs. agent mode |
| created_at | timestamptz | Creation time |
| updated_at | timestamptz | Last activity time |
| metadata | jsonb | Flexible storage for future needs |

#### chat_messages

| Column | Type | Description |
|---|---|---|
| id | uuid, PK | Message identifier |
| conversation_id | uuid, FK → chat_conversations | Parent conversation |
| role | text | "user", "assistant", "system", "tool" |
| content | text | Message body |
| tool_calls | jsonb, nullable | Array of tool invocations the AI made |
| tool_results | jsonb, nullable | Results from tool executions |
| model_used | text, nullable | Which model generated this response |
| token_count | integer, nullable | Usage tracking |
| created_at | timestamptz | Message timestamp |
| search_vector | tsvector | Full-text search vector |

#### user_profile

| Column | Type | Description |
|---|---|---|
| id | uuid, PK | Profile identifier |
| display_name | text | User's name |
| bio | text | Who you are, what you do |
| long_term_goals | jsonb | Array of stated goals |
| current_priorities | jsonb | What matters this week/month |
| preferences | jsonb | Communication style, detail level, etc. |
| onboarding_completed | boolean, default false | Whether initial onboarding is done |
| updated_at | timestamptz | Last update time |

### Schema Modifications

#### archon_projects (existing table — new optional columns)

| Column | Type | Description |
|---|---|---|
| project_goals | jsonb, nullable | Array of project-specific goals |
| project_relevance | text, nullable | The WHY of this project (free-form) |
| project_category | text, nullable | User-defined category label |

### Indexes

- Full-text search: GIN index on `chat_messages.search_vector`
- Message ordering: composite index on `(conversation_id, created_at)`
- Project scoping: index on `chat_conversations.project_id`
- Category filtering: index on `archon_projects.project_category`

## ChatAgent Design

### Location

`python/src/agents/chat_agent.py`

### Dependencies (injected per request)

```python
@dataclass
class ChatDependencies:
    conversation_id: str
    project_id: str | None  # None for global chat
    user_profile: dict       # From user_profile table
    action_mode: bool        # What the agent is allowed to do
    model_override: str | None  # User's configured model
```

### System Prompt Assembly

Dynamic, assembled per conversation turn:

1. **Base persona**: "You are Archon, an AI assistant that helps manage and prioritize projects..."
2. **User context**: bio, goals, current priorities from `user_profile`
3. **Project context** (if project-scoped): project details, recent tasks, documents, knowledge sources
4. **Available tools**: description based on `action_mode` tier
5. **Current date/time**: for temporal awareness in prioritization

### Tools — Advisor Mode (always available)

| Tool | Description |
|---|---|
| `search_knowledge_base()` | RAG search across all or project-specific sources |
| `search_code_examples()` | Find code snippets in the knowledge base |
| `list_projects()` | Get all projects with status, categories, goals |
| `get_project_detail()` | Deep dive on one project |
| `list_tasks()` | Tasks with filters (status, project, assignee) |
| `get_task_detail()` | Single task with full context |
| `list_documents()` | Project documents |
| `get_session_history()` | Recent activity across machines |
| `analyze_project_synergies()` | Cross-reference projects for overlap/dependencies |
| `get_prioritization_context()` | Aggregates all prioritization signals |
| `suggest_project_category()` | AI-suggested category for a project |

### Tools — Action Mode (only when `action_mode = true`)

| Tool | Description |
|---|---|
| `create_task()` | Create a new task in a project |
| `update_task()` | Change status, assignee, details |
| `create_document()` | Write a new project document |
| `update_project()` | Modify project metadata |
| `trigger_knowledge_crawl()` | Start crawling a URL into knowledge base |

Each action tool returns a confirmation prompt before executing, giving the user a chance to approve inline.

## Prioritization Engine

The ChatAgent tool `get_prioritization_context()` aggregates 5 signal categories:

### 1. Momentum (Activity Patterns)

- Analyzes session history: which projects have recent commits/activity
- Identifies stalled projects (no activity in X days)
- Weight: stalled projects receive attention nudges

### 2. Strategic Alignment (Goal Matching)

- Cross-references `user_profile.long_term_goals` with each project's `project_goals` and `project_relevance`
- Scores how directly each project advances stated goals
- Weight: highest for projects that move the needle on top goals

### 3. Dependencies (Unblocking Analysis)

- Maps cross-project dependencies from project metadata and documents
- Identifies bottleneck projects that block others
- Weight: high for projects that unblock the most downstream work

### 4. Effort Matching (Energy-Aware)

- Time of day awareness (morning = deep work, afternoon = lighter tasks)
- Recent session length/intensity
- Task complexity estimation based on description
- Weight: matches task difficulty to inferred energy level

### 5. Contextual Weighting (AI Synthesis)

- The ChatAgent uses all 4 signals above plus conversation context to generate a prioritized recommendation
- Not a rigid formula — the AI synthesizes naturally, explaining its reasoning
- User can push back and the AI adjusts

### Example Interactions

- "What should I work on right now?"
- "Which of my projects is most important this week?"
- "I have 30 minutes, what's the best use of my time?"
- "I'm in CTO mode — what needs attention at Datacore?"

## User Profile System

### Manual Profile

A new "My Profile" section in the Settings page:

- **Display name**: user's name
- **Bio**: who you are, what you do professionally
- **Long-term goals**: array of goals, add/remove/reorder
- **Current priorities**: what matters this week/month
- **Preferences**: communication style (concise vs. detailed, technical depth)

### Auto-Inferred Context

Assembled fresh each conversation from live data (not stored):

- All projects with descriptions, goals, categories, features, task counts by status
- Recent session history (which projects were active, on which machines)
- LeaveOff points (what was being worked on, what's next)
- Knowledge sources (what documentation has been ingested)
- Skills/extensions installed (what tools are available)

### AI-Guided Onboarding

**First-time experience**:
- User opens chat for the first time → AI initiates onboarding automatically
- Conversational interview — asks questions one at a time:
  - "What do you do professionally?" → populates bio
  - "What are your main goals right now?" → populates long_term_goals
  - "What's your biggest priority this week?" → populates current_priorities
  - "How do you prefer to receive advice?" → populates preferences
- Profile filled progressively as the user answers
- AI summarizes at the end: "Here's what I've learned about you" — user confirms/edits
- Transitions naturally into the first real conversation

**Re-onboarding** (`/onboarding` command):
- Available anytime from the chat input
- AI reads current profile and asks targeted questions about what's changed
- Focuses on gaps or stale info, not a full redo
- "Your current priorities mention X from a while ago — is that still accurate?"
- "I see you've added 3 new projects since we last updated. Want to tell me about them?"
- Updates profile incrementally based on answers

## Project Enrichment

### New Fields on archon_projects

- **project_goals** (jsonb): array of project-specific goals
- **project_relevance** (text): the WHY of this project, free-form
- **project_category** (text): user-defined category label

### AI-Suggested Categories

- When creating a project or opening the "About" section, the AI suggests a category based on project name, description, and existing categories
- Suggestion appears as a pre-filled but editable field
- Autocomplete dropdown shows existing categories to prevent duplicates (e.g., "work:datacore" vs. "work:Datacore")
- The ChatAgent has a `suggest_project_category()` tool for batch categorization in action mode

## Cross-Project Synergy Analysis

The `analyze_project_synergies()` tool performs on-demand AI reasoning:

1. **Gather**: collects all projects with descriptions, goals, categories, knowledge sources, tech stacks, recent activity
2. **Cross-reference**: the AI analyzes pairings for:
   - Shared technology
   - Complementary capabilities
   - Knowledge overlap
   - Goal alignment
   - Reusable components
3. **Present**: natural language analysis with specific recommendations

Example output:
> "I see some interesting connections:
> - Archon and RecipeRaiders both use FastAPI + Supabase. Patterns you build in one could accelerate the other.
> - Your kids' learning app could use the RAG pipeline from Archon to create a searchable study guide.
> - Three of your Datacore projects share authentication needs — a shared auth library could save time across all of them."

Triggered by questions like:
- "How could project X and Y work together?"
- "Are any of my projects duplicating effort?"
- "Show me connections between my projects"

## Streaming & SSE Protocol

### Endpoint

`POST /agents/chat/stream` on the Agent Service (port 8052)

### Event Types

| Event | Payload | Purpose |
|---|---|---|
| `message_start` | `{ conversation_id, message_id }` | AI begins responding |
| `text_delta` | `{ delta: "Hello, " }` | Token-by-token text chunk |
| `tool_start` | `{ tool_name, tool_args }` | AI is invoking a tool |
| `tool_result` | `{ tool_name, result_summary, duration_ms }` | Tool completed |
| `action_request` | `{ action, details, requires_approval }` | AI wants to take an action |
| `message_complete` | `{ message_id, model_used, token_count }` | Response finished |
| `error` | `{ error, retryable }` | Something went wrong |
| `heartbeat` | (comment line, no data) | Keepalive every 15 seconds |

### Action Approval Flow

1. Agent Service sends `action_request` event
2. Frontend renders approve/deny buttons inline
3. On approve: `POST /agents/chat/confirm-action`
4. On deny: `POST /agents/chat/deny-action` — AI adjusts its response

## Frontend UI

### Vertical Slice Structure

```
archon-ui-main/src/features/chat/
├── components/
│   ├── ChatSidebar.tsx          # Floating sidebar panel
│   ├── ChatPage.tsx             # Full /chat page layout
│   ├── ConversationList.tsx     # Left sidebar on full page
│   ├── MessageStream.tsx        # Main message display area
│   ├── MessageBubble.tsx        # Individual message rendering
│   ├── ToolUseCard.tsx          # Collapsible tool invocation display
│   ├── ActionRequestCard.tsx    # Approve/deny action UI
│   ├── ChatInput.tsx            # Message input with model selector
│   ├── ModelSelector.tsx        # Model picker chip/dropdown
│   ├── ConversationContext.tsx  # Right panel (project scope, action mode)
│   └── OnboardingFlow.tsx       # First-time profile interview
├── hooks/
│   └── useChatQueries.ts        # Query hooks, keys, SSE connection
├── services/
│   └── chatService.ts           # API calls to main server + agent service
├── types/
│   └── index.ts                 # Chat-specific TypeScript types
└── views/
    └── ChatView.tsx             # Main view orchestrator
```

### Sidebar Panel

- Activated by the existing floating Archon logo button (bottom-right of `MainLayout.tsx`)
- Slides in from the right, ~400px wide, overlays current page
- Shows: current conversation messages, input box, model indicator
- Compact view — tool-use cards collapsed by default
- "Expand" button opens full `/chat` page with current conversation
- "New chat" button + dropdown to switch conversations
- Dismissible without losing state

### Full Page (`/chat` route)

- **Left sidebar**: conversation list (searchable, filterable by global/project)
- **Main area**: full message stream with expanded tool-use cards
- **Right panel** (collapsible): conversation context — project scope, action mode toggle, model selector
- **Message input** at bottom:
  - Text area (Shift+Enter for newline, Enter to send)
  - Model selector chip
  - Action mode toggle (lock icon)

### Message Rendering

- **User messages**: right-aligned, accent color
- **Assistant messages**: left-aligned, glassmorphic card
- **Tool-use cards**: collapsible sections showing tool name, args, result summary, duration
- **Action requests**: highlighted card with approve/deny buttons, amber/orange glow
- **Code blocks**: syntax-highlighted with copy button
- **Markdown**: full rendering for all assistant content

### Glassmorphism Styling

Follows existing Tron aesthetic from `features/ui/primitives/styles.ts`:
- Message bubbles: `backdrop-blur-xl bg-white/5`
- Tool cards: subtle cyan border glow
- Action requests: amber/orange glow to draw attention

## Model Configuration

### Settings Page — Global Defaults

- New "Chat Models" section in Settings
- Configure available providers via API keys (Anthropic, OpenAI, etc.)
- Set default chat model (e.g., `anthropic:claude-sonnet-4-6`)
- Stored in existing credentials system (encrypted)

### Per-Conversation Override

- Model selector chip in chat input area
- Shows available models based on configured API keys
- Mid-conversation model switching allowed — `model_used` on each message tracks which model generated it
- Conversation-level default stored in `chat_conversations.model_config`

### Fallback Behavior

- If no model is configured, chat shows: "Configure an AI model in Settings to start chatting"
- No hard-coded default — user must explicitly choose
- Models without configured API keys are grayed out in the selector

## Chat History & Search

### Full-Text Search

- PostgreSQL tsvector on `chat_messages.search_vector`
- Searchable from the conversation list sidebar on `/chat` page
- Results show: matching message snippet, conversation title, date, project scope
- Click a result to jump to that message in context

### Conversation Management

- **Auto-title**: after first AI response, the AI generates a short title
- **Rename**: user can edit conversation titles
- **Sort**: by last activity (`updated_at`)
- **Filter**: all, global only, specific project
- **Delete**: soft delete (marks as deleted, purgeable later)
- **No limit**: database handles scale

### Context Window Management

- ChatAgent does not send all messages to the AI every turn
- Strategy: last N messages (configurable, default ~20) + summary of earlier messages
- The existing SynthesizerAgent compresses older messages when conversation exceeds the window
- Keeps costs and latency down while maintaining conversational coherence

## API Endpoints

### Main Server (port 8181) — Persistence

| Method | Path | Description |
|---|---|---|
| GET | `/api/chat/conversations` | List conversations (with search/filter) |
| POST | `/api/chat/conversations` | Create conversation |
| GET | `/api/chat/conversations/{id}` | Get conversation detail |
| PUT | `/api/chat/conversations/{id}` | Update conversation (title, model, action mode) |
| DELETE | `/api/chat/conversations/{id}` | Soft delete conversation |
| GET | `/api/chat/conversations/{id}/messages` | Get messages (paginated) |
| POST | `/api/chat/conversations/{id}/messages` | Save a message |
| GET | `/api/chat/messages/search` | Full-text search across all messages |
| GET | `/api/chat/profile` | Get user profile |
| PUT | `/api/chat/profile` | Update user profile |
| GET | `/api/chat/categories` | List distinct project categories (for autocomplete) |

### Agent Service (port 8052) — AI Processing

| Method | Path | Description |
|---|---|---|
| POST | `/agents/chat/stream` | Send message + receive SSE stream |
| POST | `/agents/chat/confirm-action` | Approve a pending action |
| POST | `/agents/chat/deny-action` | Deny a pending action |
| POST | `/agents/chat/onboarding/stream` | Start/continue onboarding interview |
| POST | `/agents/chat/suggest-category` | Get AI category suggestion for a project |
