// Manual profile persistence is shared by both shells through the v2 store.
// Keep the former module path as a discoverable entry point; legacy v1 is only
// written by the transactional store, never by a silent React persistence effect.
export { loadManualProfileStore, saveManualProfileStore } from "./manualProfileStore";
