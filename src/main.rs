use std::{env, time::Duration};

use anyhow::Result;
use mailparse::{MailHeaderMap, parse_mail};
use native_tls::TlsConnector;
use serde::{Deserialize, Serialize};
use tokio::time::sleep;

struct Config {
    imap_host: String,
    imap_port: u16,
    imap_domain: String,
    imap_username: String,
    imap_password: String,
    discord_webhook_url: String,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct WebhookBody {
    username: Option<String>,
    avatar_url: Option<String>,
    content: Option<String>,
    embeds: Option<Vec<Embed>>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Embed {
    title: String,
    url: String,
    description: String,
    author: Option<EmbedAuthor>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct EmbedAuthor {
    name: String,
    url: Option<String>,
    icon_url: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let config = Config {
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
    let tls_connector = TlsConnector::builder().build()?;

    let client = imap::connect(
        (config.imap_host, config.imap_port),
        config.imap_domain,
        &tls_connector,
    )?;

    // the client we have here is unauthenticated.
    // to do anything useful with the e-mails, we need to log in
    let mut imap_session = client
        .login(config.imap_username, config.imap_password)
        .map_err(|e| e.0)?;

    // we want to fetch the first email in the INBOX mailbox
    imap_session.select("INBOX")?;

    // fetch message number 1 in this mailbox, along with its RFC822 field.
    // RFC 822 dictates the format of the body of e-mails
    let messages = imap_session.fetch("1", "RFC822")?;
    let message = if let Some(m) = messages.iter().next() {
        m
    } else {
        println!("INBOX にメールが見つかりませんでした。");
        return Ok(());
    };

    // extract the message's body
    let body = message.body().expect("message did not have a body!");
    let body = std::str::from_utf8(body)
        .expect("message was not valid utf-8")
        .to_string();

    let parsed = parse_mail(body.as_bytes())?;
    let plain_body = if parsed.subparts.is_empty() {
        if parsed.ctype.mimetype != "text/plain" {
            None
        } else {
            parsed.get_body().ok()
        }
    } else {
        parsed
            .subparts
            .iter()
            .find(|x| x.ctype.mimetype == "text/plain")
            .and_then(|x| x.get_body().ok())
    };

    println!(
        "メールの内容:\n{}",
        plain_body.as_deref().unwrap_or("本文なし")
    );

    let from = parsed
        .get_headers()
        .get_first_value("From")
        .unwrap_or_else(|| "不明な送信者".to_string());

    let subject = parsed
        .get_headers()
        .get_first_value("Subject")
        .unwrap_or_else(|| "無題".to_string());

    let req_body = WebhookBody {
        username: Some(from.to_string()),
        avatar_url: None,
        content: None,
        embeds: Some(vec![Embed {
            title: subject,
            url: "https://www.stb.tsukuba.ac.jp/webmail".to_string(),
            author: Some(EmbedAuthor {
                name: from,
                url: None,
                icon_url: None,
            }),
            description: plain_body.unwrap_or_else(|| "本文なし".to_string()),
        }]),
    };

    let client = reqwest::Client::new();
    let res = client
        .post(config.discord_webhook_url)
        .json(&req_body)
        .send()
        .await?;

    if !res.status().is_success() {
        eprintln!("Failed to send webhook: {:?}", res.text().await?);
    }

    // be nice to the server and log out
    imap_session.logout()?;

    Ok(())
}
