# Choreis Lab 0.1 — Tracking research prototype

## Scope
Standalone HTML research page at `choreis-lab/index.html`. No dependency on reception, management, Firebase, Luxnora, or production count data. Not a production deployment.

## Running
Serve this directory using an approved HTTPS static hosting environment. Safari camera access requires a secure context and explicit permission. Select an engine source and processing resolution, confirm the empty-room/permission condition, and start.
- Remote trial: imports the AlvaAR distribution pinned to upstream commit `7796af500ee92001ac2a9888363ff64d7a3bee75` via jsDelivr. Do not bypass school access restrictions.
- Same-origin trial: requires a separately reviewed `vendor/alva_ar.js` with the same API and a compliant source/license distribution. It is **not included**. The displayed version metadata currently assumes the pinned upstream revision; only use that exact revision for this comparison.
- AlvaAR upstream: https://github.com/alanross/AlvaAR/tree/7796af500ee92001ac2a9888363ff64d7a3bee75 (GPL-3.0). Before distributing a combined implementation, review licensing, corresponding source and notices for AlvaAR and its dependencies. No upstream binaries are committed here.

## Measurement
- Frame processing time includes image extraction, pose estimation and feature retrieval, not total rendering or GPU/CPU utilization.
- Update frequency is the recent observed processing frequency, not the camera's requested frame rate.
- Pose availability is the fraction of attempted frames with finite 4×4 poses, not accuracy or calibrated confidence.
- X–Z trajectory uses relative, arbitrary-scale coordinates; it is not a gravity-aligned floor plan. A new segment starts following an unavailable pose. Only the latest continuous segment is shown.
- Logs are explicitly exported JSON, contain numeric pose matrices and timings, no camera pixels. Pose/trajectory still constitute sensitive room information; keep them in approved storage.
- No video upload, recording or automatic persistence is implemented by the Lab wrapper. Review the pinned third-party code and inspect network traffic before actual school use. Stop on page hide, visibility loss, consent withdrawal, camera termination or a processing error.

## Initial acceptance checklist (not yet run on iPad)
1. CR-001: approved HTTPS, camera permission/denial, successful engine load, first genuine pose.
2. CR-002: repeat translation/rotation in an empty room; check relative trajectory and tracking interruptions.
3. CR-003: determine metric scale separately using a measured baseline; do not claim cm accuracy before this.
4. CR-004: compare normal light, dim light, and backlight using identical movement and resolution.
5. CR-005: return to a physical reference position, compare drift within a continuous tracking segment.
6. CR-006: deliberately lose tracking, verify no fabricated position and segment separation on recovery.
7. CR-007: run 10 minutes; inspect update frequency, stability, heat and interruptions.
8. CR-008: persistent-map save/relocalization is not implemented in 0.1; mark unsupported.
9. Stop, switch tabs, deny permission, disconnect network; check camera release and failure reporting.
10. Verify no video or image transfer in browser network logs and export only numeric measurements.

## Next
After initial device testing, add repeatable benchmark inputs, reviewed same-origin engine packaging, error/ground-truth measurement, and a swappable engine interface. Do not connect this experimental code to the event counter until isolation and performance are verified.
