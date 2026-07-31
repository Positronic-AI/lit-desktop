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
        .invoke_handler(tauri::generate_handler![register_backend_pid])
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
