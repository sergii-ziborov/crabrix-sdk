fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--help") => println!(
            "🦀 Crabrix · {}\nRust SDK + MCP launcher. Node.js 22+ required; no npm installation.\nRun without arguments for MCP stdio.\nhttps://crabrix.com/playground/mcp/",
            env!("CARGO_PKG_VERSION")
        ),
        Some("--version") => println!("{}", env!("CARGO_PKG_VERSION")),
        None => match crabrix::serve_mcp() {
            Ok(code) => std::process::exit(code),
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1)
            }
        },
        _ => {
            eprintln!("Use --help or start without arguments.");
            std::process::exit(2)
        }
    }
}
