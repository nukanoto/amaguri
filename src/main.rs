use amaguri::app::*;

use std::env;

use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    let config = amaguri::app::Config {
        imap_host: env::var("IMAP_HOST").expect("IMAP_HOST must be set"),
        imap_port: env::var("IMAP_PORT")
            .unwrap_or_default()
            .parse::<u16>()
            .unwrap_or(993),
        imap_domain: env::var("IMAP_DOMAIN").expect("IMAP_DOMAIN must be set"),
        imap_username: env::var("IMAP_USERNAME").expect("IMAP_USERNAME must be set"),
        imap_password: env::var("IMAP_PASSWORD").expect("IMAP_PASSWORD must be set"),
        discord_webhook_url: env::var("DISCORD_WEBHOOK_URL")
            .expect("DISCORD_WEBHOOK_URL must be set"),
    };

    println!("Configuration: {:?}", config);

    let app = App::new(config);
    app.run().await?;

    Ok(())
}
