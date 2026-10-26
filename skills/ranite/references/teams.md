# Teams and peer machines

Contents: topology, setup, membership, messaging, delivery, files and work records.
Related: [workers](workers.md), [inbox](telegram-inbox.md), [commands](commands.md).

## Topology and setup

A team is a closed group of independent Ranite machines over the intended tailnet,
with one hub and members. A member's live tools/hardware are its own; local workers
do not become peers. Membership settings and the secret team ticket are distinct.
Hub identity/fingerprint is part of connecting to the intended hub.

```text
ranite team init --as <member-name> --name <team-name> --port <port>
ranite team invite --ttl-minutes 10
ranite team join <hub-address> --code <invite-code> --as <member-name> --fingerprint <fingerprint>
ranite team pending
ranite team approve <request-id>
ranite team join-status <hub-address> <request-id>
ranite team status
```

Initialize on the intended hub, create an invite there, join from the member,
review/approve the request on the hub and inspect membership on both. Discover
actual tailnet addresses and listen port; do not infer them from a machine name.
An accepted invitation/request and a healthy runtime connection are separate
states. Tickets are host-managed secret-store data, not material to paste into
memory or skill files.

`invites` and `invite-revoke` inspect/revoke outstanding invites; `deny` rejects a
pending join. `members`, `remove`, `leave`, `rejoin` and `join-status` cover the
remaining membership lifecycle. A removed/left member needs a valid current
relationship rather than continuing to rely on an old cached profile.

## Messaging and delivery

```text
ranite team say <message>
ranite team dm <member> <message>
ranite team inbox
ranite team read --from <member>
ranite team read --group
ranite team history --with <member> --limit 50
ranite team history --group --before <seq> --limit 50
```

Native tools are `team_send`, `team_group`, `team_history`, `team_status` and
`team_delivery`. `team_send` takes text, optional recipient and replyTo; use the
original message id when answering. Direct messages wake their owning session;
group traffic is ambient and does not automatically wake every member.
The unified `inbox` reads source notifications; group reading/acknowledgement
uses the group sequence mechanism.

Outbound intent is durable before network delivery. `queued` is not `delivered`;
`team_delivery` list/read/retry/cancel exposes retained outcomes. Stable message
identities support idempotent retries. Reading consumes the inbox notification and stops its reminders. This is not
agreement acceptance or task completion; send a reply when needed. Historical
messages remain accessible with `team_history`. Avoid replaying an action simply because its acknowledgement was
lost; inspect the retained delivery/work record.

## Status, profile and negotiated work

`team_status` returns peer descriptions and current capability observations.
`team_profile` read/update manages a revisioned self-description. A profile is
not proof that the machine is online or that a particular tool is currently usable.

`team_work` keeps negotiated dependency records. Inputs include `action`, stable
`id`, `peer`, `terms`, `expectedRevision`, optional `note`, pagination and
`includeClosed`. Operations include list/read and the supported work transitions:
propose, counter, accept, reject, start, block, resume, complete, fail, cancel and note.
Read a current record before using its revision. Proposed/countered terms are not
accepted until the other party accepts; a completion report still needs its
underlying result/evidence. A cancellation changes the work relationship, not the
past external effects. Use the exact action schema offered by this host version.

## Files and shared memory

```text
ranite team send-file <member-or-group> <path>
ranite team files
ranite team get <file-id> --to <destination>
```

Tools: `team_send_file` (`path`, `to`), `team_files`, `team_receive_file` (`id`,
optional `to`). Discover actual file id/metadata and destination before receiving.
A stored file reference is not proof a receiving path already exists. File-sharing
operations have their own approval, network and path behavior.

`team_remember` appends to `decisions` or `shared`. The local
`MEMORY/team/<team-key>/` files are hub-derived mirrors; editing them directly is
not a shared-memory write. Local `MEMORY/self/peers/` observations are not team-wide
facts. Team history, local session history and memory are different stores.

## Verification and diagnosis

Inspect hub/member status, identity/fingerprint, accepted membership, current
capability age, direct-message delivery receipts and source inbox state. For
offline peers, pending deliveries can be durable without being received. Inspect
TLS/route/port and current ticket state after identity or membership changes.
`team log` is operational evidence; a cached member list is not a connectivity
test. All team CLI forms are in the [command index](commands.md).
