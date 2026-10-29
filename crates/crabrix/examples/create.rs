use crabrix::{ApplyOptions, Change, Client, CreateOptions};

fn main() -> Result<(), crabrix::Error> {
    let mut client = Client::new()?;
    let options = CreateOptions::new("Rust review exercise");
    client.create(&options)?;

    let file = client.read("main.rs")?;
    client.apply(&ApplyOptions {
        expected_revision: file.revision,
        changes: vec![Change {
            path: file.path,
            text: Some("fn main() { println!(\"Hello, Crabrix!\"); }\n".into()),
        }],
        entry_file: None,
        name: None,
    })?;

    let latest = client.read("main.rs")?;
    client.select(&latest.path, 0, 2, &latest.revision)?;
    let handoff = client.share("edit")?;
    // Secret: deliver handoff.link only to the intended recipient.
    // Your integration should also display handoff.expires_at.
    let _ = handoff;
    Ok(()) // Drop leaves the room; its fixed expiry remains.
}
