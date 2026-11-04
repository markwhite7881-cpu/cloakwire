//! One child handle, one private directory. Never scans or kills by process name.
use super::types::HealthIssue;
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    task::JoinHandle,
};

pub struct OwnedCore {
    directory: PathBuf,
    config: PathBuf,
    child: Option<Child>,
    drains: Vec<JoinHandle<()>>,
    tail: Arc<Mutex<Vec<u8>>>,
}
impl OwnedCore {
    pub fn create(parent: &Path, config: &serde_json::Value) -> Result<Self, HealthIssue> {
        let directory = parent.join(format!("cloakwire-probe-{}", uuid::Uuid::new_v4()));
        #[allow(unused_mut)]
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&directory)
            .map_err(|_| HealthIssue::EngineUnavailable)?;
        let owner = Self {
            config: directory.join("candidate.json"),
            directory,
            child: None,
            drains: Vec::new(),
            tail: Arc::new(Mutex::new(Vec::new())),
        };
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&owner.config)
            .map_err(|_| HealthIssue::EngineUnavailable)?;
        file.write_all(&serde_json::to_vec(config).map_err(|_| HealthIssue::UnsupportedProbe)?)
            .map_err(|_| HealthIssue::EngineUnavailable)?;
        Ok(owner)
    }
    pub fn config_path(&self) -> &Path {
        &self.config
    }
    #[cfg(test)]
    pub(super) fn process_id(&self) -> Option<u32> {
        self.child.as_ref()?.id()
    }
    pub fn has_process(&self) -> bool {
        self.child.is_some()
    }
    pub fn is_alive(&mut self) -> Result<bool, HealthIssue> {
        match self.child.as_mut() {
            Some(child) => Ok(child
                .try_wait()
                .map_err(|_| HealthIssue::EngineUnavailable)?
                .is_none()),
            None => Ok(false),
        }
    }
    pub fn spawn(&mut self, mut command: Command) -> Result<(), HealthIssue> {
        if self.child.is_some() {
            return Err(HealthIssue::EngineUnavailable);
        }
        command
            .current_dir(&self.directory)
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        // Explicit -config does not override Xray's environment confdir.
        // Include both inherited and explicitly supplied Command variables.
        let names: Vec<_> = std::env::vars_os()
            .map(|(name, _)| name)
            .chain(command.as_std().get_envs().map(|(name, _)| name.to_owned()))
            .collect();
        for name in names {
            let key = name.to_string_lossy().to_ascii_lowercase();
            if matches!(
                key.as_str(),
                "http_proxy" | "https_proxy" | "all_proxy" | "no_proxy"
            ) || [
                "xray_",
                "xray.",
                "v2ray_",
                "v2ray.",
                "sing_box_",
                "singbox_",
            ]
            .iter()
            .any(|prefix| key.starts_with(prefix))
            {
                command.env_remove(name);
            }
        }
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        self.tail.lock().unwrap_or_else(|p| p.into_inner()).clear();
        let mut child = command
            .spawn()
            .map_err(|_| HealthIssue::EngineUnavailable)?;
        if let Some(stdout) = child.stdout.take() {
            self.drains.push(drain(stdout, self.tail.clone()));
        }
        if let Some(stderr) = child.stderr.take() {
            self.drains.push(drain(stderr, self.tail.clone()));
        }
        self.child = Some(child);
        Ok(())
    }
    /// Cancellation leaves the live handle in this owner for coordinated cleanup.
    /// A successful check reaps it while retaining this lease's private config.
    pub async fn wait_exit(&mut self) -> Result<bool, HealthIssue> {
        let child = self.child.as_mut().ok_or(HealthIssue::EngineUnavailable)?;
        let status = child
            .wait()
            .await
            .map_err(|_| HealthIssue::EngineUnavailable)?;
        while let Some(task) = self.drains.last_mut() {
            let _ = task.await;
            self.drains.pop();
        }
        self.child.take();
        Ok(status.success())
    }
    /// Only an allowlisted classifier should ask questions of this private tail.
    pub(crate) fn address_in_use(&self) -> bool {
        let bytes = self.tail.lock().unwrap_or_else(|p| p.into_inner());
        let text = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
        text.contains("address already in use") || text.contains("only one usage of each socket")
    }
    pub async fn stop(&mut self, budget: Duration) -> bool {
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {}
                Ok(None) => {
                    // A live OS handle, never a saved PID. wait() proves termination.
                    let _ = child.start_kill();
                    if !matches!(tokio::time::timeout(budget, child.wait()).await, Ok(Ok(_))) {
                        return false;
                    }
                }
                Err(_) => return false,
            }
        }
        self.child.take();
        for task in self.drains.drain(..) {
            task.abort();
            let _ = task.await;
        }
        self.remove_files()
    }
    fn remove_files(&self) -> bool {
        // These two paths were created exclusively by this lease. No recursive sweep.
        match std::fs::remove_file(&self.config) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return false,
        }
        match std::fs::remove_dir(&self.directory) {
            Ok(()) => true,
            Err(e) => e.kind() == std::io::ErrorKind::NotFound,
        }
    }
}
fn drain<T: AsyncRead + Unpin + Send + 'static>(
    mut stream: T,
    tail: Arc<Mutex<Vec<u8>>>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut buffer = [0u8; 1024];
        loop {
            let Ok(count) = stream.read(&mut buffer).await else {
                break;
            };
            if count == 0 {
                break;
            }
            let mut bytes = tail.lock().unwrap_or_else(|p| p.into_inner());
            bytes.extend_from_slice(&buffer[..count]);
            if bytes.len() > 4096 {
                let remove = bytes.len() - 4096;
                bytes.drain(..remove);
            }
        }
    })
}
impl Drop for OwnedCore {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            // Panic/abort fallback. Keep credentials in the private directory until
            // explicit cleanup can prove death; never silently claim successful cleanup.
            let _ = child.start_kill();
        } else {
            let _ = self.remove_files();
        }
        for task in &self.drains {
            task.abort();
        }
    }
}
