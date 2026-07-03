// Bundle registry (ControlPlane side).
//
// Holds IMMUTABLE, versioned component bundles (worker Agent + ControlPlane Agent). A
// bundle is content-addressed (SHA-256) and optionally signed. Bundles are produced by
// deploy/scripts/build-bundle.mjs as new versions are developed, then registered here so
// the ControlPlane can push them centrally.
//
// Served over the DATA plane: GET /agent/updates/<version>/bundle
//
// Signature verification (ed25519) is enforced at publish and again before apply (see
// shared/protocol/bundle-signing.mjs). TODO: back this with the durable state store + on-disk
// bundle files.

import { COMPONENT_VERSION_FIELDS } from "../../shared/contracts/versions.mjs";
import { makeDataRef } from "../../shared/protocol/data-plane.mjs";

const COMPONENTS = Object.freeze(["agent", "control-plane-agent"]);

export function createBundleRegistry({ baseUrl = "", store = null } = {}) {
  const bundles = new Map(); // key: `${component}@${version}`

  function key(component, version) {
    return `${component}@${version}`;
  }

  return {
    /** Register a freshly built, immutable bundle. */
    register({ component, version, sha256, sizeBytes, signature = null, releaseNotes = "" }) {
      if (!COMPONENTS.includes(component)) throw new Error(`unknown component: ${component}`);
      if (!version) throw new Error("version is required");
      if (!sha256) throw new Error("sha256 is required (bundles are content-addressed)");
      const k = key(component, version);
      if (bundles.has(k)) throw new Error(`bundle already registered (immutable): ${k}`);
      const record = {
        component,
        version,
        sha256,
        sizeBytes: Number(sizeBytes || 0),
        signature,
        releaseNotes,
        // Relative so any host can prefix with the ControlPlane URL it already knows.
        downloadUrl: `/agent/updates/${component}/${version}/bundle`,
        registeredAt: new Date().toISOString(),
      };
      bundles.set(k, record);
      // TODO: persist via store
      return record;
    },

    get(component, version) {
      return bundles.get(key(component, version)) || null;
    },

    list(component = null) {
      const all = [...bundles.values()];
      return component ? all.filter((b) => b.component === component) : all;
    },

    /** Build a data-plane reference for a registered bundle (carried on the control channel). */
    dataRef(component, version) {
      const b = this.get(component, version);
      if (!b) throw new Error(`bundle not found: ${component}@${version}`);
      return makeDataRef({
        kind: "update_bundle",
        url: b.downloadUrl,
        sha256: b.sha256,
        sizeBytes: b.sizeBytes,
        signature: b.signature || null,
      });
    },
  };
}

export { COMPONENTS, COMPONENT_VERSION_FIELDS };
