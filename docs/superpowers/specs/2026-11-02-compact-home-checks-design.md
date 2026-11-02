# Compact Home checks

Approved in chat: implement the first stage of targeted UI improvements.

## Intent
Keep the current Home composition, accent colors and traffic visualization. Make connection checks take less space and remove redundant connected labels.

## Scope and approach
- Keep the existing layout rather than adopting either proposed redesign.
- Android: move the existing ProfileProbeCard inside the connection hero. Present its result and check/cancel control in a compact row without a separate card background.
- Desktop: keep ConnectionStatus in the hero; show the retry icon with an accessible name when a timestamp already provides context.
- Remove the decorative active/live badge next to the main heading on both platforms. Hide the redundant desktop core-running fallback when no accepted server name is available.
- Retain accepted server names, historical check results and their times, pending state, cancellation, failure explanations and recovery actions.
- Preserve all check scheduling, connection/selection handlers and native code. No dependencies, version bump, release or installation.

## Acceptance
The Android check belongs to the connect hero; a normal completed check fits within 64 px at standard phone widths. Long text and 200% zoom wrap without clipping. Manual checking never starts/stops a VPN; cancellation remains available. Stale results and failures keep their existing meaning. Runtime errors remain actionable. The graph and theme settings remain available.
