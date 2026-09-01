# ADR 0015: Landmark camera gesture control

- **Status:** Accepted for the bounded browser preview
- **Date:** 2026-08-31
- **Decision owners:** PS3D project owner and implementation agent

## Context

The earlier experimental camera controller inferred a hand from skin colour,
foreground subtraction, connected components, radial silhouette peaks, and an
enclosed-loop heuristic. It could pass synthetic fixtures but could not
reliably distinguish fingers from a face, clothing, furniture, or high-contrast
office lighting. Blur changed only the preview and could not improve that
detector. Tuning more colour thresholds would preserve the wrong abstraction:
CAD gestures require anatomical keypoints, identity continuity, explicit
confidence, and temporal state.

The user also requires all camera processing to remain on-device, to work in a
normal browser, and to fail without CAD motion when the hand is missing or
ambiguous.

## Decision

PS3D uses MediaPipe Hand Landmarker as a replaceable perception adapter and
keeps all CAD interaction semantics project-owned.

1. The browser asks for camera permission only after an explicit user action.
   Audio is never requested.
2. A dedicated module Worker owns the Hand Landmarker instance. Raw
   `ImageBitmap` frames are transferred to that worker, mirrored to match the
   visible preview, processed, and closed immediately.
3. Only one frame may be in flight. `requestVideoFrameCallback` supplies camera
   timestamps and excess frames are skipped instead of creating an inference
   queue. MediaPipe's synchronous `detectForVideo` therefore cannot block the
   UI thread.
4. The worker returns only 21 normalized landmarks, optional world landmarks,
   handedness, confidence, frame identity, dimensions, and inference time. It
   never returns or stores an image.
5. The main thread validates exact landmark count and finite coordinates,
   applies scale-aware jump rejection and a One Euro filter, then derives palm
   centre/width, joint-angle finger extension, open-palm confidence, and a
   thumb-to-index pinch ratio.
6. A deterministic state machine requires seven stable open-right-palm frames
   to acquire control. Right identity is accepted from a confidence-gated
   model label unless the signed wrist-index-MCP-pinky-MCP palm chirality in
   the mirrored image provides clear contradictory evidence. In mirrored
   selfie coordinates a palm-facing right hand produces the negative signed
   area (thumb on the display-right side); this sign convention is covered by
   an explicit production-shaped fixture. A contradiction
   becomes `unknown` and fails closed; an edge-on or foreshortened palm may
   produce ambiguous chirality without erasing a valid model identity. Two
   consecutive pinch frames engage orbit, two release frames stop it, and
   twelve missing/invalid frames lose the lock. A left hand, conflicting
   identity, low confidence, malformed points, or a discontinuous detection
   cannot move CAD.
7. Index position is cursor-only. Orbit is relative movement of the held
   thumb-index pinch point. Because both preview and inference are mirrored,
   both screen axes are inverted at the CAD boundary so the model follows the
   user's hand as direct manipulation. A 4x gain is bounded by per-frame clamps
   and the existing dead zone. Assembly explosion requires a locked open right
   palm and maps calibrated palm width to a maximum per-component travel of 50%
   of the assembled scene's largest dimension. Loss of evidence freezes motion
   and commits no hidden change.
8. Stopping, closing, runtime failure, timeout, or frame-transfer failure
   terminates tracks, terminates the worker, clears landmarks and filters, and
   hides the cursor.

## Supply-chain and hosting boundary

- `@mediapipe/tasks-vision` is pinned to `1.0.1` and inventoried with npm
  SHA-512 integrity and Apache-2.0 notice requirements.
- The full-float16 Hand Landmarker model version 1 is fetched only by the
  preparation script and accepted only at SHA-256
  `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`.
- The ES-module loader and WASM are accepted only at SHA-256
  `da8934057f147b622e82cfb4c0dbd85461c598e268588b5a8ba9ca963a8ff82d`
  and `2dabd8e23c60984628beb7bb338764c81a08e6837145273f59578684b5d53c1b`.
- Runtime requests are same-origin under `/mediapipe/`; the generated manifest
  states `networkAtRuntime: false`. Vercel marks the assets immutable and
  same-origin protected.
- Development does not expose the cached runtime as Vite `publicDir`. The
  MediaPipe loader is dynamically imported as an ES module, which Vite correctly
  rejects when it originates from `publicDir`. An exact-route, read-only
  development middleware serves only the reviewed manifest, model, loader, and
  WASM paths. Production copies that same four-file allowlist into `dist` during
  bundle completion, where the existing production verifier rechecks identity.
- CSP permits `wasm-unsafe-eval` only because the reviewed MediaPipe loader
  compiles the exact same-origin WASM. General `unsafe-eval`, `eval`,
  `new Function`, embedded WASM, additional `.wasm`/`.task` files, Manifold,
  and Node MCP packages remain build failures.

## Privacy and personal reference images

The user's supplied camera photographs were used only to understand the
failure conditions and requested gesture vocabulary. They are not copied into
the repository, uploaded, labelled as a training set, used for biometric
identity, or used to fine-tune the model. PS3D recognizes a current hand pose;
it does not recognize or authenticate a person.

## Verification

Deterministic tests cover mirrored thumb-on-display-right acquisition,
true-left rejection, model-versus-anatomy handedness disagreement, fist rejection, mirrored 4x
orbit mapping, pinch hysteresis, landmark validation, temporal smoothing,
discontinuous-jump rejection, and fail-closed confidence behavior. The production gate verifies
the exact worker identity, runtime/model hashes, manifest, file allowlist,
license notice, CSP, permissions policy, and immutable same-origin headers.

A live-camera smoke test remains hardware-dependent. Automated and synthetic
tests cannot prove accuracy for every webcam, lighting condition, occlusion,
skin tone, hand size, mobility profile, or browser/GPU combination. Camera
control remains an optional input method; mouse, touch, and keyboard controls
remain authoritative fallbacks.

## Consequences

The download is larger by roughly 20 MB, first model load can take several
seconds, and browsers without required Worker, ImageBitmap, OffscreenCanvas,
or WebAssembly support stop safely. Accuracy is materially better than the
silhouette experiment, but it is still probabilistic and cannot be described
as perfect or safety-critical.
