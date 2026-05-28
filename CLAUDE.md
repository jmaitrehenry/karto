# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Karto Is

A cross-platform desktop Kubernetes browser (macOS, Linux, Windows) built with Tauri 2, React 19 / TypeScript (frontend), and Rust (backend). It reads existing kubeconfig contexts and lets users browse namespaces, inspect workloads, stream logs, review events, exec into containers, port-forward, and view raw YAML. It does **not** create, edit, or delete Kubernetes resources.

## Commands

```bash
npm install           # install JS dependencies
npm run tauri:dev     # start Vite dev server (port 1420) + Tauri window
npm run tauri:build   # production build

cargo fmt             # format Rust (run from src-tauri/)
cargo clippy          # lint Rust
```

The Vite dev server must be running on `http://localhost:1420` before Tauri opens its window — `tauri dev` handles this automatically via `beforeDevCommand`. Frontend changes hot-reload; Rust changes require a full restart of `tauri dev`.

## Architecture

```
src/
  App.tsx       All React UI (~3 300 lines, single file — do not split)
  styles.css    All styles, CSS custom properties for colors
src-tauri/
  src/lib.rs    All Kubernetes logic + every Tauri command handler (~2 900 lines)
  src/main.rs   Entry point — calls lib::run()
  tauri.conf.json
```

### Communication model

The frontend calls `invoke("command_name", { camelCaseArgs })` from `@tauri-apps/api/core`. The Rust side exposes `#[tauri::command]` async functions in `lib.rs` and returns serialized structs via `serde`. Streaming (logs, exec output) uses Tauri events emitted with `app_handle.emit()` and received in the frontend with `listen()`.

### Types shared between frontend and backend (must stay in sync)

| Rust struct | TypeScript type | Used for |
|---|---|---|
| `ResourceSummary` | `ResourceSummary` | namespace resource list rows |
| `WorkloadDetails` | `WorkloadDetails` | detail panel (workloads, services, nodes) |
| `PodDetails` | `PodDetails` | pod rows inside a workload detail |
| `ServiceDetails` | `ServiceDetails` | service rows inside a workload detail |
| `LogLine` | `LogLine` | streamed log entries |
| `EventSummary` | `EventSummary` | Kubernetes events |
| `CrdGroup` / `CrdResource` | `CrdGroup` / `CrdResource` | CRD browser |
| `CustomResourceTable` | `CustomResourceTable` | dynamic CRD list view |
| `PortForwardInfo` | `PortForwardInfo` | active port-forward tracker |
| `ExecSessionInfo` (frontend-only) | — | active exec sessions |

### Frontend conventions

- **Single file** — all UI lives in `src/App.tsx`. Do not extract components into separate files.
- Status colours via `statusTone(status)` → CSS class `"good"` / `"warn"` / `"bad"`.
- Theme: `ThemeMode = "light" | "dark"`, stored in `localStorage`, applied as `data-theme` on `<html>`.
- `LoadState<T>` wrapper (`{ loading, data, error }`) used for every async fetch.
- Icons from `lucide-react` only.
- Resource view modes: `"applications"` | `"all"` | `"nodes"` (state: `resourceView`).
- Detail tabs: `DetailTab = "overview" | "logs" | "events" | "yaml" | "exec"` (state: `activeDetailTab`).

### Backend conventions

- All Kubernetes logic is in `src-tauri/src/lib.rs` — do not split into modules.
- `client_for_context(context)` builds a `kube::Client` from the named kubeconfig context. The `hydrate_login_shell_environment()` helper runs a login shell to pick up PATH / kubeconfig env vars before connecting.
- `get_workload_details()` dispatches on `kind` with a match arm per resource type; new resource kinds need a new arm.
- Workload-specific helpers: `workload_details_from_deployment()`, `workload_details_from_stateful_set()`, `workload_details_from_daemon_set()`.
- Generic / non-workload resources use `generic_details()`.
- `age_for(timestamp)` formats a `DateTime` into a human-readable age string.
- `label_selector(labels)` builds a `ListParams` label selector string.
- Errors are surfaced as `Result<T, String>` — use `kube_error()` to convert `kube::Error`.
- State managed via Tauri `State<'_>`: `LogStreams` (active log stream handles), `PortForwards`, `ExecSessions`.

## No Automated Tests

There are no tests. Verify changes by running `npm run tauri:dev` and exercising the affected flows manually.
