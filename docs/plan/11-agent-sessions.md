# 11 — Agent sessions on the server

For a served folder (`pumice-server <folder>`), an agent's conversation and its process live on
the server, not in a window. Anyone in the vault sees the conversations, joins one from any
device, and finds it where it was after closing the laptop. The use it is for: dispatching work
on the machine that has the folder (runs, jobs, analyses) that reports back into notes.

## Why

Today an agent belongs to the window that started it:

- **Closing the window ends the work.** The agent and everything it started end with the page
  (`apps/server/src/agents.ts`). A job handed to a scheduler survives, but the agent's own
  follow-up ("when the run is done, write the summary") does not.
- **The conversation stays in that window.** Chats are files in the vault's `.pumice/chats/`,
  which a shared vault does not share (dot-folders are not part of it), and an agent is resumed by
  its own session id, which only means something where it ran.

## The model

A **session** is one conversation with one agent, kept by the server of the vault:

- its transcript (what was said, the agent's tool calls and their results), its title, its agent,
  its state (working, waiting for an answer, idle, ended);
- the agent's process while it runs (in the folder, its process group), and the agent's own
  session id to pick it up again after a restart of the server.

Sessions are files in the served folder's `.pumice/chats/`, in the format the app already uses
(`SavedChat`), written by the server. So opening the folder itself in the desktop app shows them
too.

**The agent edits through the vault.** On the server, the ACP client is the server: the agent's
file requests (`fs/read_text_file`, `fs/write_text_file`) read and change the vault's documents
there, as the agent (its own Yjs client, its name, change marks), merged with whatever people
type at the same moment. Its own tools (shell, scripts) work in the folder; what they write
comes into the vault by the folder's sync, marked "Changed elsewhere".

**Sessions outlive windows.** A session ends when someone ends it. Ending it ends the agent's
process group; work the agent started to outlive it (a scheduler's job, `setsid`) goes on.
Stopping the server stops the agents; on start, sessions come back as they were, and the next
prompt starts the agent again on its own session id where the agent can resume one.

## What it looks like

For now a served folder has **one list of chats, everyone's**: whoever opens the vault (for now:
you, on your devices) sees every chat in it, follows it as it goes on and prompts it. Private
chats come later (see "Later" below); nothing here assumes there are none.

- **The agent panel** shows the server's chats as it shows chats now: the open ones (running, or
  opened and not ended) are the chats of every window on the vault; the earlier ones are in the
  list of chats. A chat started in one window is open in all of them.
- **Prompts go in turn**, in the order they reach the server, whichever window sent them.
- **Questions from the agent** (allow this command?) show in every window that has the chat; the
  first answer counts. With nobody there, it waits, and the chat is marked as waiting.
- **Working unattended**: "Allow everything in this chat" (in the mode menu) answers its
  questions with "allow"; or the agent's own mode for it (Claude Code's modes, Codex's approval
  levels). It shows in the chat's header while it is on.
- **Closing a window** leaves its chats running. **Closing a chat** (its menu, `/close`) ends its
  agent; the chat stays among the earlier ones, and opening it again continues it.
- **The built-in ChatGPT assistant** runs in the window (it uses the device's sign-in); its chats
  are this device's.

### Later: private chats

Each chat records who started it (`by`) and is the vault's (`visibility` absent: everyone's).
A private chat would be `visibility: 'private'`: the server sends it, its transcript and its
questions only to `by`, and refuses prompts from others. That needs a person to be known across
devices (open question below) more than anything in the wire, which already goes through one
check (`visibleTo(chat, user)`).

## The wire

One WebSocket per window and vault, `/agents?vault=…&token=…`, for members of a served folder:

- from the server: the sessions (list, and changes to it); for a session the window follows, its
  transcript items as they come and its state; questions waiting for an answer;
- from the window: follow / stop following a session; new session (agent); prompt; cancel; answer
  a question; set mode or model; rename; end.

In the app, a server session is an `AgentSession` (the interface the panel already uses), so the
panel shows it as it shows one running here.

## What stays, what goes

- Stays: the ACP client (moved so that the server can run it too), the transcript format, the
  panel, `PUMICE_AGENTS`, the agents allowed.
- Goes: `/proc` (the window running the agent's process through the server): the server runs it.

## Steps

1. The ACP client and the transcript usable by the server too (`@pumice/core-agents/session`,
   `chats`, `ledger`, and the note writing, without the panel).
2. The server keeps sessions: runs agents, answers their file requests through the vault's
   documents, writes `.pumice/chats/`, restores them on start.
3. `/agents` and the app's server sessions in the panel; questions; ending.
4. This device's agents in a shared vault, beside the server's.
5. Tests: a session that goes on with no window, two windows on one session, a question answered
   from the other, a restart of the server, a write merged with typing (and a stale write: below).

## Before it: stale writes

An agent that writes back a whole note it read earlier would undo what people typed since. Its
write is merged against what it read (three versions: what it read, the note now, what it wrote),
in the app and on the server alike. Only a real overlap is a conflict.

## Decided

- A session can allow its agent's commands by itself ("allow everything in this chat"), or by
  the agent's own mode for it.
- Prompts go in turn. For now every chat is the vault's (everyone's); private chats later.
- Where an agent runs is the user's choice (server or device); ChatGPT on devices only.

## Open questions

- **One person, several devices**: each device gets its own generated name on a server, so a chat
  that is "its starter's" belongs to one device, not to a person. To follow you, a device needs
  to be told it is you (for example "this is also me": a code from a device already known), or a
  name has to be chosen once and given to each device.
