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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
