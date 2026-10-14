// tiny-access-grant: lifecycle-bound access for registered AI agents.
// A small model of the idea. Not how Workday or C1.ai work inside.
// Agents, roles, systems, scopes and times are example inputs. No network. No API key.

type System = "email" | "crm" | "repo" | "finance" | "cloud";
type Status = "active" | "ended";

interface Agent {
  id: string;
  owner: string; // the person accountable for this agent
  role: string;
  status: Status;
}

interface Grant {
  agentId: string;
  system: System;
  scopes: string[];
  reason: string;
  grantedAt: number; // minutes since midnight on a fake clock
  expiresAt?: number;
  revokedAt?: number;
  revokeReason?: string;
}

interface Decision {
  allow: boolean;
  reason: string;
}

interface AuditEvent {
  at: string;
  kind: "register" | "grant" | "reject" | "check" | "revoke" | "role" | "end";
  agentId: string;
  detail: string;
}

// The most each role may hold. A grant can be smaller, never bigger.
const ROLE_CEILING: Record<string, Partial<Record<System, string[]>>> = {
  "sales-assistant": { email: ["read", "send"], crm: ["read", "update"] },
  "revops-analyst": { crm: ["read"], finance: ["read"] },
  "support-triage": { email: ["read"], crm: ["read"] },
};

const hhmm = (t: number) =>
  `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;

// Step 1: the agent system of record
interface Store {
  now: number;
  agents: Map<string, Agent>;
  grants: Grant[];
  audit: AuditEvent[];
}

function newStore(start = 9 * 60): Store {
  return { now: start, agents: new Map(), grants: [], audit: [] };
}

function log(s: Store, kind: AuditEvent["kind"], agentId: string, detail: string): void {
  s.audit.push({ at: hhmm(s.now), kind, agentId, detail });
}

function register(s: Store, id: string, owner: string, role: string): Agent {
  if (s.agents.has(id)) throw new Error(`${id} is already registered`);
  if (!ROLE_CEILING[role]) throw new Error(`unknown role ${role}`);
  const agent: Agent = { id, owner, role, status: "active" };
  s.agents.set(id, agent);
  log(s, "register", id, `owner=${owner} role=${role}`);
  return agent;
}

// Step 2: grants that live inside the role
function isLive(g: Grant, now: number): boolean {
  return g.revokedAt === undefined && (g.expiresAt === undefined || now < g.expiresAt);
}

function grant(
  s: Store,
  agentId: string,
  system: System,
  scopes: string[],
  reason: string,
  ttlMinutes?: number,
): Grant | undefined {
  const agent = s.agents.get(agentId);
  const ceiling = agent ? ROLE_CEILING[agent.role][system] ?? [] : [];
  const extra = scopes.filter((x) => !ceiling.includes(x));
  const why = !agent
    ? "not registered"
    : agent.status !== "active"
      ? "agent has ended"
      : !reason.trim()
        ? "no reason given"
        : extra.length
          ? `${system}.${extra.join(",")} is above role ${agent.role}`
          : "";
  if (why) {
    log(s, "reject", agentId, `${system} [${scopes}]: ${why}`);
    return undefined;
  }
  for (const old of s.grants) {
    if (old.agentId === agentId && old.system === system && isLive(old, s.now)) {
      revoke(s, old, "replaced by a new grant");
    }
  }
  const g: Grant = {
    agentId, system, scopes, reason, grantedAt: s.now,
    expiresAt: ttlMinutes === undefined ? undefined : s.now + ttlMinutes,
  };
  s.grants.push(g);
  const until = g.expiresAt === undefined ? "" : ` until ${hhmm(g.expiresAt)}`;
  log(s, "grant", agentId, `${system} [${scopes}]${until}: ${reason}`);
  return g;
}

function revoke(s: Store, g: Grant, why: string): void {
  g.revokedAt = s.now;
  g.revokeReason = why;
  log(s, "revoke", g.agentId, `${g.system}: ${why}`);
}

// Step 3: check on every action
function checkAccess(s: Store, agentId: string, system: System, action: string): Decision {
  const d = decide(s, agentId, system, action);
  log(s, "check", agentId, `${system}.${action} ${d.allow ? "ALLOW" : "DENY"}: ${d.reason}`);
  return d;
}

function decide(s: Store, agentId: string, system: System, action: string): Decision {
  const agent = s.agents.get(agentId);
  if (!agent) return { allow: false, reason: "not in the system of record" };
  if (agent.status !== "active") return { allow: false, reason: `agent ${agent.status}` };
  const mine = s.grants.filter((g) => g.agentId === agentId && g.system === system);
  const live = mine.find((g) => isLive(g, s.now));
  if (!live) {
    const last = mine.at(-1);
    if (!last) return { allow: false, reason: `no ${system} grant` };
    if (last.revokedAt !== undefined) {
      return { allow: false, reason: `revoked ${hhmm(last.revokedAt)}, ${last.revokeReason}` };
    }
    return { allow: false, reason: `expired ${hhmm(last.expiresAt!)}` };
  }
  if (!live.scopes.includes(action)) {
    return { allow: false, reason: `scope ${action} not in [${live.scopes}]` };
  }
  return { allow: true, reason: live.reason };
}

// Step 4: lifecycle events move access
function changeRole(s: Store, agentId: string, role: string): void {
  const agent = s.agents.get(agentId);
  if (!agent || agent.status !== "active") throw new Error(`${agentId} is not active`);
  if (!ROLE_CEILING[role]) throw new Error(`unknown role ${role}`);
  log(s, "role", agentId, `${agent.role} -> ${role}`);
  agent.role = role;
  for (const g of s.grants) {
    if (g.agentId !== agentId || !isLive(g, s.now)) continue;
    const ceiling = ROLE_CEILING[role][g.system] ?? [];
    const keep = g.scopes.filter((x) => ceiling.includes(x));
    if (keep.length === g.scopes.length) continue;
    revoke(s, g, `role changed to ${role}`);
    if (keep.length) grant(s, agentId, g.system, keep, `${g.reason} (trimmed for ${role})`, remaining(g, s.now));
  }
}

function remaining(g: Grant, now: number): number | undefined {
  return g.expiresAt === undefined ? undefined : g.expiresAt - now;
}

function endAgent(s: Store, agentId: string, why: string): void {
  const agent = s.agents.get(agentId);
  if (!agent || agent.status === "ended") return;
  agent.status = "ended";
  log(s, "end", agentId, why);
  for (const g of s.grants) {
    if (g.agentId === agentId && isLive(g, s.now)) revoke(s, g, `agent ended: ${why}`);
  }
}

// Step 5: the ticket version, and who has access right now
// The downstream app only sees grants. It never asks the system of record.
function appSees(s: Store, agentId: string, system: System, action: string): boolean {
  return s.grants.some(
    (g) => g.agentId === agentId && g.system === system && isLive(g, s.now) && g.scopes.includes(action),
  );
}

// Ticket world: the agent is marked ended, but nobody files the access ticket.
function endInRecordOnly(s: Store, agentId: string, why: string): void {
  const agent = s.agents.get(agentId);
  if (agent) agent.status = "ended";
  log(s, "end", agentId, `${why} (grants untouched)`);
}

function whoHasAccess(s: Store): string[] {
  return s.grants
    .filter((g) => isLive(g, s.now))
    .map((g) => {
      const a = s.agents.get(g.agentId)!;
      const until = g.expiresAt === undefined ? "" : ` until ${hhmm(g.expiresAt)}`;
      return `${g.agentId} (${a.status}, owner ${a.owner}) ${g.system} [${g.scopes}]${until}: ${g.reason}`;
    });
}

// Step 6: run it
function show(s: Store, agentId: string, system: System, action: string): void {
  const d = checkAccess(s, agentId, system, action);
  const verdict = d.allow ? "ALLOW" : "DENY ";
  console.log(`${hhmm(s.now)}  ${verdict}  ${agentId.padEnd(12)} ${`${system}.${action}`.padEnd(14)} ${d.reason}`);
}

function at(s: Store, t: string): void {
  const [h, m] = t.split(":").map(Number);
  s.now = h * 60 + m;
}

const s = newStore();
console.log("== register and grant ==");
register(s, "pipeline-bot", "maya", "sales-assistant");
grant(s, "pipeline-bot", "email", ["read", "send"], "draft Q4 pipeline follow-ups");
grant(s, "pipeline-bot", "crm", ["read", "update"], "log calls from follow-ups", 120);
grant(s, "pipeline-bot", "finance", ["read"], "check deal discounts");
grant(s, "pipeline-bot", "crm", ["read", "delete"], "clean up duplicates");
for (const e of s.audit.filter((e) => e.kind === "grant" || e.kind === "reject")) {
  console.log(`${e.at}  ${e.kind.padEnd(6)} ${e.detail}`);
}

console.log("\n== check on every action ==");
at(s, "09:05");
show(s, "pipeline-bot", "email", "send");
show(s, "pipeline-bot", "crm", "update");
show(s, "pipeline-bot", "crm", "delete");
show(s, "pipeline-bot", "finance", "read");
show(s, "ghost-bot", "email", "read");

console.log("\n== role change ==");
at(s, "09:10");
register(s, "close-helper", "dev", "revops-analyst");
grant(s, "close-helper", "crm", ["read"], "match invoices to deals");
grant(s, "close-helper", "finance", ["read"], "month-end invoice exceptions", 240);
at(s, "09:40");
show(s, "close-helper", "finance", "read");
at(s, "09:45");
changeRole(s, "close-helper", "support-triage");
show(s, "close-helper", "finance", "read");
show(s, "close-helper", "crm", "read");

console.log("\n== time-boxed grant ==");
at(s, "11:05");
show(s, "pipeline-bot", "crm", "update");
show(s, "pipeline-bot", "email", "send");

console.log("\n== end the agent ==");
at(s, "11:30");
endAgent(s, "pipeline-bot", "Q4 follow-up project closed");
show(s, "pipeline-bot", "email", "send");
show(s, "pipeline-bot", "email", "read");
grant(s, "pipeline-bot", "email", ["read"], "one more thing");
const last = s.audit.at(-1)!;
console.log(`${last.at}  ${last.kind.padEnd(6)} ${last.detail}`);

console.log("\n== same ending, ticket world ==");
const t = newStore(11 * 60 + 30);
register(t, "pipeline-bot", "maya", "sales-assistant");
grant(t, "pipeline-bot", "email", ["read", "send"], "draft Q4 pipeline follow-ups");
endInRecordOnly(t, "pipeline-bot", "Q4 follow-up project closed");
console.log(`ticket world:    record says ended, email app allows send? ${appSees(t, "pipeline-bot", "email", "send")}`);
console.log(`lifecycle world: record says ended, email app allows send? ${appSees(s, "pipeline-bot", "email", "send")}`);

console.log("\n== who has access at 11:30 ==");
for (const line of whoHasAccess(s)) console.log(line);

console.log("\n== audit ==");
const counts: Record<string, number> = {};
for (const e of s.audit) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
console.log(Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", "));
for (const e of s.audit.filter((e) => e.agentId === "pipeline-bot" && (e.kind === "end" || e.kind === "revoke"))) {
  console.log(`${e.at}  ${e.kind.padEnd(6)} ${e.detail}`);
}
