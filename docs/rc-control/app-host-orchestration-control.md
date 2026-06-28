# App Host Orchestration Control

## Target

```text
D:\PhpstormProjects\www\App
```

## Purpose

`App` is the host/orchestration control fixture for `console.rc`.

`App` is not the primary repair target for this track. It is a real Symfony host runtime and must not be used as a sandbox. Findings from `App` are used to evolve `console.rc` as a complex RC runner from boundary detection, `AGENTS.md`, markdown/governance reconnaissance, validation execution, semantic failure classification, and RC-readiness reporting.

## Confirmed Control Result

The control test confirmed that `console.rc` is usable as an orchestration runner:

- server-side tool is available;
- ChatGPT callable schema is available in a fresh session;
- `diagnose` mode works;
- `validate` mode works;
- `App` is a valid control target;
- dirty workspace is detected correctly;
- safe validation profile executes composer, AI review, gating, and inspection guards.

## Expected Diagnose

```text
ok: false
readiness.status: rc_diagnostic_blocked
readiness.blockers contains workspace_has_uncommitted_changes
```

## Expected Validate

- safe validation profile executes;
- `workspace_has_uncommitted_changes` remains until the workspace is committed or cleaned;
- validation failures are classification test cases before they are repair targets;
- `App` failures must not automatically trigger broad App repair;
- `console.rc` should classify failures and suspicious greens with actionable categories.

## Recorded Dirty State At Control Test

```text
M config/reference.php
M config/routes/app_host_dashboard.yaml
M config/services.yaml
M src/Service/Dashboard/AppDashboardBuilderService.php
?? migrations/Version20260628182000.php
?? migrations/Version20260628190000.php
?? src/Contract/Ui/AppStoreContract.php
?? src/Dto/Store/
?? src/Service/Store/
?? tests/Unit/VendoringMobileEntityMappingTest.php
```

## Classification Matrix

The following `App` findings are control cases for `console.rc` validation classification:

| Finding | Expected Classification |
| --- | --- |
| `composer validate` exits 0 with Composer warnings | `warning_only` |
| `ai-review:validate` requires `--result` or a missing review artifact | `evidence_required` |
| `gating:check` fails on Symfony autowiring such as `RebacStatsService` `object $store` | `autowiring_failure` |
| `inspect:reference-strict-types` fails on an invalid PHP header | `file_format_failure` |
| `inspect:navigation-ea-route` exits 0 while stdout looks like raw PHP source | `false_green_suspected` |
| unknown command failure without a better match | `runtime_failure` or `configuration_failure` |

## False-Green Requirement

`console.rc` must not trust exit code `0` blindly. If a validation command exits successfully but stdout looks like raw PHP source, the command status must become `false_green_suspected` and readiness must include `validation_suspicious`.

## Evidence-Aware Requirement

AI review validation must not be treated as a generic runtime failure when the review artifact is missing. The runner should classify it as `evidence_required` and report the missing artifact model.

Future RC run artifacts should live under a run directory such as:

```text
var/rc-run/<run-id>/
  diagnostic.json
  validation.json
  ai-review-result.json
  readiness.json
  manifest.json
```

## Development Direction

