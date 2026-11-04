//! Android throughput tests always use the authenticated inbound of the accepted VPN run.
//! Only the native bridge can obtain the listener credentials. The UI supplies no URLs or ports.
use reqwest::{header, Client, Response};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

const UNAVAILABLE: &str = "speedtest_route_unavailable";
const FAILED: &str = "speedtest_request_failed";
#[cfg(target_os = "android")]
const HOST: &str = "https://speed.cloudflare.com";
const DOWNLOAD: usize = 15_000_000;
const UPLOAD: usize = 1024 * 1024;

#[derive(Deserialize, PartialEq)]
struct Route {
    port: u16,
    password: String,
    revision: String,
}

impl Route {
    fn client(&self) -> Result<Client, &'static str> {
        if self.port == 0 || self.password.is_empty() || self.revision.is_empty() {
            return Err(UNAVAILABLE);
        }
        let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{}", self.port))
            .map_err(|_| UNAVAILABLE)?
            .basic_auth("cw", &self.password);
        Client::builder()
            .no_proxy()
            .proxy(proxy)
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(45))
            .build()
            .map_err(|_| UNAVAILABLE)
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    phase: &'static str,
    current_speed: f64,
    progress_percent: u8,
    ping_ms: u64,
    jitter_ms: f64,
    download_mbps: f64,
    upload_mbps: f64,
    samples: Vec<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_ip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    colo: Option<String>,
}

fn speed(bytes: usize, elapsed: Duration) -> f64 {
    (bytes as f64 * 8.0 / (elapsed.as_secs_f64().max(0.001) * 1e6) * 10.0).round() / 10.0
}

fn header_text(response: &Response, name: &str) -> Option<String> {
    let s = response.headers().get(name)?.to_str().ok()?;
    (!s.trim().is_empty() && s.len() <= 256).then(|| s.trim().to_owned())
}

async fn successful(req: reqwest::RequestBuilder) -> Result<Response, &'static str> {
    let response = req
        .header(header::CACHE_CONTROL, "no-store")
        .send()
        .await
        .map_err(|_| FAILED)?;
    if !response.status().is_success() {
        return Err(FAILED);
    }
    Ok(response)
}

async fn measure(
    client: Client,
    host: &str,
    notify: impl Fn(&Progress) -> Result<(), &'static str>,
) -> Result<Progress, &'static str> {
    let mut p = Progress {
        phase: "ping",
        progress_percent: 5,
        ..Progress::default()
    };
    notify(&p)?;
    let mut pings = Vec::new();
    for index in 0..4 {
        let started = Instant::now();
        let response =
            successful(client.get(format!("{host}/__down?bytes=0&probe={index}"))).await?;
        let ping = (started.elapsed().as_millis() as u64).max(1);
        pings.push(ping);
        p.ping_ms = (pings.iter().sum::<u64>() + pings.len() as u64 / 2) / pings.len() as u64;
        if pings.len() > 1 {
            let delta: u64 = pings.windows(2).map(|pair| pair[0].abs_diff(pair[1])).sum();
            p.jitter_ms = (delta as f64 * 10.0 / (pings.len() - 1) as f64).round() / 10.0;
        }
        if index == 0 {
            p.client_ip = header_text(&response, "cf-meta-ip");
            p.colo = header_text(&response, "cf-meta-colo");
            let parts: Vec<_> = ["cf-meta-city", "cf-meta-country"]
                .iter()
                .filter_map(|name| header_text(&response, name))
                .collect();
            if !parts.is_empty() {
                p.location = Some(parts.join(", "));
            }
        }
        p.progress_percent = 10 + 5 * index;
        notify(&p)?;
    }

    p.phase = "download";
    notify(&p)?;
    let started = Instant::now();
    let mut response = successful(client.get(format!("{host}/__down?bytes={DOWNLOAD}"))).await?;
    let (mut bytes, mut sample_bytes, mut sample_time) = (0, 0, started);
    while let Some(chunk) = response.chunk().await.map_err(|_| FAILED)? {
        bytes += chunk.len();
        if bytes > DOWNLOAD {
            return Err(FAILED);
        }
        if sample_time.elapsed() >= Duration::from_millis(100) {
            p.current_speed = speed(bytes - sample_bytes, sample_time.elapsed());
            p.download_mbps = speed(bytes, started.elapsed());
            p.samples.clear();
            p.samples.push(p.current_speed);
            p.progress_percent = 25 + (bytes * 40 / DOWNLOAD) as u8;
            notify(&p)?;
            sample_time = Instant::now();
            sample_bytes = bytes;
        }
    }
    if bytes != DOWNLOAD {
        return Err(FAILED);
    }
    p.download_mbps = speed(bytes, started.elapsed());
    p.current_speed = p.download_mbps;
    p.progress_percent = 65;
    notify(&p)?;

    p.phase = "upload";
    p.samples.clear();
    p.current_speed = 0.0;
    p.progress_percent = 70;
    notify(&p)?;
    let started = Instant::now();
    for index in 1..=3 {
        let chunk_start = Instant::now();
        successful(client.post(format!("{host}/__up")).body(vec![0u8; UPLOAD])).await?;
        p.current_speed = speed(UPLOAD, chunk_start.elapsed());
        p.upload_mbps = speed(UPLOAD * index, started.elapsed());
        p.samples.push(p.current_speed);
        p.progress_percent = 70 + (25 * index / 3) as u8;
        notify(&p)?;
    }
    Ok(p)
}

#[cfg(target_os = "android")]
mod bridge {
    use super::*;
    use std::sync::Mutex;
    use tauri::{ipc::Channel, AppHandle, Manager, State};
    use tokio::sync::oneshot;

    #[derive(Default)]
    pub(crate) struct SpeedTestState(Mutex<Option<(String, oneshot::Sender<()>)>>);

    async fn route(app: &AppHandle, run_id: &str) -> Result<Route, &'static str> {
        app.state::<crate::VpnPluginHandle>()
            .0
            .run_mobile_plugin_async("speedTestRoute", serde_json::json!({"runId": run_id}))
            .await
            .map_err(|_| UNAVAILABLE)
    }

    #[tauri::command]
    pub(crate) async fn android_vpn_speed_test(
        app: AppHandle,
        state: State<'_, SpeedTestState>,
        run_id: String,
        operation_id: String,
        on_progress: Channel<Progress>,
    ) -> Result<Progress, &'static str> {
        if uuid::Uuid::parse_str(&operation_id).is_err() || run_id.is_empty() {
            return Err(UNAVAILABLE);
        }
        let (cancel, cancelled) = oneshot::channel();
        *state.0.lock().map_err(|_| FAILED)? = Some((operation_id.clone(), cancel));
        let benchmark = async {
            let before = route(&app, &run_id).await?;
            let result = measure(before.client()?, HOST, |p| {
                on_progress.send(p.clone()).map_err(|_| FAILED)
            })
            .await?;
            if route(&app, &run_id).await? != before {
                return Err(UNAVAILABLE);
            }
            Ok(result)
        };
        let result = tokio::select! {
            biased;
            _ = cancelled => Err(FAILED),
            outcome = tokio::time::timeout(Duration::from_secs(120),benchmark) => outcome.map_err(|_| FAILED).and_then(|v| v),
        };
        let mut active = state.0.lock().map_err(|_| FAILED)?;
        if active.as_ref().is_some_and(|(id, _)| *id == operation_id) {
            active.take();
        }
        result
    }

    #[tauri::command]
    pub(crate) fn cancel_android_speed_test(
        state: State<'_, SpeedTestState>,
        operation_id: String,
    ) {
        if let Ok(mut active) = state.0.lock() {
            if active.as_ref().is_some_and(|(id, _)| *id == operation_id) {
                active.take();
            }
        }
    }
}
#[cfg(target_os = "android")]
pub(crate) use bridge::*;

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[tokio::test]
    async fn vpn_request_connects_to_authenticated_loopback_and_fails_if_denied() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let route = Route {
            port: listener.local_addr().unwrap().port(),
            password: "fixture".into(),
            revision: "run".into(),
        };
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                bytes.push(socket.read_u8().await.unwrap());
                assert!(bytes.len() <= 8192);
            }
            socket
                .write_all(
                    b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n",
                )
                .await
                .unwrap();
            String::from_utf8(bytes).unwrap().to_lowercase()
        });
        let result = measure(route.client().unwrap(), "https://fixture.invalid", |_| {
            Ok(())
        })
        .await;
        assert!(result.is_err());
        let headers = tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
        assert!(headers.starts_with("connect fixture.invalid:443 http/1.1"));
        assert!(headers.contains("proxy-authorization: basic y3c6zml4dhvyzq=="));
    }

    #[tokio::test]
    async fn benchmark_counts_transferred_bytes_and_keeps_exit_metadata() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for index in 0..8 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                while !bytes.ends_with(b"\r\n\r\n") {
                    bytes.push(socket.read_u8().await.unwrap());
                }
                let headers = String::from_utf8(bytes).unwrap().to_lowercase();
                let down = if index < 4 {
                    assert!(headers.starts_with("get /__down?bytes=0&probe="));
                    0
                } else if index == 4 {
                    assert!(headers.starts_with("get /__down?bytes=15000000 "));
                    DOWNLOAD
                } else {
                    assert!(headers.starts_with("post /__up "));
                    assert!(headers.contains("content-length: 1048576"));
                    socket.read_exact(&mut vec![0u8; UPLOAD]).await.unwrap();
                    0
                };
                let reply = format!("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {down}\r\ncf-meta-ip: 203.0.113.25\r\ncf-meta-colo: HEL\r\n\r\n");
                socket.write_all(reply.as_bytes()).await.unwrap();
                if down > 0 {
                    socket.write_all(&vec![0u8; down]).await.unwrap();
                }
            }
        });
        let client = Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let end = measure(client, &host, |_| Ok(())).await.unwrap();
        assert!(end.ping_ms > 0 && end.download_mbps > 0.0 && end.upload_mbps > 0.0);
        assert_eq!(end.client_ip.as_deref(), Some("203.0.113.25"));
        assert_eq!(end.colo.as_deref(), Some("HEL"));
        server.await.unwrap();
    }

    #[test]
    fn incomplete_active_route_never_builds_a_client() {
        for (port, password, revision) in [(0, "pw", "run"), (1, "", "run"), (1, "pw", "")] {
            assert!(Route {
                port,
                password: password.into(),
                revision: revision.into()
            }
            .client()
            .is_err());
        }
    }
}
