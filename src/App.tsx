import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Cloud,
  Database,
  Folder,
  List,
  Layers3,
  Loader2,
  Moon,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Sun,
  TerminalSquare,
  TriangleAlert
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type ClusterContext = {
  name: string;
  current: boolean;
};

type NamespaceSummary = {
  name: string;
  status: string;
};

type ResourceSummary = {
  name: string;
  kind: string;
  namespace?: string;
  ready?: string;
  status: string;
  age?: string;
};

type CrdResource = {
  group: string;
  version: string;
  kind: string;
  plural: string;
  scope: string;
  printer_columns: PrinterColumn[];
};

type PrinterColumn = {
  name: string;
  json_path: string;
  priority?: number;
};

type CrdGroup = {
  group: string;
  resources: CrdResource[];
};

type CustomResourceTable = {
  title: string;
  count: number;
  columns: string[];
  rows: string[][];
};

type KeyValue = {
  key: string;
  value: string;
};

type ConfigWarning = {
  container: string;
  message: string;
};

type PodDetails = {
  name: string;
  age?: string;
  containers: string;
  restarts: number;
  status: string;
};

type ServiceDetails = {
  name: string;
  service_type: string;
  ports: string[];
};

type WorkloadDetails = {
  name: string;
  kind: string;
  namespace: string;
  age?: string;
  ready?: string;
  status: string;
  images: string[];
  resource_totals: {
    cpu_requested: string;
    cpu_limited: string;
    memory_requested: string;
    memory_limited: string;
  };
  labels: KeyValue[];
  annotations: KeyValue[];
  pods: PodDetails[];
  services: ServiceDetails[];
  config_warnings: ConfigWarning[];
};

type LogLine = {
  stream_id: string;
  pod: string;
  container: string;
  line: string;
};

type EventSummary = {
  event_type: string;
  reason: string;
  message: string;
  count: number;
  source: string;
  last_seen: string;
};

type DetailTab = "overview" | "logs" | "events" | "yaml";
type ThemeMode = "light" | "dark";

const themeStorageKey = "karto-theme";

type LoadState<T> =
  | { status: "idle"; data: T }
  | { status: "loading"; data: T }
  | { status: "error"; data: T; message: string };

const emptyResources: ResourceSummary[] = [];
const emptyCustomResources: CustomResourceTable = {
  title: "",
  count: 0,
  columns: [],
  rows: []
};

export function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "dark";

    const savedTheme = window.localStorage.getItem(themeStorageKey);

    if (savedTheme === "light" || savedTheme === "dark") {
      return savedTheme;
    }

    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });
  const [contexts, setContexts] = useState<LoadState<ClusterContext[]>>({
    status: "loading",
    data: []
  });
  const [selectedContext, setSelectedContext] = useState("");
  const [connection, setConnection] = useState<LoadState<null>>({
    status: "idle",
    data: null
  });
  const [namespaces, setNamespaces] = useState<LoadState<NamespaceSummary[]>>({
    status: "idle",
    data: []
  });
  const [selectedNamespace, setSelectedNamespace] = useState("");
  const [resources, setResources] = useState<LoadState<ResourceSummary[]>>({
    status: "idle",
    data: emptyResources
  });
  const [crds, setCrds] = useState<LoadState<CrdGroup[]>>({
    status: "idle",
    data: []
  });
  const [expandedCrdGroups, setExpandedCrdGroups] = useState<Set<string>>(
    () => new Set()
  );
  const [selectedCrd, setSelectedCrd] = useState<CrdResource | null>(null);
  const [customResources, setCustomResources] = useState<
    LoadState<CustomResourceTable>
  >({
    status: "idle",
    data: emptyCustomResources
  });
  const [selectedCustomResource, setSelectedCustomResource] = useState<{
    crd: CrdResource;
    name: string;
    namespace: string;
  } | null>(null);
  const [selectedResource, setSelectedResource] = useState<ResourceSummary | null>(
    null
  );
  const [resourceHistory, setResourceHistory] = useState<ResourceSummary[]>([]);
  const [details, setDetails] = useState<LoadState<WorkloadDetails | null>>({
    status: "idle",
    data: null
  });
  const [activeDetailTab, setActiveDetailTab] = useState<DetailTab>("overview");
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [logStatus, setLogStatus] = useState<LoadState<null>>({
    status: "idle",
    data: null
  });
  const [events, setEvents] = useState<LoadState<EventSummary[]>>({
    status: "idle",
    data: []
  });
  const [yaml, setYaml] = useState<LoadState<string>>({
    status: "idle",
    data: ""
  });
  const [resourceView, setResourceView] = useState<"applications" | "all">(
    "applications"
  );
  const [query, setQuery] = useState("");
  const [clusterMenuOpen, setClusterMenuOpen] = useState(false);
  const clusterMenuRef = useRef<HTMLDivElement>(null);
  const selectedResourceNamespace =
    selectedResource?.namespace ?? selectedNamespace;
  const shouldShowCrdPanel =
    crds.status === "loading" || crds.status === "error" || crds.data.length > 0;

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    document.documentElement.style.colorScheme = themeMode;
    window.localStorage.setItem(themeStorageKey, themeMode);
  }, [themeMode]);

  useEffect(() => {
    void loadContexts();
  }, []);

  useEffect(() => {
    if (!selectedContext) return;
    void checkConnection(selectedContext);
    setSelectedNamespace("");
    void loadNamespaces(selectedContext);
    void loadCrds(selectedContext);
  }, [selectedContext]);

  useEffect(() => {
    if (!selectedContext) return;
    void loadResources(selectedContext, selectedNamespace);
  }, [selectedContext, selectedNamespace, resourceView]);

  useEffect(() => {
    if (!selectedContext || !selectedCrd) return;
    void loadCustomResources(selectedContext, selectedCrd);
  }, [selectedContext, selectedCrd]);

  useEffect(() => {
    setSelectedResource(null);
    setResourceHistory([]);
    setSelectedCrd(null);
    setSelectedCustomResource(null);
    setDetails({ status: "idle", data: null });
    setActiveDetailTab("overview");
    setLogLines([]);
    setLogStatus({ status: "idle", data: null });
    setEvents({ status: "idle", data: [] });
    setYaml({ status: "idle", data: "" });
  }, [selectedContext, selectedNamespace, resourceView]);

  useEffect(() => {
    setActiveDetailTab("overview");
  }, [selectedResource]);

  useEffect(() => {
    setActiveDetailTab("overview");
    setDetails({ status: "idle", data: null });
    setEvents({ status: "idle", data: [] });
    setYaml({ status: "idle", data: "" });
  }, [selectedCustomResource]);

  useEffect(() => {
    if (!selectedContext || !selectedResourceNamespace || !selectedResource) return;
    void loadDetails(selectedContext, selectedResourceNamespace, selectedResource);
  }, [selectedContext, selectedResourceNamespace, selectedResource]);

  useEffect(() => {
    if (!selectedContext || !selectedCustomResource) return;
    void loadCustomResourceDetails(selectedContext, selectedCustomResource.crd, selectedCustomResource.namespace, selectedCustomResource.name);
  }, [selectedContext, selectedCustomResource]);

  useEffect(() => {
    if (
      !selectedContext ||
      !selectedResourceNamespace ||
      !selectedResource ||
      activeDetailTab !== "events"
    ) {
      return;
    }

    void loadEvents(selectedContext, selectedResourceNamespace, selectedResource);
  }, [activeDetailTab, selectedContext, selectedResourceNamespace, selectedResource]);

  useEffect(() => {
    if (!selectedContext || !selectedCustomResource || activeDetailTab !== "events") return;
    void loadEvents(selectedContext, selectedCustomResource.namespace, {
      name: selectedCustomResource.name,
      kind: selectedCustomResource.crd.kind,
      status: "Active"
    });
  }, [activeDetailTab, selectedContext, selectedCustomResource]);

  useEffect(() => {
    if (
      !selectedContext ||
      !selectedResourceNamespace ||
      !selectedResource ||
      activeDetailTab !== "yaml"
    ) {
      return;
    }

    void loadYaml(selectedContext, selectedResourceNamespace, selectedResource);
  }, [activeDetailTab, selectedContext, selectedResourceNamespace, selectedResource]);

  useEffect(() => {
    if (!selectedContext || !selectedCustomResource || activeDetailTab !== "yaml") return;
    void loadCustomResourceYaml(selectedContext, selectedCustomResource.crd, selectedCustomResource.namespace, selectedCustomResource.name);
  }, [activeDetailTab, selectedContext, selectedCustomResource]);

  useEffect(() => {
    if (
      !selectedContext ||
      !selectedResourceNamespace ||
      !selectedResource ||
      activeDetailTab !== "logs"
    ) {
      return;
    }

    const streamId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;
    let mounted = true;

    setLogLines([]);
    setLogStatus({ status: "loading", data: null });

    const unlistenPromise = listen<LogLine>("workload-log", (event) => {
      if (!mounted || event.payload.stream_id !== streamId) return;
      setLogLines((current) => [...current.slice(-999), event.payload]);
      setLogStatus({ status: "idle", data: null });
    });

    void invoke("start_workload_log_stream", {
      context: selectedContext,
      namespace: selectedResourceNamespace,
      kind: selectedResource.kind,
      name: selectedResource.name,
      streamId
    }).catch((error) => {
      if (!mounted) return;
      setLogStatus({
        status: "error",
        data: null,
        message: String(error)
      });
    });

    return () => {
      mounted = false;
      void invoke("stop_log_stream", { streamId });
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [activeDetailTab, selectedContext, selectedResourceNamespace, selectedResource]);

  useEffect(() => {
    if (!clusterMenuOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !clusterMenuRef.current?.contains(event.target)
      ) {
        setClusterMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setClusterMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [clusterMenuOpen]);

  async function loadContexts() {
    setContexts((current) => ({ status: "loading", data: current.data }));

    try {
      const nextContexts = await invoke<ClusterContext[]>("list_contexts");
      setContexts({ status: "idle", data: nextContexts });

      const defaultContext =
        nextContexts.find((context) => context.current)?.name ??
        nextContexts[0]?.name ??
        "";

      setSelectedContext((current) => current || defaultContext);
    } catch (error) {
      setContexts({
        status: "error",
        data: [],
        message: String(error)
      });
    }
  }

  async function checkConnection(context: string) {
    setConnection({ status: "loading", data: null });

    try {
      await invoke("check_context_connection", { context });
      setConnection({ status: "idle", data: null });
    } catch (error) {
      setConnection({
        status: "error",
        data: null,
        message: String(error)
      });
    }
  }

  async function loadNamespaces(context: string) {
    setNamespaces((current) => ({ status: "loading", data: current.data }));
    setResources({ status: "idle", data: emptyResources });

    try {
      const nextNamespaces = await invoke<NamespaceSummary[]>("list_namespaces", {
        context
      });
      setNamespaces({ status: "idle", data: nextNamespaces });
      setSelectedNamespace((current) => {
        if (nextNamespaces.some((namespace) => namespace.name === current)) {
          return current;
        }

        return "";
      });
    } catch (error) {
      setNamespaces({
        status: "error",
        data: [],
        message: String(error)
      });
      setSelectedNamespace("");
    }
  }

  async function loadResources(context: string, namespace: string) {
    setResources((current) => ({ status: "loading", data: current.data }));

    try {
      const nextResources = await invoke<ResourceSummary[]>("list_resources", {
        context,
        namespace,
        view: resourceView
      });
      setResources({ status: "idle", data: nextResources });
    } catch (error) {
      setResources({
        status: "error",
        data: [],
        message: String(error)
      });
    }
  }

  async function loadCrds(context: string) {
    setCrds((current) => ({ status: "loading", data: current.data }));

    try {
      const nextCrds = await invoke<CrdGroup[]>("list_crds", { context });
      setCrds({ status: "idle", data: nextCrds });
      setExpandedCrdGroups((current) => {
        const availableGroups = new Set(nextCrds.map((group) => group.group));
        const nextExpanded = new Set(
          [...current].filter((group) => availableGroups.has(group))
        );

        if (nextExpanded.size > 0) {
          return nextExpanded;
        }

        return new Set(nextCrds.slice(0, 2).map((group) => group.group));
      });
    } catch (error) {
      setCrds({
        status: "error",
        data: [],
        message: String(error)
      });
    }
  }

  async function loadCustomResources(context: string, resource: CrdResource) {
    setCustomResources((current) => ({
      status: "loading",
      data: current.data
    }));

    try {
      const nextResources = await invoke<CustomResourceTable>(
        "list_custom_resources",
        {
          context,
          resource
        }
      );
      setCustomResources({ status: "idle", data: nextResources });
    } catch (error) {
      setCustomResources({
        status: "error",
        data: emptyCustomResources,
        message: String(error)
      });
    }
  }

  async function loadCustomResourceDetails(
    context: string,
    crd: CrdResource,
    namespace: string,
    name: string
  ) {
    setDetails((current) => ({ status: "loading", data: current.data }));

    try {
      const nextDetails = await invoke<WorkloadDetails>("get_custom_resource_details", {
        context,
        resource: crd,
        namespace,
        name
      });
      setDetails({ status: "idle", data: nextDetails });
    } catch (error) {
      setDetails({
        status: "error",
        data: null,
        message: String(error)
      });
    }
  }

  async function loadCustomResourceYaml(
    context: string,
    crd: CrdResource,
    namespace: string,
    name: string
  ) {
    setYaml((current) => ({ status: "loading", data: current.data }));

    try {
      const nextYaml = await invoke<string>("get_custom_resource_yaml", {
        context,
        resource: crd,
        namespace,
        name
      });
      setYaml({ status: "idle", data: nextYaml });
    } catch (error) {
      setYaml({
        status: "error",
        data: "",
        message: String(error)
      });
    }
  }

  async function loadDetails(
    context: string,
    namespace: string,
    resource: ResourceSummary
  ) {
    setDetails((current) => ({ status: "loading", data: current.data }));

    try {
      const nextDetails = await invoke<WorkloadDetails>("get_workload_details", {
        context,
        namespace,
        kind: resource.kind,
        name: resource.name
      });
      setDetails({ status: "idle", data: nextDetails });
    } catch (error) {
      setDetails({
        status: "error",
        data: null,
        message: String(error)
      });
    }
  }

  async function loadEvents(
    context: string,
    namespace: string,
    resource: ResourceSummary
  ) {
    setEvents((current) => ({ status: "loading", data: current.data }));

    try {
      const nextEvents = await invoke<EventSummary[]>("list_workload_events", {
        context,
        namespace,
        kind: resource.kind,
        name: resource.name
      });
      setEvents({ status: "idle", data: nextEvents });
    } catch (error) {
      setEvents({
        status: "error",
        data: [],
        message: String(error)
      });
    }
  }

  async function loadYaml(
    context: string,
    namespace: string,
    resource: ResourceSummary
  ) {
    setYaml((current) => ({ status: "loading", data: current.data }));

    try {
      const nextYaml = await invoke<string>("get_workload_yaml", {
        context,
        namespace,
        kind: resource.kind,
        name: resource.name
      });
      setYaml({ status: "idle", data: nextYaml });
    } catch (error) {
      setYaml({
        status: "error",
        data: "",
        message: String(error)
      });
    }
  }

  const filteredResources = useMemo(() => {
    const needle = query.trim().toLowerCase();

    if (!needle) return resources.data;

    return resources.data.filter((resource) =>
      [resource.name, resource.kind, resource.status]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [query, resources.data]);

  const connectionLabel = !selectedContext
    ? "No context selected"
    : connection.status === "loading"
      ? "Checking..."
      : connection.status === "error"
        ? "Cannot connect"
        : "Connected";
  const connectionDotClass =
    connection.status === "idle" && selectedContext
      ? "dot online"
      : connection.status === "loading"
        ? "dot pending"
        : "dot muted";

  function startWindowDrag(event: React.MouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    void getCurrentWindow().startDragging();
  }

  function openResource(resource: ResourceSummary, pushCurrent = false) {
    if (pushCurrent && selectedResource) {
      setResourceHistory((current) => [...current, selectedResource]);
    } else if (!pushCurrent) {
      setResourceHistory([]);
    }

    setSelectedResource(resource);
  }

  function navigateBackFromResource() {
    const previous = resourceHistory.at(-1);

    if (!previous) {
      setSelectedResource(null);
      return;
    }

    setResourceHistory((current) => current.slice(0, -1));
    setSelectedResource(previous);
  }

  function toggleCrdGroup(group: string) {
    setExpandedCrdGroups((current) => {
      const next = new Set(current);

      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }

      return next;
    });
  }

  function toggleThemeMode() {
    setThemeMode((current) => (current === "dark" ? "light" : "dark"));
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div
          className="window-drag-strip"
          data-tauri-drag-region
          onMouseDown={startWindowDrag}
        />

        <section className="cluster-card" ref={clusterMenuRef}>
          <label id="cluster-select-label">Cluster</label>
          <button
            aria-controls="cluster-menu"
            aria-expanded={clusterMenuOpen}
            aria-labelledby="cluster-select-label"
            className="cluster-trigger"
            disabled={contexts.status === "loading"}
            onClick={() => setClusterMenuOpen((open) => !open)}
            type="button"
          >
            <span title={selectedContext}>
              {selectedContext
                ? displayContextName(selectedContext)
                : "Choose a cluster"}
            </span>
            <ChevronDown size={16} />
          </button>

          {clusterMenuOpen ? (
            <div
              aria-labelledby="cluster-select-label"
              className="cluster-menu"
              id="cluster-menu"
              role="listbox"
            >
              <div className="cluster-menu-heading">Default</div>
              {contexts.data.map((context) => (
                <button
                  aria-selected={context.name === selectedContext}
                  className={
                    context.name === selectedContext
                      ? "cluster-option selected"
                      : "cluster-option"
                  }
                  key={context.name}
                  onClick={() => {
                    setSelectedContext(context.name);
                    setClusterMenuOpen(false);
                  }}
                  role="option"
                  title={context.name}
                  type="button"
                >
                  <span className="cluster-check">
                    {context.name === selectedContext ? <Check size={18} /> : null}
                  </span>
                  <span>{displayContextName(context.name)}</span>
                </button>
              ))}
            </div>
          ) : null}

          <p className="connection">
            <span className={connectionDotClass} />
            <span title={connection.status === "error" ? connection.message : undefined}>
              {connectionLabel}
            </span>
          </p>
        </section>

        <section className="namespace-panel">
          <div className="panel-heading">
            <span>Namespaces</span>
            {namespaces.status === "loading" ? (
              <Loader2 className="spin" size={14} />
            ) : null}
          </div>

          {namespaces.status === "error" ? (
            <EmptyState
              icon={<CircleAlert size={18} />}
              title="Namespaces unavailable"
              detail={namespaces.message}
            />
          ) : (
            <div className="namespace-list">
              <button
                className={!selectedNamespace && !selectedCrd ? "selected" : ""}
                onClick={() => {
                  setSelectedNamespace("");
                  setSelectedCrd(null);
                  setSelectedResource(null);
                }}
                type="button"
              >
                <Folder size={16} />
                <span>All namespaces</span>
              </button>
              {namespaces.data.map((namespace) => (
                <button
                  className={
                    namespace.name === selectedNamespace ? "selected" : ""
                  }
                  key={namespace.name}
                  onClick={() => {
                    setSelectedNamespace(namespace.name);
                    setSelectedCrd(null);
                    setSelectedResource(null);
                  }}
                  type="button"
                >
                  <Folder size={16} />
                  <span>{namespace.name}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        {shouldShowCrdPanel ? (
          <section className="crd-panel">
            <div className="panel-heading">
              <span>Custom Resources</span>
              {crds.status === "loading" ? <Loader2 className="spin" size={14} /> : null}
            </div>

            {crds.status === "error" ? (
              <EmptyState
                icon={<CircleAlert size={18} />}
                title="CRDs unavailable"
                detail={crds.message}
              />
            ) : (
              <div className="crd-list">
                {crds.data.map((group) => (
                  <div className="crd-group" key={group.group}>
                    <button
                      className="crd-group-title"
                      onClick={() => toggleCrdGroup(group.group)}
                      type="button"
                    >
                      <img
                        alt=""
                        className="crd-favicon"
                        src={faviconUrlForCrdGroup(group.group)}
                      />
                      <span>{group.group}</span>
                      {expandedCrdGroups.has(group.group) ? (
                        <ChevronDown size={15} />
                      ) : (
                        <ChevronRight size={15} />
                      )}
                    </button>
                    {expandedCrdGroups.has(group.group)
                      ? group.resources.map((resource) => (
                          <button
                            className={
                              selectedCrd?.group === resource.group &&
                              selectedCrd?.kind === resource.kind
                                ? "selected"
                                : ""
                            }
                            key={`${resource.group}-${resource.kind}`}
                            onClick={() => {
                              setSelectedResource(null);
                              setSelectedCrd(resource);
                            }}
                            type="button"
                          >
                            {resource.kind}
                          </button>
                        ))
                      : null}
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : null}
      </aside>

      <section className="content">
        <header
          className="topbar"
          data-tauri-drag-region
          onMouseDown={startWindowDrag}
        >
          {selectedResource || selectedCustomResource ? (
            <div aria-hidden="true" />
          ) : (
            <div className="crumb">
              <Cloud size={19} />
              <span>
                {selectedCrd
                  ? `${selectedCrd.group} / ${selectedCrd.kind}`
                  : selectedNamespace || "All namespaces"}
              </span>
            </div>
          )}

          {selectedResource || selectedCustomResource ? (
            <div
              className="segmented detail-tabs"
              onPointerDown={(event) => event.stopPropagation()}
              role="tablist"
            >
              <button
                className={activeDetailTab === "overview" ? "active" : ""}
                onClick={() => setActiveDetailTab("overview")}
                type="button"
              >
                Overview
              </button>
              {selectedResource && supportsLogs(selectedResource) ? (
                <button
                  className={activeDetailTab === "logs" ? "active" : ""}
                  onClick={() => setActiveDetailTab("logs")}
                  type="button"
                >
                  Logs
                </button>
              ) : null}
              <button
                className={activeDetailTab === "events" ? "active" : ""}
                onClick={() => setActiveDetailTab("events")}
                type="button"
              >
                Events
              </button>
              <button
                className={activeDetailTab === "yaml" ? "active" : ""}
                onClick={() => setActiveDetailTab("yaml")}
                type="button"
              >
                YAML
              </button>
            </div>
          ) : selectedCrd ? (
            <div className="resource-count">
              <span className="dot online" />
              {customResources.data.count} {selectedCrd.kind}
              {customResources.data.count === 1 ? "" : "s"}
            </div>
          ) : (
            <div
              className="segmented"
              onPointerDown={(event) => event.stopPropagation()}
              role="tablist"
            >
              <button
                className={resourceView === "applications" ? "active" : ""}
                onClick={() => setResourceView("applications")}
                type="button"
              >
                Applications
              </button>
              <button
                className={resourceView === "all" ? "active" : ""}
                onClick={() => setResourceView("all")}
                type="button"
              >
                All Resources
              </button>
            </div>
          )}

          <div className="topbar-actions">
            <button
              aria-label={
                themeMode === "dark"
                  ? "Use Catppuccin Latte"
                  : "Use Catppuccin Frappe"
              }
              className="icon-button"
              onClick={toggleThemeMode}
              onPointerDown={(event) => event.stopPropagation()}
              title={
                themeMode === "dark"
                  ? "Use Catppuccin Latte"
                  : "Use Catppuccin Frappe"
              }
              type="button"
            >
              {themeMode === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button
              className="refresh"
              disabled={!selectedContext}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => {
                if (selectedContext) void loadNamespaces(selectedContext);
                if (selectedContext) {
                  void loadResources(selectedContext, selectedNamespace);
                }
                if (selectedContext && selectedCrd && !selectedCustomResource) {
                  void loadCustomResources(selectedContext, selectedCrd);
                }
                if (selectedContext && selectedResourceNamespace && selectedResource) {
                  void loadDetails(selectedContext, selectedResourceNamespace, selectedResource);
                  if (activeDetailTab === "events") {
                    void loadEvents(selectedContext, selectedResourceNamespace, selectedResource);
                  }
                  if (activeDetailTab === "yaml") {
                    void loadYaml(selectedContext, selectedResourceNamespace, selectedResource);
                  }
                }
                if (selectedContext && selectedCustomResource) {
                  void loadCustomResourceDetails(selectedContext, selectedCustomResource.crd, selectedCustomResource.namespace, selectedCustomResource.name);
                  if (activeDetailTab === "events") {
                    void loadEvents(selectedContext, selectedCustomResource.namespace, {
                      name: selectedCustomResource.name,
                      kind: selectedCustomResource.crd.kind,
                      status: "Active"
                    });
                  }
                  if (activeDetailTab === "yaml") {
                    void loadCustomResourceYaml(selectedContext, selectedCustomResource.crd, selectedCustomResource.namespace, selectedCustomResource.name);
                  }
                }
              }}
              type="button"
            >
              <RefreshCw size={16} />
              Refresh
            </button>
          </div>
        </header>

        <div className={selectedResource || selectedCustomResource ? "subbar detail-subbar" : "subbar"}>
          {selectedResource || selectedCustomResource ? null : (
            <div>
              <h1>
                {selectedCrd?.kind ?? (selectedNamespace || "All namespaces")}
              </h1>
              <p>
                {selectedCrd
                  ? `${selectedCrd.group}/${selectedCrd.version}`
                  : selectedContext
                    ? `Context ${selectedContext}`
                    : "Select an existing kubeconfig context to begin."}
              </p>
            </div>
          )}
          {selectedResource ? (
            <button
              className="back-button"
              onClick={navigateBackFromResource}
              type="button"
            >
              <List size={15} />
              {resourceHistory.length > 0 ? "Back" : "Back to resources"}
            </button>
          ) : selectedCustomResource ? (
            <button
              className="back-button"
              onClick={() => setSelectedCustomResource(null)}
              type="button"
            >
              <List size={15} />
              {`Back to ${selectedCustomResource.crd.kind}`}
            </button>
          ) : selectedCrd ? (
            <button
              className="back-button"
              onClick={() => setSelectedCrd(null)}
              type="button"
            >
              <List size={15} />
              Back to namespaces
            </button>
          ) : (
            <label className="search">
              <Search size={16} />
              <input
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter resources"
                value={query}
              />
            </label>
          )}
        </div>

        {contexts.status === "error" ? (
          <EmptyState
            icon={<TerminalSquare size={28} />}
            title="Kubeconfig is not ready"
            detail={contexts.message}
          />
        ) : resources.status === "error" ? (
          <EmptyState
            icon={<CircleAlert size={28} />}
            title="Resources unavailable"
            detail={resources.message}
          />
        ) : selectedCustomResource ? (
          <WorkloadDetailsView
            activeTab={activeDetailTab}
            details={details}
            events={events}
            fallback={{ name: selectedCustomResource.name, kind: selectedCustomResource.crd.kind, namespace: selectedCustomResource.namespace, status: "Active" }}
            logLines={[]}
            logStatus={{ status: "idle", data: null }}
            onOpenResource={(resource) => openResource(resource, true)}
            yaml={yaml}
          />
        ) : selectedCrd ? (
          <CustomResourceTableView
            onRowClick={(name, namespace) => setSelectedCustomResource({ crd: selectedCrd, name, namespace })}
            table={customResources}
          />
        ) : selectedResource ? (
          <WorkloadDetailsView
            activeTab={activeDetailTab}
            details={details}
            events={events}
            fallback={selectedResource}
            logLines={logLines}
            logStatus={logStatus}
            onOpenResource={(resource) => openResource(resource, true)}
            yaml={yaml}
          />
        ) : (
          <ResourceTable
            loading={resources.status === "loading"}
            onOpenDetails={openResource}
            resources={filteredResources}
            showNamespace={!selectedNamespace}
          />
        )}
      </section>
    </main>
  );
}

function ResourceTable({
  loading,
  onOpenDetails,
  resources,
  showNamespace
}: {
  loading: boolean;
  onOpenDetails: (resource: ResourceSummary) => void;
  resources: ResourceSummary[];
  showNamespace: boolean;
}) {
  if (loading) {
    return (
      <div className="table-placeholder">
        <Loader2 className="spin" size={24} />
        <span>Loading resources from the cluster...</span>
      </div>
    );
  }

  if (resources.length === 0) {
    return (
      <EmptyState
        icon={<Layers3 size={28} />}
        title="No resources found"
        detail="This namespace has no resources for the selected view, or your RBAC rules hide them."
      />
    );
  }

  return (
    <div className="resource-table-wrap">
      <table className="resource-table">
        <thead>
          <tr>
            {showNamespace ? <th>Namespace</th> : null}
            <th>Name</th>
            <th>Kind</th>
            <th>Ready</th>
            <th>Status</th>
            <th>Age</th>
          </tr>
        </thead>
        <tbody>
          {resources.map((resource) => {
            return (
              <tr
                className="clickable-row"
                key={`${resource.kind}-${resource.namespace}-${resource.name}`}
                onClick={() => onOpenDetails(resource)}
              >
                {showNamespace ? <td>{resource.namespace ?? "-"}</td> : null}
                <td>
                  <span className="resource-name">
                    {iconForKind(resource.kind)}
                    {resource.name}
                  </span>
                </td>
                <td>{resource.kind}</td>
                <td>{resource.ready ?? "-"}</td>
                <td>
                  <span className={`status ${statusTone(resource.status)}`}>
                    {resource.status}
                  </span>
                </td>
                <td>{resource.age ?? "-"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CustomResourceTableView({
  onRowClick,
  table
}: {
  onRowClick: (name: string, namespace: string) => void;
  table: LoadState<CustomResourceTable>;
}) {
  if (table.status === "loading" && table.data.rows.length === 0) {
    return (
      <div className="table-placeholder">
        <Loader2 className="spin" size={24} />
        <span>Loading custom resources...</span>
      </div>
    );
  }

  if (table.status === "error") {
    return (
      <EmptyState
        icon={<CircleAlert size={28} />}
        title="Custom resources unavailable"
        detail={table.message}
      />
    );
  }

  if (table.data.rows.length === 0) {
    return (
      <EmptyState
        icon={<Layers3 size={28} />}
        title="No custom resources found"
        detail="This CRD has no visible resources, or RBAC rules hide them."
      />
    );
  }

  const isNamespaced = table.data.columns[0] === "Namespace";

  return (
    <div className="resource-table-wrap custom-resource-table">
      <table className="resource-table">
        <thead>
          <tr>
            {table.data.columns.map((column, index) => (
              <th key={`${column}-${index}`}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.data.rows.map((row, rowIndex) => {
            const namespace = isNamespaced ? row[0] : "";
            const name = isNamespaced ? row[1] : row[0];
            return (
              <tr
                className="clickable-row"
                key={`${row.join("-")}-${rowIndex}`}
                onClick={() => onRowClick(name, namespace)}
              >
                {row.map((cell, cellIndex) => (
                  <td
                    className={cellIndex === (isNamespaced ? 1 : 0) ? "custom-resource-name" : ""}
                    key={`${cell}-${cellIndex}`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function WorkloadDetailsView({
  activeTab,
  details,
  events,
  fallback,
  logLines,
  logStatus,
  onOpenResource,
  yaml
}: {
  activeTab: DetailTab;
  details: LoadState<WorkloadDetails | null>;
  events: LoadState<EventSummary[]>;
  fallback: ResourceSummary;
  logLines: LogLine[];
  logStatus: LoadState<null>;
  onOpenResource: (resource: ResourceSummary) => void;
  yaml: LoadState<string>;
}) {
  if (details.status === "loading" && !details.data) {
    return (
      <div className="table-placeholder">
        <Loader2 className="spin" size={24} />
        <span>Loading {fallback.kind} details...</span>
      </div>
    );
  }

  if (details.status === "error") {
    return (
      <EmptyState
        icon={<CircleAlert size={28} />}
        title="Details unavailable"
        detail={details.message}
      />
    );
  }

  const workload = details.data;

  if (!workload) return null;

  if (activeTab === "logs" && supportsLogs(fallback)) {
    return <LogsView lines={logLines} status={logStatus} />;
  }

  if (activeTab === "events") {
    return <EventsView events={events} />;
  }

  if (activeTab === "yaml") {
    return <YamlView yaml={yaml} />;
  }

  const hasImages = workload.images.length > 0;
  const resourceTotals = [
    workload.resource_totals.cpu_requested,
    workload.resource_totals.cpu_limited,
    workload.resource_totals.memory_requested,
    workload.resource_totals.memory_limited
  ];
  const hasResourceTotals = resourceTotals.some(hasMeaningfulResourceValue);
  const hasPods = workload.pods.length > 0;
  const hasServices = workload.services.length > 0;
  const isWorkload = supportsLogs(fallback);

  return (
    <div className="details-view">
      <div className="details-header">
        <div>
          <h1>{workload.name}</h1>
          <p>{workload.kind}</p>
        </div>
        <div className="details-status">
          <span className={`status ${statusTone(workload.status)}`}>
            {workload.status}
          </span>
          {workload.ready ? <span>{workload.ready} Pods</span> : null}
        </div>
      </div>

      <section className="details-section">
        <h2>Overview</h2>
        <div className={hasResourceTotals ? "overview-grid" : "overview-grid single"}>
          <div className="info-card">
            <InfoRow label="Kind" value={workload.kind} />
            <InfoRow label="Namespace" value={workload.namespace} />
            <InfoRow label="Status" value={workload.status} />
            <InfoRow label="Age" value={workload.age ?? "-"} />
            {hasImages ? (
              <InfoRow label="Images" value={workload.images.join("\n")} />
            ) : null}
          </div>
          {hasResourceTotals ? (
            <div className="info-card resources-card">
              <div className="metrics-title">Resources</div>
              <InfoRow
                label="CPU Request"
                value={workload.resource_totals.cpu_requested}
              />
              <InfoRow
                label="CPU Limit"
                value={workload.resource_totals.cpu_limited}
              />
              <InfoRow
                label="Memory Request"
                value={workload.resource_totals.memory_requested}
              />
              <InfoRow
                label="Memory Limit"
                value={workload.resource_totals.memory_limited}
              />
            </div>
          ) : null}
        </div>
      </section>

      {workload.config_warnings.length > 0 ? (
        <section className="details-section">
          <h2>Warnings</h2>
          <ul className="warnings-list">
            {workload.config_warnings.map((warning, i) => (
              <li key={i} className="warning-item">
                <TriangleAlert size={14} className="warning-icon" />
                <span className="warning-container">{warning.container}</span>
                <span className="warning-message">{warning.message}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {isWorkload || hasPods ? (
        <section className="details-section">
          <h2>{workload.kind === "Pod" ? "Containers" : "Pods"}</h2>
          <DetailsTable
            empty={workload.kind === "Pod" ? "No containers found." : "No pods match this workload selector."}
            headers={workload.kind === "Pod"
              ? ["Name", "Ready", "Restarts", "Status"]
              : ["Name", "Age", "Containers", "Restarts", "Status"]}
            onRowClick={workload.kind === "Pod" ? undefined : (index) => {
              const pod = workload.pods[index];
              onOpenResource({
                name: pod.name,
                kind: "Pod",
                namespace: workload.namespace,
                ready: pod.containers,
                status: pod.status,
                age: pod.age
              });
            }}
            rows={workload.pods.map((pod) =>
              workload.kind === "Pod"
                ? [
                    pod.name,
                    pod.containers,
                    String(pod.restarts),
                    pod.status === "Completed"
                      ? <Check size={14} className="status-completed" key={pod.name} />
                      : <span className={`status ${statusTone(pod.status)}`} key={pod.name}>{pod.status}</span>
                  ]
                : [
                    pod.name,
                    pod.age ?? "-",
                    pod.containers,
                    String(pod.restarts),
                    <span className={`status ${statusTone(pod.status)}`} key={pod.name}>
                      {pod.status}
                    </span>
                  ]
            )}
          />
        </section>
      ) : null}

      <section className="details-section">
        <h2>Details</h2>
        <div className="metadata-grid">
          <MetadataList title="Labels" values={workload.labels} />
          <MetadataList title="Annotations" values={workload.annotations.filter(a => a.key !== "kubectl.kubernetes.io/last-applied-configuration")} />
        </div>
      </section>

      {isWorkload || hasServices ? (
        <section className="details-section">
          <h2>Services</h2>
          <DetailsTable
            empty="No services select this workload."
            headers={["Name", "Type", "Ports"]}
            onRowClick={(index) => {
              const service = workload.services[index];
              onOpenResource({
                name: service.name,
                kind: "Service",
                namespace: workload.namespace,
                status: "Active"
              });
            }}
            rows={workload.services.map((service) => [
              service.name,
              service.service_type,
              service.ports.join(", ") || "-"
            ])}
          />
        </section>
      ) : null}
    </div>
  );
}

function LogsView({
  lines,
  status
}: {
  lines: LogLine[];
  status: LoadState<null>;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  return (
    <div className="logs-view">
      <div className="logs-toolbar">
        <span>
          {status.status === "loading"
            ? "Connecting to log stream..."
            : status.status === "error"
            ? "Log stream failed"
            : "Streaming live logs"}
        </span>
        {status.status === "loading" ? <Loader2 className="spin" size={14} /> : null}
      </div>

      {status.status === "error" ? (
        <div className="logs-error">{status.message}</div>
      ) : null}

      <pre className="logs-panel">
        {lines.length === 0 && status.status !== "error" ? (
          <span className="logs-empty">Waiting for logs...</span>
        ) : (
          lines.map((entry, index) => (
            <span className="log-line" key={`${entry.pod}-${entry.container}-${index}`}>
              <span className="log-source">[{entry.pod}]</span>{" "}
              <span>{renderLogLine(entry.line)}</span>
            </span>
          ))
        )}
        <div ref={endRef} />
      </pre>
    </div>
  );
}

function EventsView({ events }: { events: LoadState<EventSummary[]> }) {
  if (events.status === "loading" && events.data.length === 0) {
    return (
      <div className="table-placeholder">
        <Loader2 className="spin" size={24} />
        <span>Loading Kubernetes events...</span>
      </div>
    );
  }

  if (events.status === "error") {
    return (
      <EmptyState
        icon={<CircleAlert size={28} />}
        title="Events unavailable"
        detail={events.message}
      />
    );
  }

  return (
    <div className="events-view">
      <DetailsTable
        empty="No Kubernetes events found for this resource."
        headers={["Type", "Reason", "Message", "Count", "Source", "Last Seen"]}
        rows={events.data.map((event) => [
          <span className={`event-type ${event.event_type.toLowerCase()}`} key="type">
            {event.event_type}
          </span>,
          event.reason,
          event.message,
          String(event.count),
          event.source,
          event.last_seen
        ])}
      />
    </div>
  );
}

function yamlLineIndent(line: string): number {
  if (line.trim() === "") return -1;
  return line.length - line.trimStart().length;
}

function findCollapsibleLines(lines: string[]): Set<number> {
  const indents = lines.map(yamlLineIndent);
  const collapsible = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (indents[i] === -1) continue;
    const trimmed = lines[i].trim();
    for (let j = i + 1; j < lines.length; j++) {
      if (indents[j] === -1) continue;
      if (indents[j] > indents[i]) {
        collapsible.add(i);
      } else if (
        indents[j] === indents[i] &&
        trimmed.endsWith(":") &&
        lines[j].trim().startsWith("- ")
      ) {
        // Compact YAML: array items at same indent level as their key
        collapsible.add(i);
      }
      break;
    }
  }
  return collapsible;
}

function findDefaultCollapsed(lines: string[]): Set<number> {
  const collapsed = new Set<number>();
  lines.forEach((line, i) => {
    if (/^\s*managedFields\s*:/.test(line)) collapsed.add(i);
  });
  return collapsed;
}

function nextNonEmptyIndent(indents: number[], from: number): { idx: number; indent: number } | null {
  for (let k = from; k < indents.length; k++) {
    if (indents[k] !== -1) return { idx: k, indent: indents[k] };
  }
  return null;
}

function getSkippedLines(lines: string[], collapsedLines: Set<number>): Set<number> {
  const indents = lines.map(yamlLineIndent);
  const toSkip = new Set<number>();

  for (const lineIdx of collapsedLines) {
    const baseIndent = indents[lineIdx];
    if (baseIndent === -1) continue;

    // Detect compact array: key at indent N followed by "- " items at indent N
    const firstChild = nextNonEmptyIndent(indents, lineIdx + 1);
    const isSameLevelArray =
      firstChild !== null &&
      firstChild.indent === baseIndent &&
      lines[firstChild.idx].trim().startsWith("- ");

    let j = lineIdx + 1;
    while (j < lines.length) {
      const indent = indents[j];

      if (indent === -1) {
        // Skip empty lines only if next non-empty is still inside the section
        const next = nextNonEmptyIndent(indents, j + 1);
        if (
          next !== null &&
          (next.indent > baseIndent ||
            (isSameLevelArray && next.indent === baseIndent && lines[next.idx].trim().startsWith("- ")))
        ) {
          toSkip.add(j);
          j++;
        } else {
          break;
        }
      } else if (indent > baseIndent) {
        toSkip.add(j);
        j++;
      } else if (isSameLevelArray && indent === baseIndent && lines[j].trim().startsWith("- ")) {
        // Same-level array item
        toSkip.add(j);
        j++;
      } else {
        break;
      }
    }
  }
  return toSkip;
}

function highlightYamlValue(value: string): React.ReactNode {
  if (!value) return null;
  if (value === "null" || value === "~") return <span className="yaml-null">{value}</span>;
  if (value === "true" || value === "false") return <span className="yaml-bool">{value}</span>;
  if (/^-?\d+(\.\d+)?$/.test(value)) return <span className="yaml-number">{value}</span>;
  if (value === "|" || value === ">" || value === "|-" || value === ">-" || value === "|+" || value === ">+")
    return <span className="yaml-string">{value}</span>;
  if (value.startsWith('"') || value.startsWith("'")) return <span className="yaml-string">{value}</span>;
  return <span className="yaml-value">{value}</span>;
}

function highlightYamlLine(line: string): React.ReactNode {
  if (line.trim() === "") return <span>{line}</span>;
  const trimmed = line.trim();
  const indent = line.length - line.trimStart().length;
  const indentStr = line.substring(0, indent);

  if (trimmed.startsWith("#")) return <span className="yaml-comment">{line}</span>;

  // Array item: "- key: value" or "- value"
  if (trimmed.startsWith("- ")) {
    const afterDash = trimmed.substring(2);
    const sep = afterDash.indexOf(": ");
    if (sep !== -1) {
      const key = afterDash.substring(0, sep);
      const value = afterDash.substring(sep + 2);
      return <>
        <span>{indentStr}</span>
        <span className="yaml-punctuation">{"- "}</span>
        <span className="yaml-key">{key}</span>
        <span className="yaml-punctuation">{": "}</span>
        {highlightYamlValue(value)}
      </>;
    }
    return <>
      <span>{indentStr}</span>
      <span className="yaml-punctuation">{"- "}</span>
      {highlightYamlValue(afterDash)}
    </>;
  }

  // key: value  or  key:
  const sep = trimmed.indexOf(": ");
  if (sep !== -1) {
    const key = trimmed.substring(0, sep);
    const value = trimmed.substring(sep + 2);
    return <>
      <span>{indentStr}</span>
      <span className="yaml-key">{key}</span>
      <span className="yaml-punctuation">{": "}</span>
      {highlightYamlValue(value)}
    </>;
  }
  if (trimmed.endsWith(":")) {
    const key = trimmed.substring(0, trimmed.length - 1);
    return <>
      <span>{indentStr}</span>
      <span className="yaml-key">{key}</span>
      <span className="yaml-punctuation">{":"}</span>
    </>;
  }

  return <span>{line}</span>;
}

function YamlView({ yaml }: { yaml: LoadState<string> }) {
  const [collapsedLines, setCollapsedLines] = useState<Set<number>>(new Set());

  const lines = useMemo(() => yaml.data?.split("\n") ?? [], [yaml.data]);
  const collapsible = useMemo(() => findCollapsibleLines(lines), [lines]);
  const skipped = useMemo(() => getSkippedLines(lines, collapsedLines), [lines, collapsedLines]);

  useEffect(() => {
    setCollapsedLines(findDefaultCollapsed(lines));
  }, [yaml.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleLine = (i: number) => {
    setCollapsedLines((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  if (yaml.status === "loading" && !yaml.data) {
    return (
      <div className="table-placeholder">
        <Loader2 className="spin" size={24} />
        <span>Loading YAML...</span>
      </div>
    );
  }

  if (yaml.status === "error") {
    return (
      <EmptyState
        icon={<CircleAlert size={28} />}
        title="YAML unavailable"
        detail={yaml.message}
      />
    );
  }

  if (!yaml.data) {
    return (
      <div className="yaml-panel">
        <span className="yaml-value">No YAML loaded.</span>
      </div>
    );
  }

  return (
    <div className="yaml-panel" aria-label="Read-only Kubernetes YAML">
      {lines.map((line, i) => {
        if (skipped.has(i)) return null;
        const isCollapsible = collapsible.has(i);
        const isCollapsed = collapsedLines.has(i);
        return (
          <div key={i} className="yaml-line">
            <span className="yaml-gutter">
              {isCollapsible && (
                <button
                  className="yaml-toggle"
                  onClick={() => toggleLine(i)}
                  aria-label={isCollapsed ? "Expand section" : "Collapse section"}
                >
                  {isCollapsed ? <ChevronRight size={9} /> : <ChevronDown size={9} />}
                </button>
              )}
            </span>
            <span className="yaml-line-text">
              {highlightYamlLine(line)}
              {isCollapsed && <span className="yaml-ellipsis"> …</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function renderLogLine(line: string) {
  const timestampPattern = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/g;
  const parts = line.split(timestampPattern);

  return parts.map((part, index) =>
    timestampPattern.test(part) ? (
      <span className="log-date" key={`${part}-${index}`}>
        {part}
      </span>
    ) : (
      <span key={`${part}-${index}`}>{part}</span>
    )
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function MetadataList({ title, values }: { title: string; values: KeyValue[] }) {
  return (
    <div className="metadata-list">
      <h3>{title}</h3>
      {values.length === 0 ? (
        <span className="muted">No {title.toLowerCase()}</span>
      ) : (
        values.map((item) => (
          <code key={`${item.key}-${item.value}`}>
            {item.key}: {item.value}
          </code>
        ))
      )}
    </div>
  );
}

function DetailsTable({
  empty,
  headers,
  onRowClick,
  rows
}: {
  empty: string;
  headers: string[];
  onRowClick?: (index: number) => void;
  rows: React.ReactNode[][];
}) {
  return (
    <table className="details-table">
      <thead>
        <tr>
          {headers.map((header) => (
            <th key={header}>{header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td className="empty-row" colSpan={headers.length}>
              {empty}
            </td>
          </tr>
        ) : (
          rows.map((row, rowIndex) => (
            <tr
              className={onRowClick ? "clickable-row" : ""}
              key={rowIndex}
              onClick={() => onRowClick?.(rowIndex)}
            >
              {row.map((cell, cellIndex) => (
                <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

function EmptyState({
  detail,
  icon,
  title
}: {
  detail: string;
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{detail}</p>
    </div>
  );
}

function iconForKind(kind: string) {
  if (["Deployment", "StatefulSet", "DaemonSet"].includes(kind)) {
    return <Server size={15} />;
  }

  if (["Service", "Ingress"].includes(kind)) {
    return <ShieldCheck size={15} />;
  }

  if (["ConfigMap", "Secret", "PersistentVolumeClaim"].includes(kind)) {
    return <Database size={15} />;
  }

  return <Layers3 size={15} />;
}

function supportsLogs(resource: ResourceSummary) {
  return ["Deployment", "StatefulSet", "DaemonSet", "Pod"].includes(resource.kind);
}

function hasMeaningfulResourceValue(value: string) {
  return !["", "-", "0", "0m", "0.00", "0.00Mi", "0.00Gi"].includes(value.trim());
}

function faviconUrlForCrdGroup(group: string) {
  return `https://www.google.com/s2/favicons?domain=${rootDomain(group)}&sz=32`;
}

function rootDomain(domain: string) {
  const parts = domain.split(".").filter(Boolean);

  if (parts.length <= 2) {
    return domain;
  }

  return parts.slice(-2).join(".");
}

function statusTone(status: string) {
  const normalized = status.toLowerCase();

  if (["running", "active", "bound", "complete", "ready"].includes(normalized)) {
    return "good";
  }

  if (["pending", "progressing", "unknown"].includes(normalized)) {
    return "warn";
  }

  return "bad";
}

function displayContextName(context: string) {
  return context.split("/cluster/").at(-1) ?? context;
}
