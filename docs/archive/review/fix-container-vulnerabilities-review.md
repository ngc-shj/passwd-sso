# Plan Review: fix-container-vulnerabilities

Date: 2026-03-07
Review round: 2

## Changes from Previous Round

Round 1 findings resolved:

- F1 (Major): COPY overlay unreliable → Changed to npm overrides
- S1 (Major): Missing --ignore-scripts on npm install prisma → Added to plan
- F2 (Minor): apk upgrade zlib placement unclear → Clarified: both builder and runner, after WORKDIR

Round 2 findings resolved:

- F3 (Major): Trivy exit-code "1" may block CI for uncontrollable base image CVEs → Added .trivyignore
- F1 (Minor): overrides format inconsistency → Changed to fixed version "7.0.6"

Round 2 findings skipped:

- F2 (Minor): cross-spawn override practically unnecessary → Valid defense-in-depth measure, kept

## Functionality Findings

No findings.

## Security Findings

No findings.

## Testing Findings

No findings.
