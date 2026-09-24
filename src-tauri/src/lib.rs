use std::io::Write;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager, RunEvent, State};

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

// ---------------------------------------------------------------------------
// desktop.log — the app's OWN log, beside the sidecar's backend.log.
//
// Why: Katie's 2026-09-23 crash was a WebView2 renderer death inside the Alms
// app frame (Chromium's sad-face "crashed frame"), which the backend log can
// never show — from the server it looks like the client dropping and, later,
// a relaunch. Everything the shell knows (webview process failures, backend
// spawn/exit, app panels dying) lands here, and the support bundle ships it.
// ---------------------------------------------------------------------------

fn desktop_log_path() -> Option<std::path::PathBuf> {
    let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).ok()?;
    Some(
        std::path::Path::new(&home)
            .join(".local")
            .join("share")
            .join("lit-desktop")
            .join("logs")
            .join("desktop.log"),
    )
}

/// `YYYY-MM-DDTHH:MM:SSZ` from the system clock, no chrono dependency
/// (civil-from-days, Howard Hinnant's algorithm).
fn utc_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

const DESKTOP_LOG_CAP: u64 = 2 * 1024 * 1024;
const DESKTOP_LOG_KEEP: usize = 1024 * 1024;

/// Append one timestamped line; the file is trimmed to its last MiB once it
/// passes 2 MiB so it can never grow unbounded. Also echoed to stdout for
/// `tauri dev`. Never panics — a logging failure must not take the app down.
pub fn desktop_log_write(line: &str) {
    println!("[desktop-log] {line}");
    let Some(path) = desktop_log_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > DESKTOP_LOG_CAP {
            if let Ok(data) = std::fs::read(&path) {
                let tail = &data[data.len().saturating_sub(DESKTOP_LOG_KEEP)..];
                let start = tail.iter().position(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
                let _ = std::fs::write(&path, &tail[start..]);
            }
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{} {}", utc_stamp(), line);
    }
}

#[tauri::command]
fn desktop_log(line: String) {
    desktop_log_write(&line);
}

/// Tail of desktop.log for the support bundle (empty when there is none).
#[tauri::command]
fn read_desktop_log() -> String {
    let Some(path) = desktop_log_path() else { return String::new() };
    let Ok(data) = std::fs::read(&path) else { return String::new() };
    let tail = &data[data.len().saturating_sub(DESKTOP_LOG_CAP as usize)..];
    String::from_utf8_lossy(tail).into_owned()
}

/// Subscribe to WebView2's ProcessFailed event: every renderer / frame / GPU /
/// utility process death gets a desktop.log line (kind, reason, exit code,
/// process, the frames it was hosting) and a `webview-process-failed` event
/// for the frontend, which uses it to mark a dead app frame the moment it
/// dies. A dead MAIN-frame renderer leaves the whole window as a sad face
/// with no way for JS to recover, so that one case reloads the webview.
#[cfg(windows)]
fn hook_webview_process_failures(
    app: tauri::AppHandle,
    controller: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::ProcessFailedEventHandler;
    use windows::core::{Interface, BOOL, PWSTR};
    use windows::Win32::System::Com::CoTaskMemFree;

    unsafe fn take_pwstr(p: PWSTR) -> String {
        if p.is_null() {
            return String::new();
        }
        let s = p.to_string().unwrap_or_default();
        CoTaskMemFree(Some(p.0 as *const _));
        s
    }

    fn kind_name(k: COREWEBVIEW2_PROCESS_FAILED_KIND) -> &'static str {
        match k {
            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => "browser_process_exited",
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => "render_process_exited",
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => "render_process_unresponsive",
            COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED => "frame_render_process_exited",
            COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED => "utility_process_exited",
            COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED => "sandbox_helper_process_exited",
            COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED => "gpu_process_exited",
            COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_PLUGIN_PROCESS_EXITED => "ppapi_plugin_process_exited",
            COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_BROKER_PROCESS_EXITED => "ppapi_broker_process_exited",
            COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED => "unknown_process_exited",
            _ => "unknown",
        }
    }

    fn reason_name(r: COREWEBVIEW2_PROCESS_FAILED_REASON) -> &'static str {
        match r {
            COREWEBVIEW2_PROCESS_FAILED_REASON_UNEXPECTED => "unexpected",
            COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE => "unresponsive",
            COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED => "terminated",
            COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED => "crashed",
            COREWEBVIEW2_PROCESS_FAILED_REASON_LAUNCH_FAILED => "launch_failed",
            COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY => "out_of_memory",
            COREWEBVIEW2_PROCESS_FAILED_REASON_PROFILE_DELETED => "profile_deleted",
            _ => "unknown",
        }
    }

    unsafe {
        let core = match controller.CoreWebView2() {
            Ok(c) => c,
            Err(e) => {
                desktop_log_write(&format!("[webview] CoreWebView2 unavailable, process-failure hook skipped: {e}"));
                return;
            }
        };
        let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND(-1);
            let _ = args.ProcessFailedKind(&mut kind);
            let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON(-1);
            let mut exit_code = 0i32;
            let mut description = String::new();
            let mut frames: Vec<String> = Vec::new();
            if let Ok(args2) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                let _ = args2.Reason(&mut reason);
                let _ = args2.ExitCode(&mut exit_code);
                let mut p = PWSTR::null();
                if args2.ProcessDescription(&mut p).is_ok() {
                    description = take_pwstr(p);
                }
                if let Ok(coll) = args2.FrameInfosForFailedProcess() {
                    if let Ok(it) = coll.GetIterator() {
                        let mut has = BOOL(0);
                        let _ = it.HasCurrent(&mut has);
                        while has.as_bool() {
                            if let Ok(fi) = it.GetCurrent() {
                                let mut src = PWSTR::null();
                                if fi.Source(&mut src).is_ok() {
                                    frames.push(take_pwstr(src));
                                }
                            }
                            let mut next = BOOL(0);
                            if it.MoveNext(&mut next).is_err() {
                                break;
                            }
                            has = next;
                        }
                    }
                }
            }
            let kind_s = kind_name(kind);
            let reason_s = reason_name(reason);
            desktop_log_write(&format!(
                "[webview] process failed: kind={kind_s} reason={reason_s} exit_code={exit_code} process={description:?} frames={frames:?}"
            ));
            let _ = app.emit(
                "webview-process-failed",
                serde_json::json!({
                    "kind": kind_s,
                    "reason": reason_s,
                    "exit_code": exit_code,
                    "process": description,
                    "frames": frames,
                }),
            );
            if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                if let Some(core) = sender {
                    desktop_log_write("[webview] main frame renderer died — reloading the webview");
                    let _ = core.Reload();
                }
            }
            Ok(())
        }));
        let mut token = 0i64;
        match core.add_ProcessFailed(&handler, &mut token) {
            Ok(()) => desktop_log_write("[webview] process-failure hook armed"),
            Err(e) => desktop_log_write(&format!("[webview] process-failure hook failed: {e}")),
        }
    }
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
            reap_backend_on_port,
            desktop_log,
            read_desktop_log
        ])
        .setup(|app| {
            desktop_log_write(&format!(
                "[app] launched v{} ({} {})",
                app.package_info().version,
                std::env::consts::OS,
                std::env::consts::ARCH
            ));
            #[cfg(windows)]
            if let Some(win) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                let _ = win.with_webview(move |pw| hook_webview_process_failures(handle, pw.controller()));
            }
            Ok(())
        })
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
                desktop_log_write("[app] exit requested");
                let pid = *app.state::<BackendPid>().0.lock().unwrap();
                match pid {
                    Some(pid) => reap(pid),
                    None => println!("[shutdown] no owned backend — nothing to reap"),
                }
            }
        });
}
