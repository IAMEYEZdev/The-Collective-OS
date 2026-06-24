# ACE-Step 1.5 Split Architecture Setup

## Goal

Set up Jason's Windows 11 machine to run `ace-step-ui` locally while ACE-Step 1.5 inference runs on a rented CUDA cloud GPU.

## Scope

- Do not install CUDA or run inference on Jason's Intel UHD machine.
- Install `fspecii/ace-step-ui` dependencies locally.
- Prepare local start/stop wrappers for UI and cloud control.
- Prepare cloud install/start/stop scripts for ACE-Step 1.5 API.
- Choose a GPU provider based on current public pricing.
- Verify local builds and document what cannot be verified without cloud credentials.

## Provider Decision

Use Vast.ai first when an RTX 3090 or better instance is available under the target price band, because public current pricing shows RTX 3090 availability around `$0.13/hr`, lower than RunPod's published RTX 3090 rate.

## Verification Checklist

- `ace-step-ui` cloned locally.
- Frontend and server dependencies installed.
- Local scripts exist.
- Cloud scripts exist.
- Frontend build passes.
- Server TypeScript build passes.
- End-to-end music generation remains blocked until a paid GPU instance and network details are available.

