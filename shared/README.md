# shared

Protocol and contracts shared by the ControlPlane, ControlPlane Agent, and Agent.
Keep everything here **dependency-free** so all components validate the same vocabulary.

## Contents

| Module | Purpose |
| --- | --- |
| `protocol/control-channel.mjs` | Single-port control-channel message envelope + up/down message types. |
| `contracts/commands.mjs` | Control verbs pushed downstream (dispatch_job, update_agent, reboot, restart_worker, drain, …). |
| `contracts/nodes.mjs` | Node types, node statuses, identity helpers. |
| `contracts/events.mjs` | Event-type vocabulary for the append-only event log. |
| `contracts/versions.mjs` | Version schema + comparison helpers for compatibility + update decisions. |

## Design rule

The **control channel is bidirectional over one connection**:

- **down** (ControlPlane → ControlPlane Agent): commands, config, update offers.
- **up** (ControlPlane Agent → ControlPlane): hello, heartbeat, status, results, telemetry, command results.

Every message is a self-describing envelope (see `protocol/control-channel.mjs`) so the
same transport carries jobs, management commands, and telemetry without extra ports.
