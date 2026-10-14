# tiny-access-grant

Lifecycle-bound access grants for registered AI agents, in one TypeScript file.
Agents are registered with an owner and a role. Grants are per system, carry scopes and a reason, can be time-boxed, and can never go above the role's ceiling.
Every action is checked. A role change trims access. Ending an agent revokes every live grant in the same step. Everything lands in an audit log.
Everything runs in memory with a fake clock. No API key. No network.

## Why it matters

On October 13, 2026, Workday [announced](https://newsroom.workday.com/2026-10-13-Workday-to-Acquire-C1-ai,-a-Leading-Agentic-Identity-Platform-for-People-and-Agents) a definitive agreement to acquire C1.ai, an agentic identity platform for people and agents. In Workday's words, "once registered, an agent can receive the access it needs, when it needs it, and lose that access immediately when its work or role ends." The deal is expected to close in Workday's fiscal Q4 2027, subject to closing conditions.
This is a small model of that idea. It is not how Workday or C1.ai work inside.

## Run it

You need Node.js 18 or newer.

```bash
npm install
npx tsx access-grant.ts
```

## What the demo shows

- Grants above a role's ceiling are rejected.
- Checks deny unknown agents, missing grants, missing scopes, expired grants and revoked grants, each with a specific reason.
- A role change revokes finance access on the spot.
- Ending an agent revokes everything. A "ticket world" store, where only the record is updated, still lets the email app allow send.

## Example output

See `output.txt`. Every agent, role, system, scope and time is an example input.

## License

MIT
