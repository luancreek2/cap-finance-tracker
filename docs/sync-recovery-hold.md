# Temporary Phase 6O recovery hold

This deployment defaults every owner/device to HELD. Absence of the localStorage
key `cap-sync-recovery-phase6o-v1` means held; no financial-store migration or
initialization is needed. The only accepted release value is the exact object
`{"version":1,"owner":"<authenticated owner UUID>","state":"released"}`.
Malformed values, other owners and storage read failures remain held. Clearing
site storage re-establishes the hold. The key is not financial backup data.

Developer Options remains OFF by default. The user must deliberately enable it,
choose **Resume Held Cloud Sync**, accept the queued-operation confirmation and
pass read-only authentication before a verified release is stored. This neither
enables Cloud Sync nor bypasses planner/CAS checks. With sync already ON, it
schedules normal execution. Cancellation leaves all storage unchanged.

Boot, online, pageshow, visibility, worker messages and the visible 15-second
timer all use the gated request path. Engine execution and the direct browser
transport also check the hold. Compare-and-commit guards prevent financial
state/queue/baseline advancement while held. A held operation is not discarded.
An RPC already dispatched before a hold cannot be recalled; if a hold activates
before acknowledgement, its journal/queue are retained for reviewed receipt replay.

After explicit release, normal automatic sync continues across restarts without
per-operation approval. Do not remove the marker to retire the gate: absence is
intentionally fail-closed. Keep the gate until the affected device's queue and
journal have been verified converged and recovery is explicitly closed. A later,
separately reviewed release can then remove the gate checks/UI and bump the shell
version; leave old markers inert. Removing it earlier could resume held devices.
No deployment itself should delete or auto-release markers.
