fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [flag] if flag == "--help" => println!(
            "🦀 Crabrix · {}\nRust SDK + MCP launcher. Node.js 22+ required; no npm installation.\nRun without arguments for MCP stdio. `crabrix doctor [--json]` checks this environment.\nhttps://crabrix.com/ai/",
            env!("CARGO_PKG_VERSION")
        ),
        [flag] if flag == "--version" => println!("{}", env!("CARGO_PKG_VERSION")),
        [command] if command == "doctor" => exit_with(crabrix::doctor(false)),
        [command, flag] if command == "doctor" && flag == "--json" => {
            exit_with(crabrix::doctor(true))
        }
        [] => match crabrix::serve_mcp() {
            Ok(code) => std::process::exit(code),
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1)
            }
        },
        _ => {
            eprintln!("Use --help, doctor or start without arguments.");
            std::process::exit(2)
        }
    }
}
fn exit_with(result: crabrix::Result<i32>) {
    match result {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1)
        }
    }
}
