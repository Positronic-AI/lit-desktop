use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, State};

/// PID of the sidecar the frontend spawned, registered from `startBackend()`.
/// `None` when we attached to a backend we did not launch — we never reap those
/// (on a dev box that would kill the `start.sh` sidecar on :5000).
#[derive(Default)]
struct BackendPid(Mutex<Option<u32>>);

#[tauri::command]
fn register_backend_pid(pid: u32, state: State<'_, BackendPid>) {
    *state.0.lock().unwrap() = Some(pid);
    println!("[shutdown] owning backend pid {pid}");
}

/// Create (and sweep) the app-owned dir the sidecar extracts into, returning
/// its absolute path. The frontend points the sidecar's TMPDIR/TMP/TEMP here.
///
/// Why: the sidecar is a PyInstaller ONEFILE — it self-extracts to
/// $TMPDIR/_MEIxxxxxx at launch and imports lazily from there for its whole
/// lifetime. macOS purges /var/folders temp entries untouched for ~3 days, so a
/// long-running backend gets gutted underneath itself: modules already imported
/// keep working while first-time imports start throwing ModuleNotFoundError for
/// files that verifiably shipped (Lais, 2026-08-17 — "Could not start sign-in";
/// certifi's cacert.pem went the same way days earlier). systemd-tmpfiles ages
/// /tmp on Linux too. App-owned storage is outside every OS temp sweeper.
///
/// The sweep: normal exits clean up _MEI dirs, but SIGKILLed backends leak
/// them. This runs only from startBackend right before a spawn — i.e. when no
/// healthy backend exists — so anything here is an orphan. Locked dirs (a live
/// zombie on Windows) just fail their remove and are skipped.
#[tauri::command]
fn prepare_backend_runtime() -> Result<String, String> {
    let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map_err(|e| format!("no home dir: {e}"))?;
    let dir = std::path::Path::new(&home)
        .join(".local")
        .join("share")
        .join("lit-desktop")
        .join("runtime");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {dir:?}: {e}"))?;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with("_MEI") {
                match std::fs::remove_dir_all(entry.path()) {
                    Ok(()) => println!("[runtime] swept stale {:?}", entry.file_name()),
                    Err(e) => println!("[runtime] skip {:?}: {e}", entry.file_name()),
                }
            }
        }
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// Collect `root` plus every descendant, walking the ppid chain.
///
/// Why a walk and not a process-group kill: the sidecar is a PyInstaller
/// onefile, so `root` is the bootloader and the real server is its child; and
/// the backend spawns the bridge daemon with `start_new_session=True`
/// (lit-lib claude_interactive.py:333), which `setsid`s it out of our process
/// group along with every claude CLI under it. `setsid` changes the session and
/// group but never the ppid, so descent by ppid still reaches the whole tree.
///
/// Collect fully BEFORE killing anything — killing a parent first reparents its
/// children to init and they vanish from the walk.
#[cfg(unix)]
fn descendants(root: u32) -> Vec<u32> {
    let mut pids = vec![root];
    let Ok(out) = std::process::Command::new("ps")
        .args(["-eo", "pid=,ppid="])
        .output()
    else {
        return pids;
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let pairs: Vec<(u32, u32)> = text
        .lines()
        .filter_map(|line| {
            let mut it = line.split_whitespace();
            let pid = it.next()?.parse().ok()?;
            let ppid = it.next()?.parse().ok()?;
            Some((pid, ppid))
        })
        .collect();

    let mut i = 0;
    while i < pids.len() {
        let parent = pids[i];
        for (pid, ppid) in &pairs {
            if *ppid == parent && !pids.contains(pid) {
                pids.push(*pid);
            }
        }
        i += 1;
    }
    pids
}

#[cfg(unix)]
fn signal(pids: &[u32], sig: &str) {
    if pids.is_empty() {
        return;
    }
    let mut cmd = std::process::Command::new("kill");
    cmd.arg(sig);
    for pid in pids {
        cmd.arg(pid.to_string());
    }
    let _ = cmd.output();
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Terminate the backend and everything under it.
///
/// SIGTERM first so the graceful paths run: the backend's SIGTERM handler in
/// `lit.api.app` saves active streams, and the bridge daemon unlinks its socket
/// files (lit-bridge-rs main.rs:1359). Then SIGKILL whatever is still up.
#[cfg(unix)]
fn reap(root: u32) {
    let pids = descendants(root);
    println!("[shutdown] reaping backend tree: {pids:?}");
    signal(&pids, "-TERM");

    // Give the graceful handlers a moment, but never hang the quit.
    let deadline = Instant::now() + Duration::from_millis(2000);
    while Instant::now() < deadline {
        if !pids.iter().any(|p| alive(*p)) {
            println!("[shutdown] backend tree exited cleanly");
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    let stubborn: Vec<u32> = pids.into_iter().filter(|p| alive(*p)).collect();
    if !stubborn.is_empty() {
        println!("[shutdown] SIGKILL after timeout: {stubborn:?}");
        signal(&stubborn, "-KILL");
    }
}

/// `taskkill /T` walks the Windows child chain, which covers both the onefile
/// bootloader's child and the bridge daemon. `/F` is forceful — the graceful
/// stream-save does not run here. Fixing that needs a Job Object with
/// KILL_ON_JOB_CLOSE (also the only thing that survives an app crash); tracked
/// on the desktop backlog rather than rushed into a release build.
#[cfg(windows)]
fn reap(root: u32) {
    println!("[shutdown] taskkill /T /F on backend pid {root}");
    let _ = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &root.to_string()])
        .output();
}

/// Kill a STALE ADOPTED sidecar: find who is listening on `port`, and reap it
/// only when its process image matches our sidecar binary name. Called by
/// `startBackend()` when an adopted backend reports the wrong wheel version
/// (Lais 2026-08-17 — a reinstall adopted a two-week-old backend and every
/// "fix" was served by the old code). A start.sh dev backend is a python
/// process, never matches the prefix, and is always left alone.
///
/// Returns true only if something was actually reaped — the frontend keeps
/// the stale backend when we can't (a stale backend still beats no backend).
#[cfg(unix)]
#[tauri::command]
fn reap_backend_on_port(port: u16, expected_prefix: String) -> bool {
    let Ok(out) = std::process::Command::new("lsof")
        .args(["-nP", "-t", &format!("-iTCP:{port}"), "-sTCP:LISTEN"])
        .output()
    else {
        return false;
    };
    let pids: Vec<u32> = String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .collect();
    let mut any = false;
    for pid in pids {
        let comm = std::process::Command::new("ps")
            .args(["-o", "comm=", "-p", &pid.to_string()])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        let base = comm.rsplit('/').next().unwrap_or("");
        if base.starts_with(&expected_prefix) {
            println!("[adopt] reaping stale sidecar {base} (pid {pid}) on :{port}");
            reap(pid);
            any = true;
        } else {
            println!("[adopt] listener on :{port} is {base:?}, not ours — leaving it");
        }
    }
    any
}

#[cfg(windows)]
#[tauri::command]
fn reap_backend_on_port(port: u16, expected_prefix: String) -> bool {
    let Ok(out) = std::process::Command::new("netstat").args(["-ano", "-p", "TCP"]).output() else {
        return false;
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let needle = format!(":{port}");
    let mut seen: Vec<u32> = Vec::new();
    let mut any = false;
    for line in text.lines() {
        if !line.contains("LISTENING") {
            continue;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 5 || !cols[1].ends_with(&needle) {
            continue;
        }
        let Ok(pid) = cols[4].parse::<u32>() else { continue };
        if pid == 0 || seen.contains(&pid) {
            continue;
        }
        seen.push(pid);
        // tasklist CSV: "Image Name","PID",...
        let image = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default()
            .trim()
            .trim_start_matches('"')
            .split('"')
            .next()
            .unwrap_or("")
            .to_string();
        if image.to_lowercase().starts_with(&expected_prefix.to_lowercase()) {
            println!("[adopt] reaping stale sidecar {image} (pid {pid}) on :{port}");
            reap(pid);
            any = true;
        } else {
            println!("[adopt] listener on :{port} is {image:?}, not ours — leaving it");
        }
    }
    any
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK's DMA-BUF renderer has a known heap-corruption crash family
    // (malloc_consolidate/fastbin aborts), most-reported on NVIDIA. Ben's box
    // (WebKitGTK 2.52.3 + NVIDIA, 2026-07-30) hit it repeatedly in normal use,
    // browser panel closed — not load-specific. Linux-only knob; WebView2 and
    // WKWebView never read it. Must be set before the webview initializes.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_websocket::init())
        .manage(BackendPid::default())
        .invoke_handler(tauri::generate_handler![
            register_backend_pid,
            prepare_backend_runtime,
            reap_backend_on_port
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        // Closing the app must take its subprocesses with it — the JS
        // `beforeunload` handler this replaces did not fire reliably on window
        // close, leaving backend + bridge + claude CLIs reparented to init, and
        // the next launch then attached to the zombie and served its stale code
        // (TCF, 2026-07-31). ExitRequested is the correct hook on every
        // platform: it fires on real app exit, so macOS keeps its convention
        // that closing a window is not quitting.
        .run(|app, event| {
            if matches!(event, RunEvent::ExitRequested { .. }) {
                let pid = *app.state::<BackendPid>().0.lock().unwrap();
                match pid {
                    Some(pid) => reap(pid),
                    None => println!("[shutdown] no owned backend — nothing to reap"),
                }
            }
        });
}
