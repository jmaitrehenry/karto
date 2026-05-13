use futures_util::{io::AsyncBufReadExt, StreamExt};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use k8s_openapi::{
    api::{
        apps::v1::{DaemonSet, Deployment, StatefulSet},
        batch::v1::{CronJob, Job},
        core::v1::{
            ConfigMap, Event as CoreEvent, Namespace, PersistentVolumeClaim, Pod, Secret, Service,
        },
        networking::v1::Ingress,
    },
    apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition,
};
use kube::{
    api::{Api, ApiResource, DynamicObject, ListParams, LogParams, ResourceExt},
    config::{KubeConfigOptions, Kubeconfig},
    Client, Config, Resource,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    env,
    process::Command,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Serialize)]
struct ClusterContext {
    name: String,
    current: bool,
}

#[derive(Debug, Serialize)]
struct NamespaceSummary {
    name: String,
    status: String,
}

#[derive(Debug, Serialize)]
struct ResourceSummary {
    name: String,
    kind: String,
    namespace: Option<String>,
    ready: Option<String>,
    status: String,
    age: Option<String>,
}

#[derive(Debug, Serialize)]
struct WorkloadDetails {
    name: String,
    kind: String,
    namespace: String,
    age: Option<String>,
    ready: Option<String>,
    status: String,
    images: Vec<String>,
    resource_totals: ResourceTotals,
    labels: Vec<KeyValue>,
    annotations: Vec<KeyValue>,
    pods: Vec<PodDetails>,
    services: Vec<ServiceDetails>,
}

#[derive(Debug, Default, Serialize)]
struct ResourceTotals {
    cpu_requested: String,
    cpu_limited: String,
    memory_requested: String,
    memory_limited: String,
}

#[derive(Debug, Serialize)]
struct KeyValue {
    key: String,
    value: String,
}

#[derive(Debug, Serialize)]
struct PodDetails {
    name: String,
    age: Option<String>,
    containers: String,
    restarts: i32,
    status: String,
}

#[derive(Debug, Serialize)]
struct ServiceDetails {
    name: String,
    service_type: String,
    ports: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct LogLine {
    stream_id: String,
    pod: String,
    container: String,
    line: String,
}

#[derive(Debug, Serialize)]
struct EventSummary {
    event_type: String,
    reason: String,
    message: String,
    count: i32,
    source: String,
    last_seen: String,
}

#[derive(Debug, Serialize)]
struct CrdGroup {
    group: String,
    resources: Vec<CrdResource>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct CrdResource {
    group: String,
    version: String,
    kind: String,
    plural: String,
    scope: String,
    printer_columns: Vec<PrinterColumn>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PrinterColumn {
    name: String,
    json_path: String,
    priority: Option<i32>,
}

#[derive(Debug, Serialize)]
struct CustomResourceTable {
    title: String,
    count: usize,
    columns: Vec<String>,
    rows: Vec<Vec<String>>,
}

#[derive(Default)]
struct LogStreams(Mutex<HashMap<String, Vec<tauri::async_runtime::JoinHandle<()>>>>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ResourceView {
    Applications,
    All,
}

#[tauri::command]
async fn list_contexts() -> Result<Vec<ClusterContext>, String> {
    hydrate_login_shell_environment();
    let kubeconfig = Kubeconfig::read().map_err(read_config_error)?;
    let current = kubeconfig.current_context.clone();

    let mut contexts = kubeconfig
        .contexts
        .into_iter()
        .map(|named_context| {
            let name = named_context.name;
            ClusterContext {
                current: current.as_deref() == Some(name.as_str()),
                name,
            }
        })
        .collect::<Vec<_>>();

    contexts.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(contexts)
}

#[tauri::command]
async fn check_context_connection(context: String) -> Result<(), String> {
    let client = client_for_context(&context).await?;
    client
        .apiserver_version()
        .await
        .map(|_| ())
        .map_err(kube_error)
}

#[tauri::command]
async fn list_namespaces(context: String) -> Result<Vec<NamespaceSummary>, String> {
    let client = client_for_context(&context).await?;
    let api: Api<Namespace> = Api::all(client);
    let list = api.list(&ListParams::default()).await.map_err(kube_error)?;

    let mut namespaces = list
        .items
        .into_iter()
        .map(|namespace| NamespaceSummary {
            name: namespace.name_any(),
            status: namespace
                .status
                .and_then(|status| status.phase)
                .unwrap_or_else(|| "Unknown".to_string()),
        })
        .collect::<Vec<_>>();

    namespaces.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(namespaces)
}

#[tauri::command]
async fn list_resources(
    context: String,
    namespace: String,
    view: ResourceView,
) -> Result<Vec<ResourceSummary>, String> {
    let client = client_for_context(&context).await?;
    let mut resources = Vec::new();
    let all_namespaces = namespace.is_empty();

    append_typed(
        &mut resources,
        if all_namespaces {
            Api::<Deployment>::all(client.clone())
        } else {
            Api::<Deployment>::namespaced(client.clone(), &namespace)
        },
        "Deployment",
        deployment_summary,
    )
    .await?;
    append_typed(
        &mut resources,
        if all_namespaces {
            Api::<StatefulSet>::all(client.clone())
        } else {
            Api::<StatefulSet>::namespaced(client.clone(), &namespace)
        },
        "StatefulSet",
        stateful_set_summary,
    )
    .await?;
    append_typed(
        &mut resources,
        if all_namespaces {
            Api::<DaemonSet>::all(client.clone())
        } else {
            Api::<DaemonSet>::namespaced(client.clone(), &namespace)
        },
        "DaemonSet",
        daemon_set_summary,
    )
    .await?;
    append_typed(
        &mut resources,
        if all_namespaces {
            Api::<Job>::all(client.clone())
        } else {
            Api::<Job>::namespaced(client.clone(), &namespace)
        },
        "Job",
        job_summary,
    )
    .await?;
    append_typed(
        &mut resources,
        if all_namespaces {
            Api::<CronJob>::all(client.clone())
        } else {
            Api::<CronJob>::namespaced(client.clone(), &namespace)
        },
        "CronJob",
        cron_job_summary,
    )
    .await?;

    if matches!(view, ResourceView::All) {
        append_typed(
            &mut resources,
            if all_namespaces {
                Api::<Pod>::all(client.clone())
            } else {
                Api::<Pod>::namespaced(client.clone(), &namespace)
            },
            "Pod",
            pod_summary,
        )
        .await?;
        append_typed(
            &mut resources,
            if all_namespaces {
                Api::<Service>::all(client.clone())
            } else {
                Api::<Service>::namespaced(client.clone(), &namespace)
            },
            "Service",
            simple_active_summary,
        )
        .await?;
        append_typed(
            &mut resources,
            if all_namespaces {
                Api::<Ingress>::all(client.clone())
            } else {
                Api::<Ingress>::namespaced(client.clone(), &namespace)
            },
            "Ingress",
            simple_active_summary,
        )
        .await?;
        append_typed(
            &mut resources,
            if all_namespaces {
                Api::<ConfigMap>::all(client.clone())
            } else {
                Api::<ConfigMap>::namespaced(client.clone(), &namespace)
            },
            "ConfigMap",
            simple_active_summary,
        )
        .await?;
        append_typed(
            &mut resources,
            if all_namespaces {
                Api::<Secret>::all(client.clone())
            } else {
                Api::<Secret>::namespaced(client.clone(), &namespace)
            },
            "Secret",
            simple_active_summary,
        )
        .await?;
        append_typed(
            &mut resources,
            if all_namespaces {
                Api::<PersistentVolumeClaim>::all(client)
            } else {
                Api::<PersistentVolumeClaim>::namespaced(client, &namespace)
            },
            "PersistentVolumeClaim",
            pvc_summary,
        )
        .await?;
    }

    resources.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.namespace.cmp(&right.namespace))
            .then_with(|| left.name.cmp(&right.name))
    });

    Ok(resources)
}

#[tauri::command]
async fn list_crds(context: String) -> Result<Vec<CrdGroup>, String> {
    let client = client_for_context(&context).await?;
    let api: Api<CustomResourceDefinition> = Api::all(client);
    let list = api.list(&ListParams::default()).await.map_err(kube_error)?;
    let mut groups: BTreeMap<String, Vec<CrdResource>> = BTreeMap::new();

    for crd in list.items {
        let Some(version) = crd
            .spec
            .versions
            .iter()
            .find(|version| version.served && version.storage)
            .or_else(|| crd.spec.versions.iter().find(|version| version.served))
        else {
            continue;
        };

        groups
            .entry(crd.spec.group.clone())
            .or_default()
            .push(CrdResource {
                group: crd.spec.group.clone(),
                version: version.name.clone(),
                kind: crd.spec.names.kind.clone(),
                plural: crd.spec.names.plural.clone(),
                scope: crd.spec.scope.clone(),
                printer_columns: version
                    .additional_printer_columns
                    .clone()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|column| column.priority.unwrap_or(0) == 0)
                    .map(|column| PrinterColumn {
                        name: column.name,
                        json_path: column.json_path,
                        priority: column.priority,
                    })
                    .collect(),
            });
    }

    Ok(groups
        .into_iter()
        .map(|(group, mut resources)| {
            resources.sort_by(|left, right| left.kind.cmp(&right.kind));
            CrdGroup { group, resources }
        })
        .collect())
}

#[tauri::command]
async fn list_custom_resources(
    context: String,
    resource: CrdResource,
) -> Result<CustomResourceTable, String> {
    let client = client_for_context(&context).await?;
    let api_resource = ApiResource {
        group: resource.group.clone(),
        version: resource.version.clone(),
        api_version: format!("{}/{}", resource.group, resource.version),
        kind: resource.kind.clone(),
        plural: resource.plural.clone(),
    };
    let api: Api<DynamicObject> = Api::all_with(client, &api_resource);
    let list = api.list(&ListParams::default()).await.map_err(kube_error)?;
    let mut rows = list
        .items
        .into_iter()
        .map(|object| custom_resource_row(&resource, object))
        .collect::<Vec<_>>();
    let columns = custom_resource_columns(&resource);

    rows.sort_by(|left, right| {
        left.first()
            .cmp(&right.first())
            .then_with(|| left.get(1).cmp(&right.get(1)))
    });

    Ok(CustomResourceTable {
        title: resource.kind,
        count: rows.len(),
        columns,
        rows,
    })
}

#[tauri::command]
async fn get_custom_resource_details(
    context: String,
    resource: CrdResource,
    namespace: String,
    name: String,
) -> Result<WorkloadDetails, String> {
    let client = client_for_context(&context).await?;
    let api_resource = ApiResource {
        group: resource.group.clone(),
        version: resource.version.clone(),
        api_version: format!("{}/{}", resource.group, resource.version),
        kind: resource.kind.clone(),
        plural: resource.plural.clone(),
    };
    let api: Api<DynamicObject> = if resource.scope == "Namespaced" && !namespace.is_empty() {
        Api::namespaced_with(client, &namespace, &api_resource)
    } else {
        Api::all_with(client, &api_resource)
    };
    let object = api.get(&name).await.map_err(kube_error)?;
    let labels = object.meta().labels.clone().unwrap_or_default();
    let annotations = object.meta().annotations.clone().unwrap_or_default();

    Ok(WorkloadDetails {
        name: object.name_any(),
        kind: resource.kind.clone(),
        namespace,
        age: age_for(&object),
        ready: None,
        status: "Active".to_string(),
        images: Vec::new(),
        resource_totals: ResourceTotals::default(),
        labels: key_values(labels),
        annotations: key_values(annotations),
        pods: Vec::new(),
        services: Vec::new(),
    })
}

#[tauri::command]
async fn get_custom_resource_yaml(
    context: String,
    resource: CrdResource,
    namespace: String,
    name: String,
) -> Result<String, String> {
    let client = client_for_context(&context).await?;
    let api_resource = ApiResource {
        group: resource.group.clone(),
        version: resource.version.clone(),
        api_version: format!("{}/{}", resource.group, resource.version),
        kind: resource.kind.clone(),
        plural: resource.plural.clone(),
    };
    let api: Api<DynamicObject> = if resource.scope == "Namespaced" && !namespace.is_empty() {
        Api::namespaced_with(client, &namespace, &api_resource)
    } else {
        Api::all_with(client, &api_resource)
    };
    let object = api.get(&name).await.map_err(kube_error)?;
    serde_yaml::to_string(&object).map_err(|error| error.to_string())
}

#[tauri::command]
async fn get_workload_details(
    context: String,
    namespace: String,
    kind: String,
    name: String,
) -> Result<WorkloadDetails, String> {
    let client = client_for_context(&context).await?;

    match kind.as_str() {
        "Deployment" => {
            let api: Api<Deployment> = Api::namespaced(client.clone(), &namespace);
            let deployment = api.get(&name).await.map_err(kube_error)?;
            workload_details_from_deployment(client, namespace, deployment).await
        }
        "StatefulSet" => {
            let api: Api<StatefulSet> = Api::namespaced(client.clone(), &namespace);
            let stateful_set = api.get(&name).await.map_err(kube_error)?;
            workload_details_from_stateful_set(client, namespace, stateful_set).await
        }
        "DaemonSet" => {
            let api: Api<DaemonSet> = Api::namespaced(client.clone(), &namespace);
            let daemon_set = api.get(&name).await.map_err(kube_error)?;
            workload_details_from_daemon_set(client, namespace, daemon_set).await
        }
        "Job" => {
            let api: Api<Job> = Api::namespaced(client, &namespace);
            let job = api.get(&name).await.map_err(kube_error)?;
            let status = job_summary(job.clone(), "Job").status;
            Ok(generic_details(job, "Job", namespace, &status, None))
        }
        "CronJob" => {
            let api: Api<CronJob> = Api::namespaced(client, &namespace);
            let cron_job = api.get(&name).await.map_err(kube_error)?;
            Ok(generic_details(
                cron_job, "CronJob", namespace, "Active", None,
            ))
        }
        "Pod" => {
            let api: Api<Pod> = Api::namespaced(client, &namespace);
            let pod = api.get(&name).await.map_err(kube_error)?;
            let status = pod_summary(pod.clone(), "Pod").status;
            Ok(pod_details(pod, namespace, &status))
        }
        "Service" => {
            let api: Api<Service> = Api::namespaced(client, &namespace);
            let service = api.get(&name).await.map_err(kube_error)?;
            Ok(generic_details(
                service, "Service", namespace, "Active", None,
            ))
        }
        "Ingress" => {
            let api: Api<Ingress> = Api::namespaced(client, &namespace);
            let ingress = api.get(&name).await.map_err(kube_error)?;
            Ok(generic_details(
                ingress, "Ingress", namespace, "Active", None,
            ))
        }
        "ConfigMap" => {
            let api: Api<ConfigMap> = Api::namespaced(client, &namespace);
            let config_map = api.get(&name).await.map_err(kube_error)?;
            Ok(generic_details(
                config_map,
                "ConfigMap",
                namespace,
                "Active",
                None,
            ))
        }
        "Secret" => {
            let api: Api<Secret> = Api::namespaced(client, &namespace);
            let secret = api.get(&name).await.map_err(kube_error)?;
            Ok(generic_details(secret, "Secret", namespace, "Active", None))
        }
        "PersistentVolumeClaim" => {
            let api: Api<PersistentVolumeClaim> = Api::namespaced(client, &namespace);
            let pvc = api.get(&name).await.map_err(kube_error)?;
            let status = pvc_summary(pvc.clone(), "PersistentVolumeClaim").status;
            Ok(generic_details(
                pvc,
                "PersistentVolumeClaim",
                namespace,
                &status,
                None,
            ))
        }
        _ => Err(format!(
            "Details are not available for kind `{}` yet.",
            kind
        )),
    }
}

#[tauri::command]
async fn start_workload_log_stream(
    app: AppHandle,
    streams: State<'_, LogStreams>,
    context: String,
    namespace: String,
    kind: String,
    name: String,
    stream_id: String,
) -> Result<(), String> {
    abort_log_stream(&streams, &stream_id);

    let client = client_for_context(&context).await?;
    let pods_api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
    let pods = if kind == "Pod" {
        vec![pods_api.get(&name).await.map_err(kube_error)?]
    } else {
        let selector = workload_selector(client.clone(), &namespace, &kind, &name).await?;
        pods_api
            .list(&ListParams::default().labels(&label_selector(&selector)))
            .await
            .map(|list| list.items)
            .map_err(kube_error)?
    };
    let mut handles = Vec::new();

    for pod in pods {
        let pod_name = pod.name_any();
        let container_names = pod
            .spec
            .as_ref()
            .map(|spec| {
                spec.containers
                    .iter()
                    .map(|container| container.name.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        for container_name in container_names {
            let pod_api = pods_api.clone();
            let app_handle = app.clone();
            let stream_id = stream_id.clone();
            let pod_name = pod_name.clone();
            let handle = tauri::async_runtime::spawn(async move {
                let params = LogParams {
                    container: Some(container_name.clone()),
                    follow: true,
                    tail_lines: Some(200),
                    timestamps: true,
                    ..LogParams::default()
                };

                match pod_api.log_stream(&pod_name, &params).await {
                    Ok(reader) => {
                        let mut lines = reader.lines();

                        while let Some(next_line) = lines.next().await {
                            match next_line {
                                Ok(line) => {
                                    let _ = app_handle.emit(
                                        "workload-log",
                                        LogLine {
                                            stream_id: stream_id.clone(),
                                            pod: pod_name.clone(),
                                            container: container_name.clone(),
                                            line,
                                        },
                                    );
                                }
                                Err(error) => {
                                    let _ = app_handle.emit(
                                        "workload-log",
                                        LogLine {
                                            stream_id: stream_id.clone(),
                                            pod: pod_name.clone(),
                                            container: container_name.clone(),
                                            line: format!("log stream error: {}", error),
                                        },
                                    );
                                    break;
                                }
                            }
                        }
                    }
                    Err(error) => {
                        let _ = app_handle.emit(
                            "workload-log",
                            LogLine {
                                stream_id,
                                pod: pod_name,
                                container: container_name,
                                line: format!("unable to open log stream: {}", error),
                            },
                        );
                    }
                }
            });
            handles.push(handle);
        }
    }

    streams
        .0
        .lock()
        .map_err(|_| "Unable to lock log stream registry.".to_string())?
        .insert(stream_id, handles);

    Ok(())
}

#[tauri::command]
fn stop_log_stream(streams: State<'_, LogStreams>, stream_id: String) -> Result<(), String> {
    abort_log_stream(&streams, &stream_id);
    Ok(())
}

#[tauri::command]
async fn list_workload_events(
    context: String,
    namespace: String,
    kind: String,
    name: String,
) -> Result<Vec<EventSummary>, String> {
    let client = client_for_context(&context).await?;
    let api: Api<CoreEvent> = Api::namespaced(client, &namespace);
    let selector = format!("involvedObject.kind={},involvedObject.name={}", kind, name);
    let list = api
        .list(&ListParams::default().fields(&selector))
        .await
        .map_err(kube_error)?;
    let mut events = list
        .items
        .into_iter()
        .map(event_summary)
        .collect::<Vec<_>>();

    events.sort_by(|left, right| right.last_seen.cmp(&left.last_seen));
    Ok(events)
}

#[tauri::command]
async fn get_workload_yaml(
    context: String,
    namespace: String,
    kind: String,
    name: String,
) -> Result<String, String> {
    let client = client_for_context(&context).await?;

    match kind.as_str() {
        "Deployment" => {
            let api: Api<Deployment> = Api::namespaced(client, &namespace);
            let deployment = api.get(&name).await.map_err(kube_error)?;
            serde_yaml::to_string(&deployment).map_err(|error| error.to_string())
        }
        "StatefulSet" => {
            let api: Api<StatefulSet> = Api::namespaced(client, &namespace);
            let stateful_set = api.get(&name).await.map_err(kube_error)?;
            serde_yaml::to_string(&stateful_set).map_err(|error| error.to_string())
        }
        "DaemonSet" => {
            let api: Api<DaemonSet> = Api::namespaced(client, &namespace);
            let daemon_set = api.get(&name).await.map_err(kube_error)?;
            serde_yaml::to_string(&daemon_set).map_err(|error| error.to_string())
        }
        "Job" => {
            let api: Api<Job> = Api::namespaced(client, &namespace);
            let job = api.get(&name).await.map_err(kube_error)?;
            serde_yaml::to_string(&job).map_err(|error| error.to_string())
        }
        "CronJob" => {
            let api: Api<CronJob> = Api::namespaced(client, &namespace);
            let cron_job = api.get(&name).await.map_err(kube_error)?;
            serde_yaml::to_string(&cron_job).map_err(|error| error.to_string())
        }
        "Pod" => {
            let api: Api<Pod> = Api::namespaced(client, &namespace);
            let pod = api.get(&name).await.map_err(kube_error)?;
            serde_yaml::to_string(&pod).map_err(|error| error.to_string())
        }
        "Service" => {
            let api: Api<Service> = Api::namespaced(client, &namespace);
            let service = api.get(&name).await.map_err(kube_error)?;
            serde_yaml::to_string(&service).map_err(|error| error.to_string())
        }
        "Ingress" => {
            let api: Api<Ingress> = Api::namespaced(client, &namespace);
            let ingress = api.get(&name).await.map_err(kube_error)?;
            serde_yaml::to_string(&ingress).map_err(|error| error.to_string())
        }
        "ConfigMap" => {
            let api: Api<ConfigMap> = Api::namespaced(client, &namespace);
            let config_map = api.get(&name).await.map_err(kube_error)?;
            serde_yaml::to_string(&config_map).map_err(|error| error.to_string())
        }
        "Secret" => {
            let api: Api<Secret> = Api::namespaced(client, &namespace);
            let secret = api.get(&name).await.map_err(kube_error)?;
            serde_yaml::to_string(&secret).map_err(|error| error.to_string())
        }
        "PersistentVolumeClaim" => {
            let api: Api<PersistentVolumeClaim> = Api::namespaced(client, &namespace);
            let pvc = api.get(&name).await.map_err(kube_error)?;
            serde_yaml::to_string(&pvc).map_err(|error| error.to_string())
        }
        _ => Err(format!("YAML is not available for kind `{}` yet.", kind)),
    }
}

async fn client_for_context(context: &str) -> Result<Client, String> {
    hydrate_login_shell_environment();
    let options = KubeConfigOptions {
        context: Some(context.to_string()),
        ..KubeConfigOptions::default()
    };
    let config = Config::from_kubeconfig(&options)
        .await
        .map_err(|error| format!("Unable to load kube context `{}`: {}", context, error))?;

    Client::try_from(config)
        .map_err(|error| format!("Unable to create Kubernetes API client: {}", error))
}

fn hydrate_login_shell_environment() {
    static IMPORTED: OnceLock<()> = OnceLock::new();

    IMPORTED.get_or_init(|| {
        let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let shell = if shell.trim().is_empty() {
            "/bin/zsh"
        } else {
            shell.as_str()
        };

        let Ok(output) = Command::new(shell)
            .args([
                "-lc",
                "printf '%s\\0%s\\0%s' \"$HOME\" \"$KUBECONFIG\" \"$PATH\"",
            ])
            .output()
        else {
            return;
        };

        if !output.status.success() {
            return;
        }

        let values = output
            .stdout
            .split(|byte| *byte == 0)
            .map(|value| String::from_utf8_lossy(value).trim().to_string())
            .collect::<Vec<_>>();

        set_env_if_present("HOME", values.first());
        set_env_if_present("KUBECONFIG", values.get(1));
        set_env_if_present("PATH", values.get(2));
    });
}

fn set_env_if_present(key: &str, value: Option<&String>) {
    let Some(value) = value else {
        return;
    };

    if value.is_empty() {
        return;
    }

    env::set_var(key, value);
}

async fn append_typed<K, F>(
    resources: &mut Vec<ResourceSummary>,
    api: Api<K>,
    kind: &'static str,
    summarize: F,
) -> Result<(), String>
where
    K: Clone + std::fmt::Debug + kube::Resource<DynamicType = ()> + serde::de::DeserializeOwned,
    F: Fn(K, &'static str) -> ResourceSummary,
{
    let list = api.list(&ListParams::default()).await.map_err(kube_error)?;
    resources.extend(list.items.into_iter().map(|item| summarize(item, kind)));
    Ok(())
}

fn deployment_summary(item: Deployment, kind: &'static str) -> ResourceSummary {
    let ready = item
        .status
        .as_ref()
        .and_then(|status| status.ready_replicas)
        .unwrap_or(0);
    let desired = item
        .spec
        .as_ref()
        .and_then(|spec| spec.replicas)
        .unwrap_or(0);

    workload_summary(item, kind, ready, desired)
}

fn stateful_set_summary(item: StatefulSet, kind: &'static str) -> ResourceSummary {
    let ready = item
        .status
        .as_ref()
        .and_then(|status| status.ready_replicas)
        .unwrap_or(0);
    let desired = item
        .spec
        .as_ref()
        .and_then(|spec| spec.replicas)
        .unwrap_or(0);

    workload_summary(item, kind, ready, desired)
}

async fn workload_details_from_deployment(
    client: Client,
    namespace: String,
    deployment: Deployment,
) -> Result<WorkloadDetails, String> {
    let labels = deployment.meta().labels.clone().unwrap_or_default();
    let annotations = deployment.meta().annotations.clone().unwrap_or_default();
    let selector = deployment
        .spec
        .as_ref()
        .and_then(|spec| spec.selector.match_labels.clone())
        .unwrap_or_default();
    let template_labels = deployment
        .spec
        .as_ref()
        .and_then(|spec| spec.template.metadata.as_ref())
        .and_then(|metadata| metadata.labels.clone())
        .unwrap_or_default();
    let images = deployment
        .spec
        .as_ref()
        .and_then(|spec| spec.template.spec.as_ref())
        .map(container_images)
        .unwrap_or_default();
    let resource_totals = deployment
        .spec
        .as_ref()
        .and_then(|spec| spec.template.spec.as_ref())
        .map(resource_totals)
        .unwrap_or_default();
    let ready = deployment
        .status
        .as_ref()
        .and_then(|status| status.ready_replicas)
        .unwrap_or(0);
    let desired = deployment
        .spec
        .as_ref()
        .and_then(|spec| spec.replicas)
        .unwrap_or(0);
    let status = if ready == desired && desired > 0 {
        "Running"
    } else {
        "Progressing"
    };

    Ok(WorkloadDetails {
        name: deployment.name_any(),
        kind: "Deployment".to_string(),
        namespace: namespace.clone(),
        age: age_for(&deployment),
        ready: Some(format!("{}/{}", ready, desired)),
        status: status.to_string(),
        images,
        resource_totals,
        labels: key_values(labels),
        annotations: key_values(annotations),
        pods: pods_for(client.clone(), &namespace, &selector).await?,
        services: services_for(client, &namespace, &template_labels).await?,
    })
}

async fn workload_details_from_stateful_set(
    client: Client,
    namespace: String,
    stateful_set: StatefulSet,
) -> Result<WorkloadDetails, String> {
    let labels = stateful_set.meta().labels.clone().unwrap_or_default();
    let annotations = stateful_set.meta().annotations.clone().unwrap_or_default();
    let selector = stateful_set
        .spec
        .as_ref()
        .and_then(|spec| spec.selector.match_labels.clone())
        .unwrap_or_default();
    let template_labels = stateful_set
        .spec
        .as_ref()
        .and_then(|spec| spec.template.metadata.as_ref())
        .and_then(|metadata| metadata.labels.clone())
        .unwrap_or_default();
    let images = stateful_set
        .spec
        .as_ref()
        .and_then(|spec| spec.template.spec.as_ref())
        .map(container_images)
        .unwrap_or_default();
    let resource_totals = stateful_set
        .spec
        .as_ref()
        .and_then(|spec| spec.template.spec.as_ref())
        .map(resource_totals)
        .unwrap_or_default();
    let ready = stateful_set
        .status
        .as_ref()
        .and_then(|status| status.ready_replicas)
        .unwrap_or(0);
    let desired = stateful_set
        .spec
        .as_ref()
        .and_then(|spec| spec.replicas)
        .unwrap_or(0);
    let status = if ready == desired && desired > 0 {
        "Running"
    } else {
        "Progressing"
    };

    Ok(WorkloadDetails {
        name: stateful_set.name_any(),
        kind: "StatefulSet".to_string(),
        namespace: namespace.clone(),
        age: age_for(&stateful_set),
        ready: Some(format!("{}/{}", ready, desired)),
        status: status.to_string(),
        images,
        resource_totals,
        labels: key_values(labels),
        annotations: key_values(annotations),
        pods: pods_for(client.clone(), &namespace, &selector).await?,
        services: services_for(client, &namespace, &template_labels).await?,
    })
}

async fn workload_details_from_daemon_set(
    client: Client,
    namespace: String,
    daemon_set: DaemonSet,
) -> Result<WorkloadDetails, String> {
    let labels = daemon_set.meta().labels.clone().unwrap_or_default();
    let annotations = daemon_set.meta().annotations.clone().unwrap_or_default();
    let selector = daemon_set
        .spec
        .as_ref()
        .and_then(|spec| spec.selector.match_labels.clone())
        .unwrap_or_default();
    let template_labels = daemon_set
        .spec
        .as_ref()
        .and_then(|spec| spec.template.metadata.as_ref())
        .and_then(|metadata| metadata.labels.clone())
        .unwrap_or_default();
    let images = daemon_set
        .spec
        .as_ref()
        .and_then(|spec| spec.template.spec.as_ref())
        .map(container_images)
        .unwrap_or_default();
    let resource_totals = daemon_set
        .spec
        .as_ref()
        .and_then(|spec| spec.template.spec.as_ref())
        .map(resource_totals)
        .unwrap_or_default();
    let ready = daemon_set
        .status
        .as_ref()
        .map(|status| status.number_ready)
        .unwrap_or(0);
    let desired = daemon_set
        .status
        .as_ref()
        .map(|status| status.desired_number_scheduled)
        .unwrap_or(0);
    let status = if ready == desired && desired > 0 {
        "Running"
    } else {
        "Progressing"
    };

    Ok(WorkloadDetails {
        name: daemon_set.name_any(),
        kind: "DaemonSet".to_string(),
        namespace: namespace.clone(),
        age: age_for(&daemon_set),
        ready: Some(format!("{}/{}", ready, desired)),
        status: status.to_string(),
        images,
        resource_totals,
        labels: key_values(labels),
        annotations: key_values(annotations),
        pods: pods_for(client.clone(), &namespace, &selector).await?,
        services: services_for(client, &namespace, &template_labels).await?,
    })
}

fn pod_details(pod: Pod, namespace: String, status: &str) -> WorkloadDetails {
    let labels = pod.meta().labels.clone().unwrap_or_default();
    let annotations = pod.meta().annotations.clone().unwrap_or_default();

    let container_statuses = pod
        .status
        .as_ref()
        .and_then(|s| s.container_statuses.as_ref())
        .cloned()
        .unwrap_or_default();

    let init_container_statuses = pod
        .status
        .as_ref()
        .and_then(|s| s.init_container_statuses.as_ref())
        .cloned()
        .unwrap_or_default();

    let all_statuses = init_container_statuses
        .iter()
        .chain(container_statuses.iter());

    let containers = all_statuses
        .map(|cs| {
            let ready = if cs.ready { "1/1" } else { "0/1" }.to_string();
            let container_status = if let Some(state) = &cs.state {
                if state.running.is_some() {
                    "Running".to_string()
                } else if let Some(terminated) = &state.terminated {
                    terminated
                        .reason
                        .clone()
                        .unwrap_or_else(|| "Terminated".to_string())
                } else if let Some(waiting) = &state.waiting {
                    waiting
                        .reason
                        .clone()
                        .unwrap_or_else(|| "Waiting".to_string())
                } else {
                    "Unknown".to_string()
                }
            } else {
                "Unknown".to_string()
            };
            PodDetails {
                name: cs.name.clone(),
                age: None,
                containers: ready,
                restarts: cs.restart_count,
                status: container_status,
            }
        })
        .collect();

    WorkloadDetails {
        name: pod.name_any(),
        kind: "Pod".to_string(),
        namespace,
        age: age_for(&pod),
        ready: None,
        status: status.to_string(),
        images: Vec::new(),
        resource_totals: ResourceTotals::default(),
        labels: key_values(labels),
        annotations: key_values(annotations),
        pods: containers,
        services: Vec::new(),
    }
}

fn generic_details<K>(
    item: K,
    kind: &str,
    namespace: String,
    status: &str,
    ready: Option<String>,
) -> WorkloadDetails
where
    K: ResourceExt,
{
    let labels = item.meta().labels.clone().unwrap_or_default();
    let annotations = item.meta().annotations.clone().unwrap_or_default();

    WorkloadDetails {
        name: item.name_any(),
        kind: kind.to_string(),
        namespace,
        age: age_for(&item),
        ready,
        status: status.to_string(),
        images: Vec::new(),
        resource_totals: ResourceTotals::default(),
        labels: key_values(labels),
        annotations: key_values(annotations),
        pods: Vec::new(),
        services: Vec::new(),
    }
}

async fn pods_for(
    client: Client,
    namespace: &str,
    selector: &BTreeMap<String, String>,
) -> Result<Vec<PodDetails>, String> {
    if selector.is_empty() {
        return Ok(Vec::new());
    }

    let api: Api<Pod> = Api::namespaced(client, namespace);
    let list = api
        .list(&ListParams::default().labels(&label_selector(selector)))
        .await
        .map_err(kube_error)?;

    let mut pods = list
        .items
        .into_iter()
        .map(|pod| {
            let statuses = pod
                .status
                .as_ref()
                .and_then(|status| status.container_statuses.as_ref());
            let ready = statuses
                .map(|statuses| statuses.iter().filter(|status| status.ready).count())
                .unwrap_or(0);
            let total = statuses.map(Vec::len).unwrap_or(0);
            let restarts = statuses
                .map(|statuses| statuses.iter().map(|status| status.restart_count).sum())
                .unwrap_or(0);
            let status = pod
                .status
                .as_ref()
                .and_then(|status| status.phase.clone())
                .unwrap_or_else(|| "Unknown".to_string());

            PodDetails {
                name: pod.name_any(),
                age: age_for(&pod),
                containers: format!("{}/{}", ready, total),
                restarts,
                status,
            }
        })
        .collect::<Vec<_>>();

    pods.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(pods)
}

async fn services_for(
    client: Client,
    namespace: &str,
    template_labels: &BTreeMap<String, String>,
) -> Result<Vec<ServiceDetails>, String> {
    let api: Api<Service> = Api::namespaced(client, namespace);
    let list = api.list(&ListParams::default()).await.map_err(kube_error)?;

    let mut services = list
        .items
        .into_iter()
        .filter(|service| {
            service
                .spec
                .as_ref()
                .and_then(|spec| spec.selector.as_ref())
                .is_some_and(|selector| selector_matches_labels(selector, template_labels))
        })
        .map(|service| {
            let spec = service.spec.as_ref();
            ServiceDetails {
                name: service.name_any(),
                service_type: spec
                    .and_then(|spec| spec.type_.clone())
                    .unwrap_or_else(|| "ClusterIP".to_string()),
                ports: spec
                    .and_then(|spec| spec.ports.as_ref())
                    .map(|ports| {
                        ports
                            .iter()
                            .map(|port| {
                                let target = port
                                    .target_port
                                    .as_ref()
                                    .map(|target| format!(" -> {}", format_int_or_string(target)))
                                    .unwrap_or_default();
                                let name = port
                                    .name
                                    .as_ref()
                                    .map(|name| format!(" {}", name))
                                    .unwrap_or_default();
                                format!("{}{}{}", port.port, target, name)
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            }
        })
        .collect::<Vec<_>>();

    services.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(services)
}

async fn workload_selector(
    client: Client,
    namespace: &str,
    kind: &str,
    name: &str,
) -> Result<BTreeMap<String, String>, String> {
    match kind {
        "Deployment" => {
            let api: Api<Deployment> = Api::namespaced(client, namespace);
            let deployment = api.get(name).await.map_err(kube_error)?;
            Ok(deployment
                .spec
                .and_then(|spec| spec.selector.match_labels)
                .unwrap_or_default())
        }
        "StatefulSet" => {
            let api: Api<StatefulSet> = Api::namespaced(client, namespace);
            let stateful_set = api.get(name).await.map_err(kube_error)?;
            Ok(stateful_set
                .spec
                .and_then(|spec| spec.selector.match_labels)
                .unwrap_or_default())
        }
        "DaemonSet" => {
            let api: Api<DaemonSet> = Api::namespaced(client, namespace);
            let daemon_set = api.get(name).await.map_err(kube_error)?;
            Ok(daemon_set
                .spec
                .and_then(|spec| spec.selector.match_labels)
                .unwrap_or_default())
        }
        _ => Err(format!("Logs are not available for kind `{}` yet.", kind)),
    }
}

fn abort_log_stream(streams: &State<'_, LogStreams>, stream_id: &str) {
    let Ok(mut streams) = streams.0.lock() else {
        return;
    };

    if let Some(handles) = streams.remove(stream_id) {
        for handle in handles {
            handle.abort();
        }
    }
}

fn event_summary(event: CoreEvent) -> EventSummary {
    let source = event
        .reporting_component
        .clone()
        .or_else(|| {
            event
                .source
                .as_ref()
                .and_then(|source| source.component.clone())
        })
        .unwrap_or_else(|| "-".to_string());
    let last_seen = event
        .last_timestamp
        .as_ref()
        .map(|time| age(time.0.timestamp()))
        .or_else(|| event.event_time.as_ref().map(|time| age(time.0.timestamp())))
        .or_else(|| {
            event
                .first_timestamp
                .as_ref()
                .map(|time| age(time.0.timestamp()))
        })
        .unwrap_or_else(|| "-".to_string());

    EventSummary {
        event_type: event.type_.unwrap_or_else(|| "Normal".to_string()),
        reason: event.reason.unwrap_or_else(|| "-".to_string()),
        message: event.message.unwrap_or_else(|| "-".to_string()),
        count: event.count.unwrap_or(1),
        source,
        last_seen,
    }
}

fn custom_resource_columns(resource: &CrdResource) -> Vec<String> {
    let mut columns = if resource.scope == "Namespaced" {
        vec!["Namespace".to_string(), "Name".to_string()]
    } else {
        vec!["Name".to_string()]
    };

    columns.extend(
        resource
            .printer_columns
            .iter()
            .filter(|column| column.name.to_lowercase() != "age")
            .map(|column| column.name.clone()),
    );
    columns.push("Age".to_string());
    columns
}

fn custom_resource_row(resource: &CrdResource, object: DynamicObject) -> Vec<String> {
    let value = serde_json::to_value(&object).unwrap_or_default();
    let mut row = if resource.scope == "Namespaced" {
        vec![
            object.namespace().unwrap_or_else(|| "-".to_string()),
            object.name_any(),
        ]
    } else {
        vec![object.name_any()]
    };

    row.extend(
        resource
            .printer_columns
            .iter()
            .filter(|column| column.name.to_lowercase() != "age")
            .map(|column| print_json_path(&value, &column.json_path)),
    );
    row.push(age_for(&object).unwrap_or_else(|| "-".to_string()));
    row
}

fn print_json_path(value: &serde_json::Value, json_path: &str) -> String {
    let Some(value) = value_at_json_path(value, json_path) else {
        return "-".to_string();
    };

    match value {
        serde_json::Value::Null => "-".to_string(),
        serde_json::Value::String(value) => {
            if looks_like_rfc3339(value) {
                relative_future(value)
            } else {
                value.clone()
            }
        }
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Array(values) => {
            let values = values
                .iter()
                .map(json_scalar_to_string)
                .filter(|value| value != "-")
                .collect::<Vec<_>>();

            if values.is_empty() {
                "-".to_string()
            } else {
                values.join(", ")
            }
        }
        serde_json::Value::Object(_) => value.to_string(),
    }
}

fn json_scalar_to_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "-".to_string(),
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => value.to_string(),
    }
}

fn value_at_json_path<'a>(
    value: &'a serde_json::Value,
    json_path: &str,
) -> Option<&'a serde_json::Value> {
    let mut current = value;
    let path = json_path
        .trim()
        .trim_start_matches('.')
        .trim_start_matches('$')
        .trim_start_matches('.');

    for segment in split_json_path(path) {
        if segment.is_empty() {
            continue;
        }
        current = descend_json_path_segment(current, &segment)?;
    }

    Some(current)
}

fn split_json_path(path: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut bracket_depth: usize = 0;

    for character in path.chars() {
        match character {
            '.' if bracket_depth == 0 => {
                if !current.is_empty() {
                    segments.push(current);
                    current = String::new();
                }
            }
            '[' => {
                bracket_depth += 1;
                current.push(character);
            }
            ']' => {
                bracket_depth = bracket_depth.saturating_sub(1);
                current.push(character);
            }
            _ => current.push(character),
        }
    }

    if !current.is_empty() {
        segments.push(current);
    }

    segments
}

fn descend_json_path_segment<'a>(
    value: &'a serde_json::Value,
    segment: &str,
) -> Option<&'a serde_json::Value> {
    if let Some((field, rest)) = segment.split_once('[') {
        let current = if field.is_empty() {
            value
        } else {
            value.get(field)?
        };
        let selector = rest.trim_end_matches(']');

        if let Ok(index) = selector.parse::<usize>() {
            return current.get(index);
        }

        if let Some((filter_key, filter_value)) = parse_json_path_filter(selector) {
            return current.as_array()?.iter().find(|item| {
                item.get(&filter_key)
                    .and_then(|value| value.as_str())
                    .is_some_and(|value| value == filter_value)
            });
        }

        return None;
    }

    value.get(segment)
}

fn parse_json_path_filter(selector: &str) -> Option<(String, String)> {
    let expression = selector.strip_prefix("?(@.")?.strip_suffix(')')?;
    let (key, value) = expression.split_once("==")?;
    let value = value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_string();

    Some((key.trim().to_string(), value))
}

fn looks_like_rfc3339(value: &str) -> bool {
    value.len() >= 20
        && value.get(4..5) == Some("-")
        && value.get(10..11) == Some("T")
        && chrono::DateTime::parse_from_rfc3339(value).is_ok()
}

fn relative_future(value: &str) -> String {
    let Ok(date) = chrono::DateTime::parse_from_rfc3339(value) else {
        return value.to_string();
    };
    let now = chrono::Utc::now();
    let seconds = date.timestamp() - now.timestamp();
    let prefix = if seconds >= 0 { "in " } else { "" };
    let seconds = seconds.abs();
    let (amount, suffix) = if seconds < 172_800 {
        ((seconds / 3_600).max(1), "h")
    } else if seconds < 5_184_000 {
        (seconds / 86_400, "d")
    } else {
        (seconds / 2_592_000, "mo")
    };

    format!("{}{}{}", prefix, amount, suffix)
}

fn container_images(pod_spec: &k8s_openapi::api::core::v1::PodSpec) -> Vec<String> {
    pod_spec
        .containers
        .iter()
        .map(|container| {
            format!(
                "{}  {}",
                container.name,
                container.image.as_deref().unwrap_or("-")
            )
        })
        .collect()
}

fn resource_totals(pod_spec: &k8s_openapi::api::core::v1::PodSpec) -> ResourceTotals {
    let mut cpu_requested = 0.0;
    let mut cpu_limited = 0.0;
    let mut memory_requested = 0.0;
    let mut memory_limited = 0.0;

    for container in &pod_spec.containers {
        let Some(resources) = &container.resources else {
            continue;
        };

        if let Some(requests) = &resources.requests {
            cpu_requested += requests
                .get("cpu")
                .and_then(|quantity| parse_cpu(&quantity.0))
                .unwrap_or(0.0);
            memory_requested += requests
                .get("memory")
                .and_then(|quantity| parse_memory_mib(&quantity.0))
                .unwrap_or(0.0);
        }

        if let Some(limits) = &resources.limits {
            cpu_limited += limits
                .get("cpu")
                .and_then(|quantity| parse_cpu(&quantity.0))
                .unwrap_or(0.0);
            memory_limited += limits
                .get("memory")
                .and_then(|quantity| parse_memory_mib(&quantity.0))
                .unwrap_or(0.0);
        }
    }

    ResourceTotals {
        cpu_requested: format_cpu(cpu_requested),
        cpu_limited: format_cpu(cpu_limited),
        memory_requested: format_memory(memory_requested),
        memory_limited: format_memory(memory_limited),
    }
}

fn parse_cpu(value: &str) -> Option<f64> {
    if let Some(millicores) = value.strip_suffix('m') {
        return millicores.parse::<f64>().ok().map(|value| value / 1000.0);
    }

    value.parse::<f64>().ok()
}

fn parse_memory_mib(value: &str) -> Option<f64> {
    let units = [
        ("Ki", 1.0 / 1024.0),
        ("Mi", 1.0),
        ("Gi", 1024.0),
        ("Ti", 1024.0 * 1024.0),
        ("K", 1000.0 / 1024.0 / 1024.0),
        ("M", 1000.0 * 1000.0 / 1024.0 / 1024.0),
        ("G", 1000.0 * 1000.0 * 1000.0 / 1024.0 / 1024.0),
    ];

    for (suffix, multiplier) in units {
        if let Some(amount) = value.strip_suffix(suffix) {
            return amount.parse::<f64>().ok().map(|amount| amount * multiplier);
        }
    }

    value
        .parse::<f64>()
        .ok()
        .map(|bytes| bytes / 1024.0 / 1024.0)
}

fn format_cpu(value: f64) -> String {
    if value <= 0.0 {
        "-".to_string()
    } else if value < 1.0 {
        format!("{:.0}m", value * 1000.0)
    } else {
        format!("{:.2}", value)
    }
}

fn format_memory(value: f64) -> String {
    if value <= 0.0 {
        "-".to_string()
    } else if value >= 1024.0 {
        format!("{:.2}Gi", value / 1024.0)
    } else {
        format!("{:.0}Mi", value)
    }
}

fn format_int_or_string(value: &IntOrString) -> String {
    match value {
        IntOrString::Int(value) => value.to_string(),
        IntOrString::String(value) => value.clone(),
    }
}

fn key_values(values: BTreeMap<String, String>) -> Vec<KeyValue> {
    values
        .into_iter()
        .map(|(key, value)| KeyValue { key, value })
        .collect()
}

fn label_selector(labels: &BTreeMap<String, String>) -> String {
    labels
        .iter()
        .map(|(key, value)| format!("{}={}", key, value))
        .collect::<Vec<_>>()
        .join(",")
}

fn selector_matches_labels(
    selector: &BTreeMap<String, String>,
    labels: &BTreeMap<String, String>,
) -> bool {
    !selector.is_empty()
        && selector
            .iter()
            .all(|(key, value)| labels.get(key) == Some(value))
}

fn daemon_set_summary(item: DaemonSet, kind: &'static str) -> ResourceSummary {
    let ready = item
        .status
        .as_ref()
        .map(|status| status.number_ready)
        .unwrap_or(0);
    let desired = item
        .status
        .as_ref()
        .map(|status| status.desired_number_scheduled)
        .unwrap_or(0);

    workload_summary(item, kind, ready, desired)
}

fn workload_summary<K>(item: K, kind: &'static str, ready: i32, desired: i32) -> ResourceSummary
where
    K: ResourceExt,
{
    let status = if ready == desired && desired > 0 {
        "Running"
    } else {
        "Progressing"
    };

    ResourceSummary {
        name: item.name_any(),
        namespace: item.namespace(),
        ready: Some(format!("{}/{}", ready, desired)),
        status: status.to_string(),
        age: age_for(&item),
        kind: kind.to_string(),
    }
}

fn pod_summary(item: Pod, kind: &'static str) -> ResourceSummary {
    let statuses = item
        .status
        .as_ref()
        .and_then(|status| status.container_statuses.as_ref());
    let ready = statuses.map(|statuses| {
        let ready = statuses.iter().filter(|status| status.ready).count();
        format!("{}/{}", ready, statuses.len())
    });
    let status = item
        .status
        .as_ref()
        .and_then(|status| status.phase.clone())
        .unwrap_or_else(|| "Unknown".to_string());

    ResourceSummary {
        name: item.name_any(),
        namespace: item.namespace(),
        ready,
        status,
        age: age_for(&item),
        kind: kind.to_string(),
    }
}

fn job_summary(item: Job, kind: &'static str) -> ResourceSummary {
    let status = item.status.as_ref();
    let status_text = if status.and_then(|status| status.succeeded).unwrap_or(0) > 0 {
        "Complete"
    } else if status.and_then(|status| status.failed).unwrap_or(0) > 0 {
        "Failed"
    } else {
        "Running"
    };

    ResourceSummary {
        name: item.name_any(),
        namespace: item.namespace(),
        ready: None,
        status: status_text.to_string(),
        age: age_for(&item),
        kind: kind.to_string(),
    }
}

fn cron_job_summary(item: CronJob, kind: &'static str) -> ResourceSummary {
    ResourceSummary {
        name: item.name_any(),
        namespace: item.namespace(),
        ready: None,
        status: "Active".to_string(),
        age: age_for(&item),
        kind: kind.to_string(),
    }
}

fn pvc_summary(item: PersistentVolumeClaim, kind: &'static str) -> ResourceSummary {
    let status = item
        .status
        .as_ref()
        .and_then(|status| status.phase.clone())
        .unwrap_or_else(|| "Unknown".to_string());

    ResourceSummary {
        name: item.name_any(),
        namespace: item.namespace(),
        ready: None,
        status,
        age: age_for(&item),
        kind: kind.to_string(),
    }
}

fn simple_active_summary<K>(item: K, kind: &'static str) -> ResourceSummary
where
    K: ResourceExt,
{
    ResourceSummary {
        name: item.name_any(),
        namespace: item.namespace(),
        ready: None,
        status: "Active".to_string(),
        age: age_for(&item),
        kind: kind.to_string(),
    }
}

fn age_for<K>(item: &K) -> Option<String>
where
    K: ResourceExt,
{
    item.creation_timestamp()
        .as_ref()
        .map(|created| age(created.0.timestamp()))
}

fn age(created_epoch_seconds: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(created_epoch_seconds);
    let seconds = now.saturating_sub(created_epoch_seconds);

    let (amount, suffix) = if seconds < 120 {
        (seconds.max(1), "s")
    } else if seconds < 7_200 {
        (seconds / 60, "m")
    } else if seconds < 172_800 {
        (seconds / 3_600, "h")
    } else {
        (seconds / 86_400, "d")
    };

    format!("{}{}", amount, suffix)
}

fn read_config_error(error: impl std::fmt::Display) -> String {
    format!(
        "Unable to read kubeconfig. Make sure ~/.kube/config exists and contains at least one context. Details: {}",
        error
    )
}

fn kube_error(error: kube::Error) -> String {
    format!("Kubernetes API request failed: {}", error)
}

pub fn run() {
    tauri::Builder::default()
        .manage(LogStreams::default())
        .invoke_handler(tauri::generate_handler![
            check_context_connection,
            get_custom_resource_details,
            get_custom_resource_yaml,
            get_workload_details,
            get_workload_yaml,
            list_crds,
            list_custom_resources,
            list_workload_events,
            list_contexts,
            list_namespaces,
            list_resources,
            start_workload_log_stream,
            stop_log_stream
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
