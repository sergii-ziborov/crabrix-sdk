//! Typed Rust access to Crabrix's temporary encrypted Playground rooms.
//!
//! This SDK uses the same bundled local JavaScript protocol core as the npm SDK.
//! **Node.js 22+ is required**, but no npm install or iPhone app is needed.
//! It never compiles source on the relay. A browser/app must explicitly allow
//! local Run/Debug. Source and capability links are never logged by this SDK.
//!
//! ```no_run
//! use crabrix::{Client, CreateOptions};
//! let mut client = Client::new()?;
//! let room = client.create(&CreateOptions::new("Rust agent exercise"))?;
//! let source = client.read("main.rs")?;
//! assert!(!source.revision.is_empty());
//! // Explicit secret handoff; deliver only to the intended recipient.
//! let handoff = client.share("edit")?;
//! assert_eq!(handoff.mode, "edit");
//! # Ok::<(), crabrix::Error>(())
//! ```
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fmt,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::{Duration, Instant},
};

const BRIDGE: &str = include_str!("../runtime/bridge.mjs");
const MAX_LINE: usize = 2_000_000;

#[derive(Debug)]
pub struct Error(String);
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(_: std::io::Error) -> Self {
        Self("Crabrix local transport failed; no private source or link was logged.".into())
    }
}
impl From<serde_json::Error> for Error {
    fn from(_: serde_json::Error) -> Self {
        Self("Invalid Crabrix protocol JSON.".into())
    }
}
pub type Result<T> = std::result::Result<T, Error>;

/// No network installation is performed. `node` is a local trusted executable.
#[derive(Clone, Debug)]
pub struct Options {
    pub node: PathBuf,
    pub timeout: Duration,
    pub name: String,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            node: "node".into(),
            timeout: Duration::from_secs(30),
            name: "Rust agent".into(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateOptions {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_file: Option<String>,
    pub lifetime_minutes: u16,
}
impl CreateOptions {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            files: None,
            entry_file: None,
            lifetime_minutes: 60,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    pub text: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOptions {
    pub expected_revision: String,
    pub changes: Vec<Change>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}
#[derive(Clone, Deserialize)]
pub struct SourceFile {
    pub path: String,
    pub text: String,
    pub revision: String,
}
/// A capability URL. Debug formatting deliberately redacts the link.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Handoff {
    pub schema: String,
    pub link_type: String,
    pub link: String,
    pub expires_at: String,
    pub revision: String,
    pub mode: String,
}
impl fmt::Debug for Handoff {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Handoff")
            .field("link", &"[REDACTED]")
            .field("mode", &self.mode)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

pub struct Client {
    child: Child,
    input: Option<ChildStdin>,
    replies: Receiver<Result<Value>>,
    next_id: u64,
    options: Options,
    _directory: tempfile::TempDir,
    closed: bool,
}
impl Client {
    pub fn new() -> Result<Self> {
        Self::with_options(Options::default())
    }
    pub fn with_options(options: Options) -> Result<Self> {
        if options.timeout < Duration::from_millis(1) || options.timeout > Duration::from_secs(120)
        {
            return Err(Error(
                "Choose a transport timeout from 1 ms to 120 seconds.".into(),
            ));
        }
        let directory = tempfile::tempdir()?;
        let file = directory.path().join("bridge.mjs");
        std::fs::write(&file, BRIDGE)?;
        let mut child=command(&options.node,&file).arg("--name").arg(&options.name).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_|Error("Cannot start Crabrix. Install Node.js 22+ or set Options.node to its trusted executable.".into()))?;
        let input = child.stdin.take();
        let output = child
            .stdout
            .take()
            .ok_or_else(|| Error("Cannot open Crabrix output.".into()))?;
        // A bounded queue and bounded lines prevent an unresponsive consumer from
        // accumulating notifications or plaintext source without limit.
        let (sender, replies) = mpsc::sync_channel(16);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let mut line = Vec::new();
                let result = reader
                    .by_ref()
                    .take((MAX_LINE + 1) as u64)
                    .read_until(b'\n', &mut line);
                match result {
                    Ok(0) => break,
                    Ok(_) if line.len() <= MAX_LINE => {
                        let value = serde_json::from_slice(&line).map_err(Error::from);
                        let invalid = value.is_err();
                        if sender.try_send(value).is_err() || invalid {
                            break;
                        }
                    }
                    _ => {
                        let _ = sender.try_send(Err(Error(
                            "Crabrix protocol frame exceeds its limit.".into(),
                        )));
                        break;
                    }
                }
            }
        });
        let mut client = Self {
            child,
            input,
            replies,
            next_id: 1,
            options,
            _directory: directory,
            closed: false,
        };
        client.rpc("initialize",json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"crabrix-rust-sdk","version":env!("CARGO_PKG_VERSION")}}))?;
        client.notify("notifications/initialized", json!({}))?;
        Ok(client)
    }
    fn send(&mut self, value: &Value) -> Result<()> {
        if self.closed {
            return Err(Error("This Crabrix client is closed.".into()));
        }
        let mut bytes = serde_json::to_vec(value)?;
        if bytes.len() > MAX_LINE {
            return Err(Error("Crabrix request exceeds its limit.".into()));
        }
        bytes.push(b'\n');
        let input = self
            .input
            .as_mut()
            .ok_or_else(|| Error("Crabrix input is closed.".into()))?;
        input.write_all(&bytes)?;
        input.flush()?;
        Ok(())
    }
    fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        self.send(&json!({"jsonrpc":"2.0","method":method,"params":params}))
    }
    fn rpc(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        let deadline = Instant::now() + self.options.timeout;
        for _ in 0..64 {
            let Some(wait) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            let value = match self.replies.recv_timeout(wait) {
                Ok(value) => value?,
                Err(_) => break,
            };
            if value.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
                self.close();
                return Err(Error("Invalid Crabrix RPC response.".into()));
            }
            if value.get("error").is_some() {
                return Err(Error("Crabrix rejected the protocol request.".into()));
            }
            return value
                .get("result")
                .cloned()
                .ok_or_else(|| Error("Missing Crabrix RPC result.".into()));
        }
        self.close();
        Err(Error("Crabrix request timed out or disconnected. Its outcome may be unknown; reconcile before retrying an edit or execution.".into()))
    }
    /// Calls one allowlisted room tool; no arbitrary shell command exists.
    pub fn call(&mut self, name: &str, arguments: Value) -> Result<Value> {
        const TOOLS: &[&str] = &[
            "crabrix_create",
            "crabrix_connect",
            "crabrix_status",
            "crabrix_snapshot",
            "crabrix_read_file",
            "crabrix_apply_changes",
            "crabrix_select",
            "crabrix_handoff",
            "crabrix_disconnect",
            "crabrix_end_room",
            "crabrix_runtime_clients",
            "crabrix_runtime_request",
            "crabrix_runtime_start",
            "crabrix_runtime_job",
        ];
        if !TOOLS.contains(&name) {
            return Err(Error("Unknown Crabrix room tool.".into()));
        }
        let result = self.rpc("tools/call", json!({"name":name,"arguments":arguments}))?;
        if result.get("isError") == Some(&Value::Bool(true)) {
            let message = result
                .pointer("/content/0/text")
                .and_then(Value::as_str)
                .unwrap_or("Crabrix operation failed.");
            return Err(Error(message.chars().take(400).collect()));
        }
        if let Some(value) = result.get("structuredContent") {
            return Ok(value.clone());
        }
        let text = result
            .pointer("/content/0/text")
            .and_then(Value::as_str)
            .ok_or_else(|| Error("Missing Crabrix tool result.".into()))?;
        Ok(serde_json::from_str(text)?)
    }
    pub fn create(&mut self, options: &CreateOptions) -> Result<Value> {
        self.call("crabrix_create", serde_json::to_value(options)?)
    }
    pub fn connect(&mut self, link: &str) -> Result<Value> {
        self.call("crabrix_connect", json!({"link":link}))
    }
    pub fn status(&mut self) -> Result<Value> {
        self.call("crabrix_status", json!({}))
    }
    pub fn snapshot(&mut self) -> Result<Value> {
        self.call("crabrix_snapshot", json!({}))
    }
    pub fn read(&mut self, path: &str) -> Result<SourceFile> {
        Ok(serde_json::from_value(
            self.call("crabrix_read_file", json!({"path":path}))?,
        )?)
    }
    pub fn apply(&mut self, options: &ApplyOptions) -> Result<Value> {
        self.call("crabrix_apply_changes", serde_json::to_value(options)?)
    }
    pub fn select(
        &mut self,
        path: &str,
        anchor: u32,
        head: u32,
        expected_revision: &str,
    ) -> Result<Value> {
        self.call(
            "crabrix_select",
            json!({"path":path,"anchor":anchor,"head":head,"expectedRevision":expected_revision}),
        )
    }
    pub fn share(&mut self, mode: &str) -> Result<Handoff> {
        Ok(serde_json::from_value(
            self.call("crabrix_handoff", json!({"mode":mode}))?,
        )?)
    }
    pub fn runtime_clients(&mut self) -> Result<Value> {
        self.call("crabrix_runtime_clients", json!({}))
    }
    pub fn request_runtime(&mut self, target: &str, operations: &[&str]) -> Result<Value> {
        self.call(
            "crabrix_runtime_request",
            json!({"target":target,"operations":operations}),
        )
    }
    pub fn start(&mut self, target: &str, operation: &str, source_revision: &str) -> Result<Value> {
        self.call(
            "crabrix_runtime_start",
            json!({"target":target,"operation":operation,"sourceRevision":source_revision}),
        )
    }
    pub fn job(
        &mut self,
        target: &str,
        source_revision: &str,
        job: &str,
        operation: &str,
        options: Value,
    ) -> Result<Value> {
        let mut args = options
            .as_object()
            .cloned()
            .ok_or_else(|| Error("Job options must be an object.".into()))?;
        for (k, v) in [
            ("target", target),
            ("sourceRevision", source_revision),
            ("job", job),
            ("operation", operation),
        ] {
            args.insert(k.into(), Value::String(v.into()));
        }
        self.call("crabrix_runtime_job", Value::Object(args))
    }
    pub fn end_room(&mut self) -> Result<Value> {
        self.call("crabrix_end_room", json!({}))
    }
    pub fn disconnect(&mut self) -> Result<Value> {
        self.call("crabrix_disconnect", json!({}))
    }
    pub fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        self.input.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        self.close();
    }
}
fn command(node: &std::path::Path, file: &std::path::Path) -> Command {
    let mut cmd = Command::new(node);
    cmd.arg(file)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH");
    cmd
}
/// Run the exact bundled MCP server over stdio, without an npm download.
pub fn serve_mcp() -> Result<i32> {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let directory = tempfile::tempdir()?;
    let file = directory.path().join("bridge.mjs");
    std::fs::write(&file, BRIDGE)?;
    let stopping = Arc::new(AtomicBool::new(false));
    let signal = stopping.clone();
    ctrlc::set_handler(move || {
        signal.store(true, Ordering::SeqCst);
    })
    .map_err(|_| Error("Cannot install Crabrix MCP signal handler.".into()))?;
    let mut child = command(std::path::Path::new("node"), &file)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()?;
    loop {
        if stopping.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(130);
        }
        if let Some(status) = child.try_wait()? {
            return Ok(status.code().unwrap_or(1));
        }
        std::thread::sleep(Duration::from_millis(30));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disconnected_stdio_is_real() {
        let mut c = Client::new().unwrap();
        assert_eq!(c.status().unwrap()["connected"], false);
        assert!(c.call("shell", json!({})).is_err());
        let e = c
            .connect("https://example.com/#private-never-return")
            .unwrap_err();
        assert!(!e.to_string().contains("private-never-return"));
        c.close();
        assert!(c.status().is_err());
    }
    #[test]
    fn handoff_debug_redacts_capabilities() {
        let h = Handoff {
            schema: "crabrix-handoff-v1".into(),
            link_type: "temporary edit Playground".into(),
            link: "private-key".into(),
            expires_at: "date".into(),
            revision: "rev".into(),
            mode: "edit".into(),
        };
        assert!(!format!("{h:?}").contains("private-key"));
    }
    #[test]
    fn timeout_is_bounded() {
        assert!(
            Client::with_options(Options {
                timeout: Duration::ZERO,
                ..Options::default()
            })
            .is_err()
        );
    }
}
