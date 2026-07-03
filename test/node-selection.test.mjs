// Selection eligibility must survive heartbeats.
//
// Regression guard: the supervisor reports the full version snapshot at `hello`, but a
// heartbeat may carry only the component versions. The registry must MERGE (not replace)
// versions, otherwise the ControlPlane's compatibility gate (which requires
// contracts/protocol/schema minimums) would reject every node after the first heartbeat and
// no run could ever dispatch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../control-plane/control/registry.mjs";
import { createNodeSelection } from "../control-plane/scheduler/node-selection.mjs";
import { versionSnapshot } from "../shared/contracts/versions.mjs";

const config = {
  selection: {
    azure_direct: { required: true, quorum: 1 },
    gsa_remotenet: { required: true, quorum: 1 },
    gsa_client: { required: true, quorum: 1 },
  },
  desiredVersions: versionSnapshot(),
};

// Mirror the supervisor: hello carries the full snapshot; a session must exist for the node
// to count as connected/eligible.
function connect(reg, nodeName, nodeType) {
  reg.attachSession(`${nodeType}:${nodeName}`, { send() {}, close() {} });
  reg.register({ nodeName, nodeType, versions: versionSnapshot({ controlPlaneAgentVersion: "3.0.0", agentVersion: "3.0.0" }) });
}

// A heartbeat as the supervisor sends it before/after the fix does not matter here — we send
// the PARTIAL set (the hard case) and assert the node stays eligible.
function partialHeartbeat(reg, nodeName, nodeType) {
  reg.heartbeat(nodeName, { nodeType, status: "ready", versions: { controlPlaneAgentVersion: "3.0.0", agentVersion: "3.0.0" } });
}

test("all required arms are dispatchable immediately after hello", () => {
  const reg = createRegistry();
  const selection = createNodeSelection({ registry: reg, config });
  connect(reg, "d1", "azure_direct");
  connect(reg, "g1", "gsa_remotenet");
  connect(reg, "c1", "gsa_client");

  const sel = selection.selectForUrl();
  assert.equal(sel.canDispatch, true);
  assert.equal(sel.selected.length, 3);
  assert.deepEqual(sel.unmet, []);
});

test("a partial-version heartbeat does not make nodes ineligible", () => {
  const reg = createRegistry();
  const selection = createNodeSelection({ registry: reg, config });
  connect(reg, "d1", "azure_direct");
  connect(reg, "g1", "gsa_remotenet");
  connect(reg, "c1", "gsa_client");

  partialHeartbeat(reg, "d1", "azure_direct");
  partialHeartbeat(reg, "g1", "gsa_remotenet");
  partialHeartbeat(reg, "c1", "gsa_client");

  const sel = selection.selectForUrl();
  assert.equal(sel.canDispatch, true, "still dispatchable after partial-version heartbeats");
  assert.equal(sel.selected.length, 3);
  assert.deepEqual(sel.unmet, []);

  // The merged record retains the fields the gate checks.
  const merged = reg.get("azure_direct:d1").versions;
  assert.equal(merged.contractsVersion, "3.0.0");
  assert.equal(merged.protocolVersion, "1");
  assert.equal(merged.schemaVersion, "3.0");
});
