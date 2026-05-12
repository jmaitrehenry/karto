# Karto — Agent Guide

Karto is a lightweight macOS desktop app for browsing Kubernetes clusters. It uses a Tauri 2 shell with a React/TypeScript frontend and a Rust backend that talks directly to the Kubernetes API via the `kube` crate.

## Architecture

```
src/          React + TypeScript frontend (single file: App.tsx + styles.css)
src-tauri/    Rust backend
  src/lib.rs  All Kubernetes logic and Tauri command handlers (~1900 lines)
  src/main.rs Entry point — calls lib::run()
```

The frontend communicates with the backend exclusively through Tauri IPC commands (`invoke()`). The Rust side fetches data from Kubernetes and returns serialized structs via `serde`.

## Dev Setup

```bash
npm install
npm run tauri:dev   # starts Vite dev server + Tauri window
```

Production build:
```bash
npm run tauri:build
```

The Vite dev server runs on `http://localhost:1420`. Tauri hot-reloads the frontend automatically; Rust changes require a full restart.

## Key Data Flow

1. Frontend calls `invoke("command_name", { args })` 
2. Tauri routes to a `#[tauri::command]` async fn in `lib.rs`
3. The Rust handler uses the `kube` client to query the cluster
4. Returns a serialized struct (`WorkloadDetails`, `ResourceSummary`, etc.)
5. Frontend renders the result

Core types shared between frontend and backend (must stay in sync):
- `WorkloadDetails` / `PodDetails` / `ServiceDetails` — resource detail views
- `ResourceSummary` — list rows in the namespace browser
- `LogLine` — streaming log entries
- `EventSummary` — Kubernetes events

## Frontend Conventions

- All UI lives in `src/App.tsx` — one large file, not split into components
- Styles in `src/styles.css` using CSS custom properties (`--green`, `--red`, `--yellow`)
- Status colors via `statusTone(status)` → `"good"` / `"warn"` / `"bad"` CSS class
- Icons from `lucide-react`
- TypeScript strict mode is on

## Backend Conventions

- All Kubernetes logic is in `src-tauri/src/lib.rs`
- Each resource kind has a dedicated match arm in `get_workload_details()`
- Shared/generic resources use `generic_details()`, workloads use dedicated functions like `workload_details_from_deployment()`
- Age formatting via `age_for()`, label selectors via `label_selector()`
- Errors surface as `String` via `kube_error()` helper

## No Tests

There are no automated tests. Verify changes by running the app with `npm run tauri:dev` and exercising the affected UI flows manually.
