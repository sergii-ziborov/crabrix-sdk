//! Send an authorized edit link on stdin. No capability is logged or put in argv.
use crabrix::{ApplyOptions, Change, Client};
use std::io::{self, BufRead, Write};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut lines = io::stdin().lock().lines();
    let link = lines.next().ok_or("expected room link on stdin")??;
    let mut client = Client::new()?;
    client.connect(&link)?;
    let file = client.read("main.rs")?;
    client.apply(&ApplyOptions {
        expected_revision: file.revision,
        changes: vec![Change {
            path: file.path,
            text: Some(file.text + "// reviewed by Rust\n"),
        }],
        entry_file: None,
        name: None,
    })?;
    let file = client.read("main.rs")?;
    client.select(&file.path, 0, 9, &file.revision)?;
    println!(
        "{}",
        serde_json::json!({"ready":true,"revision":file.revision})
    );
    io::stdout().flush()?;
    let _ = lines.next();
    client.disconnect()?;
    Ok(())
}
